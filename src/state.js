// Per-turn grounding state, isolated by run.
//
// OpenClaw gives every agent-runtime hook a `runId`. The outbound delivery
// hooks (`message_sending`, `reply_payload_sending`) currently do not carry a
// run id, so those hooks fall back to the session key. The fallback is bounded
// and last-write-wins per session, which is exactly the documented limitation:
// it cannot disambiguate two concurrent turns in the same session. Run-keyed
// state is never overwritten by the session fallback.

import { SATISFYING_TOOLS } from "./classify.js";
import { createTurnIndex } from "./turn-identity.js";

/** Content words of a turn, for the relevance check below. */
const RELEVANCE_STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "could", "did",
  "do", "does", "for", "from", "get", "give", "had", "has", "have", "how", "i",
  "if", "in", "is", "it", "its", "just", "me", "my", "no", "not", "of", "on",
  "or", "our", "out", "please", "should", "so", "some", "tell", "that",
  "the", "their", "them", "then", "there", "they", "this", "to", "up", "us",
  "was", "we", "were", "what", "when", "where", "which", "who", "why", "will",
  "with", "would", "you", "your", "yours",
]);

function contentWords(text) {
  return new Set(
    String(text ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !RELEVANCE_STOPWORDS.has(w)),
  );
}

/**
 * True when a search query is plainly about something other than the question.
 *
 * The contract verified that a tool ran, never that it ran on the right
 * subject. Observed failure: a turn asking the agent to change its own humor
 * setting produced a web_search about the horsepower figures discussed several
 * turns earlier, and the answer was accepted as grounded because a search had
 * happened.
 *
 * Deliberately conservative — it rejects only when there is NO overlap at all
 * and both sides have enough words to judge. Paraphrase, synonyms and narrowed
 * queries all still pass; the target is the wholly unrelated search, which is
 * the only case observed and the only one worth failing a turn over.
 */
export function queryIsUnrelated(userMessage, params) {
  const asked = contentWords(userMessage);
  if (asked.size < 2) return false;

  const queryText = [params?.query, params?.q, params?.search, params?.text]
    .filter((v) => typeof v === "string")
    .join(" ");
  const searched = contentWords(queryText);
  if (searched.size < 2) return false;

  for (const word of searched) if (asked.has(word)) return false;
  return true;
}


const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 200;

/**
 * @typedef {object} GroundingEntry
 * @property {"web"|"memory"|null} kind
 * @property {boolean} correction
 * @property {string} reason
 * @property {number} toolCalls
 * @property {number} toolFailures
 * @property {string[]} satisfiedBy
 * @property {boolean} verified
 * @property {number} revisions
 * @property {boolean} failClosed
 * @property {Record<string, number>} failClosedEmitted
 * @property {string|undefined} sessionKey
 * @property {string|undefined} runId
 * @property {string|undefined} sessionId
 * @property {string} turnId internal id; not derived from any host field
 * @property {string|null} turnNonce
 * @property {string} userMessage exact operator text for this turn
 * @property {string} prevAssistant the assistant message this turn may correct
 * @property {Array<{tool: string, query: string, excerpt: string}>} wikiEvidence
 * @property {boolean} factEligible
 * @property {"create"|"correct"|null} factKind
 * @property {string} factReason
 * @property {boolean} factUnambiguous
 * @property {boolean} factTransactionAllowed whether this specific direct turn exposed the transaction tool
 * @property {number} factCalls
 * @property {number} caseAudits
 * @property {number} factRevisions
 * @property {object|null} factOutcome
 * @property {boolean} factFailClosed
 * @property {import("./traffic.js").TrafficVerdict & {resolvedAt: string, identity: object}|null} traffic
 * @property {boolean} trafficIdentityMismatch
 * @property {number} evidenceCaptureLostCount eligible excerpts dropped, not merely ineligible
 * @property {Record<string, number>} evidenceCaptureSkipReasons every reason, with counts
 * @property {{features: object, startedAt: number|null, drafts: string[],
 *             tools: object[], policy: object|null, blockedTools: object[]}} telemetry
 * @property {number} createdAt
 * @property {number} updatedAt
 */

