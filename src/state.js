// Per-turn grounding state, isolated by run.
//
// OpenClaw gives every agent-runtime hook a `runId`. The outbound delivery
// hooks (`message_sending`, `reply_payload_sending`) currently do not carry a
// run id, so those hooks fall back to the session key. The fallback is bounded
// and last-write-wins per session, which is exactly the documented limitation:
// it cannot disambiguate two concurrent turns in the same session. Run-keyed
// state is never overwritten by the session fallback.

import { SATISFYING_TOOLS } from "./classify.js";

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
 * @property {number} createdAt
 * @property {number} updatedAt
 */

/** Bound on the per-run wiki evidence retained for the audit packet. */
const DEFAULT_MAX_EVIDENCE_ITEMS = 4;
const DEFAULT_MAX_EVIDENCE_CHARS = 1200;
/** Bound on outstanding tool-call bindings. */
const MAX_PENDING_CALLS = 200;

export function createGroundingStore(opts = {}) {
  const ttlMs = Number.isFinite(opts.ttlMs) && opts.ttlMs > 0 ? opts.ttlMs : DEFAULT_TTL_MS;
  const maxEntries =
    Number.isFinite(opts.maxEntries) && opts.maxEntries > 0 ? opts.maxEntries : DEFAULT_MAX_ENTRIES;
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();

  /** @type {Map<string, GroundingEntry>} */
  const entries = new Map();
  /** Session key -> most recent run key, for hooks that have no run id. */
  const sessionIndex = new Map();
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

  function runKey(runId) {
    return `run:${runId}`;
  }
  function sessionSlot(sessionKey) {
    return `session:${sessionKey}`;
  }

  function expire() {
    const cutoff = now() - ttlMs;
    for (const [key, entry] of entries) {
      if (entry.updatedAt < cutoff) entries.delete(key);
    }
    for (const [sessionKey, key] of sessionIndex) {
      if (!entries.has(key)) sessionIndex.delete(sessionKey);
    }
    // Map iteration order is insertion order, so the oldest key is first.
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
  }

  /**
   * Resolve the key for a hook invocation. Prefers the run id; falls back to
   * the session slot only when OpenClaw omitted the run id.
   */
  function keyFor({ runId, sessionKey }) {
    // A supplied run id is authoritative: resolve that run and nothing else.
    // An earlier version fell back to the session when the run id was unknown,
    // which could hand one run's verified tool call or fail-closed latch to a
    // different concurrent run in the same session. An unknown run is a run
    // this store never classified, so it has no state here — that is a
    // different thing from "use whatever the session last did".
    if (runId) return runKey(runId);
    // The session fallback exists only for the outbound delivery hooks, which
    // OpenClaw 2026.6.1 does not give a run id at all.
    if (sessionKey && sessionIndex.has(sessionKey)) return sessionIndex.get(sessionKey);
    if (sessionKey) return sessionSlot(sessionKey);
    return null;
  }

  return {
    /** Start (or restart) tracking for one turn. */
    begin({ runId, sessionKey, kind, correction, reason, turnNonce, userMessage, prevAssistant, fact, factTransactionAllowed }) {
      const key = runId ? runKey(runId) : sessionKey ? sessionSlot(sessionKey) : null;
      if (!key) return null;
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
        createdAt: ts,
        updatedAt: ts,
      };
      entries.delete(key);
      entries.set(key, entry);
      if (sessionKey) sessionIndex.set(sessionKey, key);
      // Expire after insertion so the new turn is never the entry that gets
      // evicted to satisfy the bound.
      expire();
      return entry;
    },

    /** Count one voice revision for this turn. */
    noteVoiceRevision({ runId, sessionKey }) {
      const key = keyFor({ runId, sessionKey });
      const entry = key ? entries.get(key) : null;
      if (!entry) return null;
      entry.voiceRevisions += 1;
      entry.updatedAt = now();
      return entry;
    },

    /** Record one completed tool call. */
    recordTool({ runId, sessionKey, toolName, ok, params }) {
      const key = keyFor({ runId, sessionKey });
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
    recordEvidence({ runId, sessionKey, toolName, params, result, maxItems, maxChars }) {
      const key = keyFor({ runId, sessionKey });
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
    bindToolCall({ toolCallId, runId, sessionKey }) {
      if (!toolCallId) return null;
      const key = keyFor({ runId, sessionKey });
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
      return { runId: entry.runId, sessionKey: entry.sessionKey };
    },

    /** Count one evidence-backed fact transaction attempt for this turn. */
    noteFactCall({ runId, sessionKey }) {
      const entry = this.get({ runId, sessionKey });
      if (!entry) return null;
      entry.factCalls += 1;
      entry.updatedAt = now();
      return entry;
    },

    /** Count one CASE audit for this turn. */
    noteCaseAudit({ runId, sessionKey }) {
      const entry = this.get({ runId, sessionKey });
      if (!entry) return null;
      entry.caseAudits += 1;
      entry.updatedAt = now();
      return entry;
    },

    /** Count one bounded fact-capture revision request. */
    noteFactRevision({ runId, sessionKey }) {
      const entry = this.get({ runId, sessionKey });
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
    markFactFailClosed({ runId, sessionKey }) {
      const entry = this.get({ runId, sessionKey });
      if (!entry) return null;
      entry.factFailClosed = true;
      entry.updatedAt = now();
      return entry;
    },

    /** Record the terminal outcome of this turn's fact transaction. */
    setFactOutcome({ runId, sessionKey }, outcome) {
      const entry = this.get({ runId, sessionKey });
      if (!entry) return null;
      entry.factOutcome = outcome ?? null;
      entry.updatedAt = now();
      return entry;
    },

    get({ runId, sessionKey }) {
      const key = keyFor({ runId, sessionKey });
      if (!key) return null;
      return entries.get(key) ?? null;
    },

    /** Count one bounded revision request. */
    noteRevision({ runId, sessionKey }) {
      const entry = this.get({ runId, sessionKey });
      if (!entry) return null;
      entry.revisions += 1;
      entry.updatedAt = now();
      return entry;
    },

    /** Latch the fail-closed decision so delivery hooks agree with finalize. */
    markFailClosed({ runId, sessionKey }) {
      const entry = this.get({ runId, sessionKey });
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
    noteFailClosedEmission({ runId, sessionKey, lane }) {
      const entry = this.get({ runId, sessionKey });
      if (!entry) return 0;
      const seen = entry.failClosedEmitted[lane] ?? 0;
      entry.failClosedEmitted[lane] = seen + 1;
      entry.updatedAt = now();
      return seen;
    },

    /** Drop a turn's state once it can no longer be needed. */
    release({ runId, sessionKey }) {
      const key = keyFor({ runId, sessionKey });
      if (!key) return;
      entries.delete(key);
      if (sessionKey && sessionIndex.get(sessionKey) === key) sessionIndex.delete(sessionKey);
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
 */
export function isReleasable(entry) {
  if (!entry) return false;
  if (entry.failClosed) return false;
  if (entry.kind == null) return true;
  return entry.verified === true;
}