/** Bound on the per-run wiki evidence retained for the audit packet. */
const DEFAULT_MAX_EVIDENCE_ITEMS = 4;
const DEFAULT_MAX_EVIDENCE_CHARS = 1200;
/** Bound on outstanding tool-call bindings. */
const MAX_PENDING_CALLS = 200;

/**
 * In-memory, process-local store of per-turn obligations.
 *
 * @param {{ttlMs?: number, maxEntries?: number, now?: () => number}} [opts]
 *   `now` is injectable so tests can advance time without sleeping.
 */
export function createGroundingStore(opts = {}) {
  const ttlMs = Number.isFinite(opts.ttlMs) && opts.ttlMs > 0 ? opts.ttlMs : DEFAULT_TTL_MS;
  const maxEntries =
    Number.isFinite(opts.maxEntries) && opts.maxEntries > 0 ? opts.maxEntries : DEFAULT_MAX_ENTRIES;
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();

  /**
   * Turn id -> entry.
   *
   * Keyed by the internal id minted in `turn-identity.js`, never by anything
   * the host supplied. Every hook reaches the same entry through the alias
   * index, whatever subset of `runId` / `sessionKey` / `sessionId` it happens
   * to have been given.
   *
   * @type {Map<string, GroundingEntry>}
   */
  const entries = new Map();
  const turns = createTurnIndex(opts.turnIndex);
  /**
   * Tool call id -> the run that issued it.
   *
   * A tool's execute context carries `sessionKey` and `sessionId` but no run
   * id, so a fact transaction could otherwise only be bound to a session — and
   * a session's "current turn" is last-write-wins across concurrent runs.
   * `before_tool_call` is the one hook that sees the tool call id *and* the run
   * id, so it stamps the binding here and `execute` resolves it. That makes the
   * evidence binding exact rather than merely probable.
   */
  const pendingCalls = new Map();

  /** Drop an entry and the aliases that named it, so neither outlives the other. */
  function evict(key) {
    entries.delete(key);
    turns.forget(key);
  }

  function expire() {
    const cutoff = now() - ttlMs;
    for (const [key, entry] of entries) {
      if (entry.updatedAt < cutoff) evict(key);
    }
    // Map iteration order is insertion order, so the oldest key is first.
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      evict(oldest.value);
    }
  }

  /**
   * Resolve a hook's partial host metadata to the turn it names.
   *
   * The precedence and the refusal to fall back from an unknown run id both
   * live in `turn-identity.js` now; this is the store's one call into it, so
   * there is no second derivation to drift.
   */
  function keyFor({ runId, sessionKey, sessionId }) {
    return turns.resolve({ runId, sessionKey, sessionId });
  }

  return {
    /** Start (or restart) tracking for one turn. */
    begin({ runId, sessionKey, sessionId, kind, correction, correctionScope, reason, turnNonce, userMessage, prevAssistant, fact, factTransactionAllowed, traffic }) {
      if (!runId && !sessionKey && !sessionId) return null;
      // Mint (or recover) this turn's id and index every alias the host gave
      // us, so a later hook holding only one of them finds this same entry.
      const key = turns.register({ runId, sessionKey, sessionId });
      const ts = now();
      /** @type {GroundingEntry} */
      const entry = {
        kind: kind ?? null,
        correction: Boolean(correction),
        reason: reason ?? "",
        toolCalls: 0,
        toolFailures: 0,
        satisfiedBy: [],
        verified: kind == null,
        revisions: 0,
        // Counted apart from grounding revisions: a voice retry must never
        // consume the budget the correctness gate depends on.
        voiceRevisions: 0,
        failClosed: false,
        failClosedEmitted: {},
        sessionKey,
        runId,
        sessionId,
        // The turn's own name for itself. Hooks resolve to it; nothing
        // reconstructs it.
        turnId: key,
        turnNonce: turnNonce ?? null,
        userMessage: typeof userMessage === "string" ? userMessage : "",
        prevAssistant: typeof prevAssistant === "string" ? prevAssistant : "",
        wikiEvidence: [],
        factEligible: Boolean(fact?.eligible),
        factKind: fact?.kind ?? null,
        factReason: fact?.reason ?? "",
        factUnambiguous: Boolean(fact?.unambiguous),
        factTransactionAllowed: Boolean(factTransactionAllowed),
        factCalls: 0,
        caseAudits: 0,
        factRevisions: 0,
        factOutcome: null,
        factFailClosed: false,
        // Scope of a correction, needed by resolveOutcomes to tell an
        // ambiguous correction (ask) from a user-owned one (accept and write).
        correctionScope: correctionScope ?? null,
        // Who or what produced this turn, together with the host identity that
        // answer was read from. Decided once at before_prompt_build, which is
        // the only hook that sees full identity, and stored frozen so the
        // tool-result middleware and terminal telemetry read one answer instead
        // of each deriving their own from whatever their seam happens to carry.
        traffic: traffic ?? null,
        // Set when a later hook presents host identity that contradicts the
        // recorded one. Diagnostic only: the first decision stays binding.
        trafficIdentityMismatch: false,
        // The validated proposal, captured before the commit is attempted so a
        // truthful reply can be rebuilt from it if the draft goes wrong.
        factProposal: null,
        // Repairs spent on a draft that falsely claimed the write succeeded.
        // Its own budget: a turn that already spent maxFactRevisions retrying
        // the commit would otherwise have nothing left to fix a contradiction,
        // and would ship it.
        persistenceClaimRevisions: 0,
        // The single resolved terminal decision. Lanes render this; they never
        // recompute it, which is what keeps them from diverging.
        delivery: null,
        // Once-latch for terminal telemetry, so several delivery lanes on one
        // turn produce exactly one record.
        terminalRecorded: null,
        // What each terminal lane actually saw. Every lane appends here,
        // including on the pass path where the plugin changes nothing —
        // otherwise "was this text observed leaving" is unanswerable for
        // ordinary turns, which are almost all of them.
        deliveryObservations: [],
        // Evidence capture is shadow bookkeeping. Ids and counts only: an
        // excerpt in the turn state would end up in telemetry, which is the one
        // place it must not be.
        evidenceIds: [],
        evidenceCaptureAttempted: false,
        evidenceCapturedCount: 0,
        // Never eligible: a tool with no adapter, a result with no text.
        evidenceCaptureSkippedCount: 0,
        // Eligible and dropped anyway: a budget spent, a capture timed out.
        // Counted apart from skips because only this makes a turn `partial`.
        evidenceCaptureLostCount: 0,
        evidenceCaptureFailedCount: 0,
        // The first reason, kept for the diagnostics that read it directly.
        // What reaches a turn record is derived from the counts below.
        evidenceCaptureSkipReason: null,
        // Every reason and how often, so a turn that captured some evidence and
        // skipped an unrelated tool call can say both.
        evidenceCaptureSkipReasons: {},
        // Whether the plugin could resolve its own configuration at all.
        // Distinct from "the feature is off": one is a fault, the other is a
        // choice, and reporting them the same way hides the fault.
        runtimeConfigResolved: true,
        overlayConfigResolved: true,
        overlayApplied: false,
        overlaySkipReason: null,
        // What the turn record will be built from.
        //
        // These lived in five Maps beside the store, keyed `runId ?? sessionKey`
        // while the entry was keyed `run:<id>` or `session:<key>`. Two
        // derivations of one turn's identity, so a hook that had only a session
        // key wrote where the reader was not looking. Same defect as the
        // duplicated traffic classification, one layer down.
        telemetry: {
          features: {},
          // Wall-clock, deliberately not the injectable `now`: this measures
          // real latency, and tests that freeze time must not make it zero.
          startedAt: null,
          drafts: [],
          tools: [],
          policy: null,
          blockedTools: [],
        },
        createdAt: ts,
        updatedAt: ts,
      };
      entries.delete(key);
      entries.set(key, entry);
      // Expire after insertion so the new turn is never the entry that gets
      // evicted to satisfy the bound.
      expire();
      return entry;
    },

    /**
     * Record the matched classifier features, and start the latency clock.
     *
     * Read-only signals: they never influence a decision, they explain one.
     */
    noteTelemetryFeatures(ref, features, startedAt) {
      const entry = this.get(ref);
      if (!entry) return null;
      entry.telemetry.features = features ?? {};
      entry.telemetry.startedAt = startedAt ?? null;
      entry.updatedAt = now();
      return entry;
    },

    /** Record which policy governed this turn, and what the legacy verdict said. */
    noteTelemetryPolicy(ref, policy) {
      const entry = this.get(ref);
      if (!entry) return null;
      entry.telemetry.policy = policy ?? null;
      entry.updatedAt = now();
      return entry;
    },

    /** Append one draft pass. Identical consecutive text is one pass, not two. */
    noteTelemetryDraft(ref, text) {
      const entry = this.get(ref);
      if (!entry) return null;
      if (typeof text !== "string" || !text.trim()) return entry;
      const drafts = entry.telemetry.drafts;
      // finalize can fire more than once with the same text.
      if (drafts[drafts.length - 1] !== text) drafts.push(text);
      entry.updatedAt = now();
      return entry;
    },

    /** Append one tool call, with its parameters already sanitized by the caller. */
    noteTelemetryTool(ref, call) {
      const entry = this.get(ref);
      if (!entry) return null;
      entry.telemetry.tools.push(call);
      entry.updatedAt = now();
      return entry;
    },

    /** Append one refused tool call. A count of zero is the success criterion. */
    noteTelemetryBlocked(ref, blocked) {
      const entry = this.get(ref);
      if (!entry) return null;
      entry.telemetry.blockedTools.push(blocked);
      entry.updatedAt = now();
      return entry;
    },

    /** Count one voice revision for this turn. */
    noteVoiceRevision(ref) {
      const key = keyFor(ref);
      const entry = key ? entries.get(key) : null;
      if (!entry) return null;
      entry.voiceRevisions += 1;
      entry.updatedAt = now();
      return entry;
    },

    /** Record one completed tool call. */
    recordTool(ref) {
      const { toolName, ok, params } = ref;
      const key = keyFor(ref);
      if (!key) return null;
      const entry = entries.get(key);
      if (!entry) return null;
      entry.toolCalls += 1;
      if (!ok) entry.toolFailures += 1;
      entry.updatedAt = now();
      if (ok && entry.kind && SATISFYING_TOOLS[entry.kind]?.includes(toolName)) {
        // The right tool on the wrong subject is not grounding. Left
        // unverified, the contract requests its bounded revision, which now
        // restates the question rather than leaving the model to guess.
        if (queryIsUnrelated(entry.userMessage, params)) {
          entry.offTopicTools = (entry.offTopicTools ?? 0) + 1;
        } else {
          if (!entry.satisfiedBy.includes(toolName)) entry.satisfiedBy.push(toolName);
          entry.verified = true;
        }
      }
      return entry;
    },

    /**
     * Retain a bounded excerpt of one successful wiki retrieval.
     *
     * This is the only vault evidence the CASE audit will ever see, and it is
     * captured from the run's own tool results rather than accepted from the
     * model — a quotation the model composes is not evidence of anything.
     */
    recordEvidence(ref) {
      const { toolName, params, result, maxItems, maxChars } = ref;
      const key = keyFor(ref);
      if (!key) return null;
      const entry = entries.get(key);
      if (!entry) return null;
      const limitItems = Number.isInteger(maxItems) && maxItems > 0 ? maxItems : DEFAULT_MAX_EVIDENCE_ITEMS;
      const limitChars = Number.isInteger(maxChars) && maxChars > 0 ? maxChars : DEFAULT_MAX_EVIDENCE_CHARS;
      if (entry.wikiEvidence.length >= limitItems) return entry;
      const excerpt = excerptFromToolResult(result, limitChars);
      if (!excerpt) return entry;
      entry.wikiEvidence.push({
        tool: String(toolName ?? ""),
        query: typeof params?.query === "string" ? params.query.slice(0, 200) : "",
        excerpt,
      });
      entry.updatedAt = now();
      return entry;
    },

    /** Bind a tool call id to the run that issued it. */
    bindToolCall({ toolCallId, runId, sessionKey, sessionId }) {
      if (!toolCallId) return null;
      const key = keyFor({ runId, sessionKey, sessionId });
      if (!key) return null;
      pendingCalls.delete(toolCallId);
      pendingCalls.set(toolCallId, { key, at: now() });
      while (pendingCalls.size > MAX_PENDING_CALLS) {
        const oldest = pendingCalls.keys().next();
        if (oldest.done) break;
        pendingCalls.delete(oldest.value);
      }
      return key;
    },

    /**
     * Whether this tool call was ever bound, regardless of whether its turn
     * still exists.
     *
     * `resolveToolCall` answers null for both "never bound" and "bound to a
     * turn that has since gone", which made the second indistinguishable from
     * the first — a timing fault reported as a wiring fault, and the
     * `no-turn-state` branch that existed to say so was unreachable.
     */
    hasToolCallBinding(toolCallId) {
      return Boolean(toolCallId) && pendingCalls.has(toolCallId);
    },

    /**
     * Resolve a bound tool call to its turn key. Single-use: the binding is
     * consumed, so a replayed tool call id cannot reach a live turn twice.
     */
    resolveToolCall(toolCallId) {
      if (!toolCallId) return null;
      const hit = pendingCalls.get(toolCallId);
      if (!hit) return null;
      pendingCalls.delete(toolCallId);
      const entry = entries.get(hit.key);
      if (!entry) return null;
      return {
        runId: entry.runId,
        sessionKey: entry.sessionKey,
        sessionId: entry.sessionId,
        turnId: entry.turnId,
      };
    },

    /**
     * Look up a bound tool call without consuming the binding.
     *
     * `resolveToolCall` is single-use so a replayed id cannot reach a live turn
     * twice, which is right for the fact transaction. Evidence capture needs
     * the same turn identity but must not spend the binding the fact path
     * depends on, so it peeks.
     */
    peekToolCall(toolCallId) {
      if (!toolCallId) return null;
      const hit = pendingCalls.get(toolCallId);
      if (!hit) return null;
      const entry = entries.get(hit.key);
      if (!entry) return null;
      return {
        runId: entry.runId,
        sessionKey: entry.sessionKey,
        sessionId: entry.sessionId,
        turnId: entry.turnId,
      };
    },

    /** Count one evidence-backed fact transaction attempt for this turn. */
    noteFactCall(ref) {
      const entry = this.get(ref);
      if (!entry) return null;
      entry.factCalls += 1;
      entry.updatedAt = now();
      return entry;
    },

    /** Count one CASE audit for this turn. */
    noteCaseAudit(ref) {
      const entry = this.get(ref);
      if (!entry) return null;
      entry.caseAudits += 1;
      entry.updatedAt = now();
      return entry;
    },

    /** Count one bounded fact-capture revision request. */
    noteFactRevision(ref) {
      const entry = this.get(ref);
      if (!entry) return null;
      entry.factRevisions += 1;
      entry.updatedAt = now();
      return entry;
    },

    /**
     * Latch the fact fail-closed decision.
     *
     * Separate from `failClosed`, which belongs to the grounding gate: the two
     * have different causes and different replacement text, and a turn can hit
     * one without the other.
     */
    markFactFailClosed(ref) {
      const entry = this.get(ref);
      if (!entry) return null;
      entry.factFailClosed = true;
      entry.updatedAt = now();
      return entry;
    },

    /** Capture the validated proposal a commit is about to be attempted with. */
    setFactProposal(ref, proposal) {
      const entry = this.get(ref);
      if (!entry) return null;
      entry.factProposal = proposal ?? null;
      entry.updatedAt = now();
      return entry;
    },

    /** Spend one repair on a draft that falsely claimed durable persistence. */
    notePersistenceClaimRevision(ref) {
      const entry = this.get(ref);
      if (!entry) return null;
      entry.persistenceClaimRevisions += 1;
      entry.updatedAt = now();
      return entry;
    },

    /**
     * Record what a terminal lane saw.
     *
     * Called before any early return, so a pass-through turn is observed too.
     * `external` distinguishes a lane that sends outward from the transcript
     * write, which is the only lane `deliver:false` reaches.
     */
    /**
     * Record the outcome of capturing one tool call's evidence.
     *
     * Never throws and never rejects a turn: capture is best-effort by design,
     * and a bookkeeping failure must not be able to change what the operator
     * receives.
     */
    /**
     * Record that the plugin could not resolve its configuration.
     *
     * Never alters the turn. It marks the record so a corpus reader can tell a
     * degraded build from one that legitimately had nothing to capture.
     */
    noteRuntimeConfigUnresolved(ref, reason) {
      const entry = this.get(ref);
      if (!entry) return null;
      entry.runtimeConfigResolved = false;
      entry.overlayConfigResolved = false;
      // The category the corpus is queried by, and the specific cause. One
      // without the other is either unusable or unactionable.
      entry.evidenceCaptureSkipReason = "config_unresolved";
      entry.overlaySkipReason = "config_unresolved";
      entry.runtimeConfigReason = reason ?? "unknown";
      entry.updatedAt = now();
      return entry;
    },

    /** Note that the fact overlay actually rewrote a retrieval. */
    noteOverlayApplied(ref) {
      const entry = this.get(ref);
      if (!entry) return null;
      entry.overlayApplied = true;
      entry.updatedAt = now();
      return entry;
    },

    /**
     * Note that the host later presented a different identity for this turn.
     *
     * Does not touch `traffic`. The recorded class remains what it was — the
     * point of storing it is that it stops moving.
     */
    noteTrafficIdentityMismatch(ref) {
      const entry = this.get(ref);
      if (!entry) return null;
      entry.trafficIdentityMismatch = true;
      entry.updatedAt = now();
      return entry;
    },

    /** Record why evidence capture did not run for this tool call. */
    noteEvidenceSkip(ref, reason) {
      const entry = this.get(ref);
      if (!entry) return null;
      // First reason wins: the earliest gate is the actionable one.
      entry.evidenceCaptureSkipReason ??= reason;
      entry.evidenceCaptureSkipReasons[reason] = (entry.evidenceCaptureSkipReasons[reason] ?? 0) + 1;
      entry.updatedAt = now();
      return entry;
    },

    noteEvidenceCapture(ref, outcome) {
      const entry = this.get(ref);
      if (!entry || !outcome) return null;
      entry.evidenceCaptureAttempted = true;
      for (const id of outcome.evidenceIds ?? []) entry.evidenceIds.push(id);
      entry.evidenceCapturedCount += outcome.captured ?? 0;
      entry.evidenceCaptureSkippedCount += outcome.skipped ?? 0;
      entry.evidenceCaptureLostCount += outcome.lost ?? 0;
      entry.evidenceCaptureFailedCount += outcome.failed ?? 0;
      for (const [reason, count] of Object.entries(outcome.reasonCounts ?? {})) {
        entry.evidenceCaptureSkipReasons[reason] = (entry.evidenceCaptureSkipReasons[reason] ?? 0) + count;
      }
      entry.updatedAt = now();
      return entry;
    },

    observeLane(ref, { lane, text, external = false }) {
      const entry = this.get(ref);
      if (!entry || !lane) return null;
      const existing = entry.deliveryObservations.find((o) => o.lane === lane);
      if (existing) {
        // A lane firing twice (multi-chunk payloads) keeps its first text.
        existing.repeats = (existing.repeats ?? 0) + 1;
        return existing;
      }
      const observation = { lane, text: String(text ?? ""), external: Boolean(external), repeats: 0 };
      entry.deliveryObservations.push(observation);
      entry.updatedAt = now();
      return observation;
    },

    /** Correct a lane's observation once the plugin has substituted its text. */
    updateObservedText(ref, lane, text) {
      const entry = this.get(ref);
      if (!entry) return null;
      const observation = entry.deliveryObservations.find((o) => o.lane === lane);
      if (!observation) return null;
      observation.text = String(text ?? "");
      entry.updatedAt = now();
      return observation;
    },

    /** Stash the resolved terminal decision for the delivery lanes to render. */
    setDelivery(ref, decision) {
      const entry = this.get(ref);
      if (!entry) return null;
      entry.delivery = decision ?? null;
      entry.updatedAt = now();
      return entry;
    },

    /**
     * Claim the right to write this turn's terminal telemetry record.
     *
     * Returns true exactly once per turn, for the first lane that asks. Delivery
     * happens after finalize, so the first lane to fire is the only place that
     * can honestly report what shipped.
     */
    claimTerminalRecord(ref, lane) {
      const entry = this.get(ref);
      if (!entry) return false;
      if (entry.terminalRecorded) return false;
      entry.terminalRecorded = { lane: lane ?? null, at: now() };
      entry.updatedAt = now();
      return true;
    },

    /** Record the terminal outcome of this turn's fact transaction. */
    setFactOutcome(ref, outcome) {
      const entry = this.get(ref);
      if (!entry) return null;
      entry.factOutcome = outcome ?? null;
      entry.updatedAt = now();
      return entry;
    },

    get({ runId, sessionKey, sessionId }) {
      const key = keyFor({ runId, sessionKey, sessionId });
      if (!key) return null;
      return entries.get(key) ?? null;
    },

    /** Count one bounded revision request. */
    noteRevision(ref) {
      const entry = this.get(ref);
      if (!entry) return null;
      entry.revisions += 1;
      entry.updatedAt = now();
      return entry;
    },

    /** Latch the fail-closed decision so delivery hooks agree with finalize. */
    markFailClosed(ref) {
      const entry = this.get(ref);
      if (!entry) return null;
      entry.failClosed = true;
      entry.updatedAt = now();
      return entry;
    },

    /**
     * Count one fail-closed substitution for a delivery lane and report how
     * many have happened there before. A turn can produce several payloads;
     * the replacement line belongs on the first one only, and the rest are
     * cancelled rather than repeated. Lanes are counted separately because
     * `reply_payload_sending` and `message_sending` can both fire for one
     * delivery, and cancelling the second lane would drop the reply entirely.
     */
    noteFailClosedEmission(ref) {
      const { lane } = ref;
      const entry = this.get(ref);
      if (!entry) return 0;
      const seen = entry.failClosedEmitted[lane] ?? 0;
      entry.failClosedEmitted[lane] = seen + 1;
      entry.updatedAt = now();
      return seen;
    },

    /** Drop a turn's state once it can no longer be needed. */
    release({ runId, sessionKey, sessionId }) {
      const key = keyFor({ runId, sessionKey, sessionId });
      if (!key) return;
      // The aliases go with it. Leaving them behind would let a later hook
      // resolve to a turn that no longer exists, which reads as "this turn was
      // never tracked" — the same ambiguity everywhere else in here is being
      // removed.
      evict(key);
    },

    expire,
    get size() {
      return entries.size;
    },
  };
}

/**
 * Flatten an OpenClaw tool result into one bounded text excerpt.
 *
 * Tool results are `{content: [{type: "text", text}], details}`; some tools
 * return a bare string or a JSON-ish object. Anything unreadable yields "" and
 * is simply not treated as evidence.
 */
export function excerptFromToolResult(result, maxChars) {
  const limit = Number.isInteger(maxChars) && maxChars > 0 ? maxChars : DEFAULT_MAX_EVIDENCE_CHARS;
  let text = "";
  if (typeof result === "string") {
    text = result;
  } else if (result && typeof result === "object") {
    const parts = Array.isArray(result.content) ? result.content : [];
    text = parts
      .filter((p) => p && typeof p === "object" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n");
    if (!text && result.details !== undefined) {
      try {
        text = JSON.stringify(result.details);
      } catch {
        text = "";
      }
    }
  }
  text = String(text ?? "").trim();
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * Whether the turn may release its draft.
 * Missing evidence never releases the draft.
 *
 * @param {{kind: string|null, verified?: boolean, failClosed?: boolean}|null} entry
 * @returns {boolean}
 */
export function isReleasable(entry) {
  if (!entry) return false;
  if (entry.failClosed) return false;
  if (entry.kind == null) return true;
  return entry.verified === true;
}
