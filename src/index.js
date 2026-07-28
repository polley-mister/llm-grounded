// llm-grounded — deterministic evidence gate for the agent turns.
//
// Contract (from WP-2026-002, extended by WP-2026-004):
//   before_prompt_build     classify the turn, capture the exact operator text
//                           and prior answer, detect a durable fact, inject the
//                           requirement
//   before_tool_call        bind a vault_fact_commit call to its run
//   after_tool_call         record tool success/failure and bind wiki evidence
//   before_agent_finalize   request at most one bounded revision, then latch
//                           the fail-closed decision and write evidence
//   reply_payload_sending   fail closed on the payload path
//   message_sending         fail closed on the plain-content path
//   agent_end               terminal evidence flush for runs that never reach
//                           a natural finalize (see the handler for why)
//
// The grounding gate never decides anything with an LLM and never calls the
// network. The fact transaction does make exactly one model call — the isolated
// CASE audit — but only as an *additional* veto: every deterministic check has
// already passed before CASE is asked, and CASE can only refuse, never widen.

import {
  classifyGrounding,
  configureAgentNames,
  configurePersonalTerms,
  extractTurnNonce,
  extractUserTurn,
  lastAssistantText,
  describeFeatures,
} from "./classify.js";
import { appliesToAgent, configSchema, factsApplyToAgent, parseConfig } from "./config.js";
import {
  CORRECTION_RULE,
  FACT_RULE,
  FAIL_CLOSED_TEXT,
  factRevisionInstruction,
  isFailClosedText,
  requirementText,
  revisionInstruction,
  SELF_DESCRIPTION_RULE,
  VOICE_CODA,
} from "./contract.js";
import { buildEvidence, pruneEvidence, writeEvidence } from "./evidence.js";
import { detectFactStatement } from "./facts-detect.js";
import { createOverlayReader, overlayToolResult } from "./facts-overlay.js";
import { createSessionOverlay, mergeOverlays } from "./session-overlay.js";
import { resolveDelivery, selectTerminalObservation } from "./delivery.js";
import { resolveTrafficClass } from "./traffic.js";
import {
  BOUNDS as EVIDENCE_BOUNDS,
  captureToolCallEvidence,
  createTurnBudget,
  pruneEvidenceCapture,
} from "./evidence-capture.js";
import {
  createFactTool,
  FACT_TOOL_NAME,
  isDirectOwnerSession,
  isFactOperatorAuthorized,
} from "./facts-tool.js";
import { createGroundingStore, isReleasable } from "./state.js";
import { assessVoice } from "./voice.js";
import { readFileSync } from "node:fs";
import { behaviorIdentity, buildInfo, buildTurnRecord, pruneTurns, writeTurn } from "./telemetry.js";
import { advisoryText, hardTrigger } from "./explicit.js";
import { assessToolSafety, blockMessage } from "./sensitive.js";

// Read from the manifest rather than duplicated as a literal: a hardcoded
// version silently goes stale on the next bump and mislabels every record
// written after it.
const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ).version;
  } catch {
    return "unknown";
  }
})();

/** Retrievals whose successful results may be bound into the audit packet. */
const EVIDENCE_TOOLS = ["wiki_search", "wiki_get"];

export const PLUGIN_ID = "llm-grounded";

/**
 * Installation vocabulary last applied to the classifier.
 *
 * The classifier is a pure function of its input plus this registry, so the
 * registry is written only when it actually changes. Comparing the serialized
 * form keeps a per-turn config resolve from rebuilding regexes on every hook.
 */
let appliedVocabulary = null;

function applyVocabulary(cfg) {
  const signature = JSON.stringify([cfg.personalTerms, cfg.agentNames]);
  if (signature === appliedVocabulary) return;
  configurePersonalTerms(cfg.personalTerms);
  configureAgentNames(cfg.agentNames);
  appliedVocabulary = signature;
}

/** Resolve per-handler plugin config, falling back to defaults. */
function resolveConfig(ctx) {
  const parsed = parseConfig(ctx?.pluginConfig);
  const cfg = parsed.success ? parsed.data : parseConfig(undefined).data;
  applyVocabulary(cfg);
  return cfg;
}

/** Whether a transcript message is an assistant's visible final prose, not a tool step. */
function isVisibleTerminalAssistant(message) {
  if (message?.role !== "assistant") return false;
  const content = Array.isArray(message.content) ? message.content : [];
  if (content.some((part) => part?.type === "toolCall")) return false;
  return content.some((part) => part?.type === "text" && typeof part.text === "string" && part.text.trim());
}

/** The visible prose of a transcript message, joined across text parts. */
function textOf(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

/** Preserve transcript metadata but remove unverified prose and reasoning traces. */
function replaceAssistantText(message, text) {
  return {
    ...message,
    content: [{ type: "text", text }],
  };
}

/**
 * Resolve plugin config inside a tool factory.
 *
 * Hook contexts carry `pluginConfig`; a tool context does not — it carries the
 * whole runtime config snapshot instead. Read our own entry out of it, and fall
 * back to the last config a hook resolved, then to defaults. Defaults leave
 * `factsEnabled` false, so a failure to resolve config closes the tool rather
 * than opening it.
 */
export function resolveToolConfig(toolCtx, fallback) {
  if (toolCtx?.pluginConfig !== undefined) return resolveConfig(toolCtx);
  const snapshot = toolCtx?.runtimeConfig ?? toolCtx?.config ?? toolCtx?.getRuntimeConfig?.();
  const entry = snapshot?.plugins?.entries?.[PLUGIN_ID]?.config;
  if (entry !== undefined) {
    const parsed = parseConfig(entry);
    if (parsed.success) return parsed.data;
  }
  return fallback ?? parseConfig(undefined).data;
}

/**
 * Build the plugin. Exported for tests so hook behavior can be exercised
 * without a running gateway.
 */
export function createPlugin(deps = {}) {
  const now = deps.now ?? (() => Date.now());
  const write = deps.writeEvidence ?? writeEvidence;
  const prune = deps.pruneEvidence ?? pruneEvidence;
  const writeTurnRecord = deps.writeTurn ?? writeTurn;
  const pruneTurnRecords = deps.pruneTurns ?? pruneTurns;
  let store = null;
  /** Last config a hook resolved, so the tool factory has a sane fallback. */
  let lastCfg = null;
  /** Live OpenClaw config reader, installed at registration time. */
  let readRuntimeConfig = null;
  /** Authoritative-fact overlay reader, created once the vault path is known. */
  let overlay = null;
  /**
   * Retrieval calls authorized by a trusted before_tool_call context.
   *
   * OpenClaw 2026.7.1's agent-tool-result middleware context contains only the
   * runtime id, despite its public type allowing agentId/session fields. Bind
   * the call id while those trusted fields are available, then consume that
   * capability in the middleware. This keeps the overlay the agent-only without
   * trusting result text or applying it globally.
   */
  const overlayCalls = new Map();

  function authorizeOverlayCall(toolCallId, cfg) {
    if (!toolCallId) return;
    const cutoff = now() - cfg.stateTtlSeconds * 1000;
    for (const [id, at] of overlayCalls) {
      if (at < cutoff) overlayCalls.delete(id);
    }
    while (overlayCalls.size >= cfg.maxTrackedTurns) {
      overlayCalls.delete(overlayCalls.keys().next().value);
    }
    overlayCalls.set(toolCallId, now());
  }

  /**
   * Config for the middleware, which receives no plugin config of its own.
   * Prefers the last config a hook resolved, then the registration snapshot,
   * then defaults — and defaults leave `factsEnabled` false, so a config we
   * cannot resolve closes the overlay rather than opening it.
   */
  /**
   * The resolved runtime configuration, or an explanation of why there isn't one.
   *
   * Three states, and the third is the whole point:
   *
   *   resolved    a real plugin entry was found, parsed and validated
   *   unresolved  no configuration source could be located at all
   *
   * `unresolved` must never become "disabled". The previous version collapsed
   * them: a middleware that could not find config fell back to package
   * defaults, in which every optional feature is off, and then returned
   * silently. In production that made evidence capture inert and indented
   * nothing in any log — indistinguishable from capture running and finding
   * nothing. Optional *keys* may default; absence of the entire configuration
   * source may not.
   */
  let runtimeSnapshot = { status: "unresolved", reason: "not_yet_registered" };
  let unresolvedReported = false;

  /**
   * The logger, resolved rather than assumed.
   *
   * `pluginLogger` is undefined in production: the default export calls
   * createPlugin() with no dependencies, so every `pluginLogger?.debug?.()` in
   * this file — including the overlay's — has been a no-op since it was
   * written. Two deployments were then diagnosed by reading silence that could
   * not have contained anything.
   *
   * The host's logger is preferred when it offers one; otherwise the process
   * console, whose output reaches journald under the gateway service. A
   * diagnostic nobody can read is not a diagnostic.
   */
  let runtimeLogger = deps.logger ?? null;

  function log(level, message) {
    const l = runtimeLogger;
    if (l && typeof l[level] === "function") {
      l[level](message);
      return;
    }
    if (level === "error" || level === "warn") console.error(message);
    else console.log(message);
  }

  /** For modules that accept a logger parameter, so their failures surface too. */
  const pluginLogger = {
    info: (m) => log("info", m),
    warn: (m) => log("warn", m),
    error: (m) => log("error", m),
    debug: (m) => log("debug", m),
  };

  /** True once the tool-result middleware has been invoked in this process. */
  let middlewareSeen = false;

  /** Resolve from the canonical OpenClaw plugin entry. */
  function resolveRuntimeSnapshot(api) {
    const raw = api?.config?.plugins?.entries?.[PLUGIN_ID]?.config;
    if (raw === undefined || raw === null) {
      return { status: "unresolved", reason: "plugin_config_unavailable" };
    }
    const parsed = parseConfig(raw);
    if (!parsed.success) {
      // A malformed entry stays a parse failure. Silently becoming "disabled"
      // is how a typo turns into a feature that never runs.
      return {
        status: "unresolved",
        reason: "plugin_config_invalid",
        detail: parsed.error?.issues?.[0]?.message ?? "invalid",
      };
    }
    return { status: "resolved", source: "openclaw-plugin-entry", config: parsed.data };
  }

  /**
   * The snapshot the middlewares use.
   *
   * Prefers the registration-time snapshot. `lastCfg` is accepted only as a
   * cache of a configuration that already resolved successfully through a hook
   * context — never as a way to manufacture one.
   */
  function middlewareSnapshot() {
    if (runtimeSnapshot.status === "resolved") return runtimeSnapshot;
    // Deliberately no fallback to lastCfg. hookConfig sets it from whatever a
    // hook context offered, and when that context carries nothing it resolves
    // to package defaults — in which every optional feature is off. Accepting
    // that here would reintroduce the exact defect this function exists to
    // remove: a middleware believing config resolved, silently doing nothing.
    if (!unresolvedReported) {
      unresolvedReported = true;
      log("error",
        "llm-grounded runtime config unavailable; evidence capture and overlays degraded " +
          `(reason=${runtimeSnapshot.reason})`,
      );
    }
    return runtimeSnapshot;
  }

  /**
   * Corrections accepted but not durably written, held for the life of a
   * session so the conversation does not read a stale value back. Process
   * local and never persisted: a failed durable write must not be quietly
   * replaced by a different durable write somewhere nobody is looking.
   */
  const sessionOverlay = deps.sessionOverlay ?? createSessionOverlay();

  function ensureOverlay(cfg) {
    if (!overlay) {
      overlay =
        deps.overlayReader ??
        createOverlayReader({ vaultPath: cfg.vaultPath, logger: pluginLogger });
    }
    return overlay;
  }

  function hookConfig(ctx) {
    const liveConfig = readRuntimeConfig?.();
    lastCfg = resolveToolConfig(
      {
        pluginConfig: ctx?.pluginConfig,
        runtimeConfig: liveConfig,
      },
      lastCfg,
    );
    return lastCfg;
  }

  function ensureStore(cfg) {
    if (!store) {
      store = createGroundingStore({
        ttlMs: cfg.stateTtlSeconds * 1000,
        maxEntries: cfg.maxTrackedTurns,
        now,
      });
    }
    return store;
  }

  /**
   * The one place turn identity is read out of the host.
   *
   * Not because the precedence is subtle, but because it was written out
   * longhand at each of the two sites that needed it and the two spellings
   * disagreed. Whatever this returns is what the turn is; nothing downstream
   * re-derives it.
   */
  function trafficIdentityOf(event, ctx) {
    return Object.freeze({
      sessionId:
        event?.sessionId ?? ctx?.sessionId ?? ctx?.sessionKey ?? event?.sessionKey ?? null,
      sessionKey:
        ctx?.sessionKey ?? event?.sessionKey ?? ctx?.sessionId ?? event?.sessionId ?? null,
      agentId: ctx?.agentId ?? event?.agentId ?? null,
    });
  }

  /**
   * Did the host later present a different identity for this turn?
   *
   * Compared field by field against what was recorded, and only where both
   * sides actually have a value: a hook that carries less identity than
   * `before_prompt_build` did is missing information, not contradicting it,
   * and treating absence as disagreement would flag every ordinary turn.
   *
   * Reporting only. The first decision stays binding — re-deciding here is the
   * defect this whole change removes.
   */
  function hasTrafficIdentityMismatch(stored, later) {
    for (const field of ["sessionId", "sessionKey", "agentId"]) {
      if (stored?.[field] != null && later?.[field] != null && stored[field] !== later[field]) {
        return true;
      }
    }
    return false;
  }

  const handlers = {
    async before_prompt_build(event, ctx) {
      const cfg = hookConfig(ctx);
      if (!appliesToAgent(cfg, ctx?.agentId)) return;
      const s = ensureStore(cfg);
      const prompt = event?.prompt ?? "";
      const key = turnKey(ctx, event);
      const nonce = extractTurnNonce(prompt);
      const existing = s.get(key);

      // Classify exactly once per turn.
      //
      // This hook fires again inside the same run whenever the harness rebuilds
      // the prompt — most importantly for the bounded revision this plugin
      // itself requests. That rebuilt prompt is not the operator's turn: it
      // carries our own requirement text, which names memory_search and
      // web_search, so reclassifying it turned a direct arithmetic turn into a
      // `memory` one, failed verification, and threw away a correct answer.
      //
      // A new turn is only ever signalled by a *new non-null* nonce. A null
      // nonce means either a native channel or a rebuilt prompt that lost the
      // marker; neither may replace a live classification. Native sequential
      // turns are still classified fresh, because each inbound turn gets its
      // own run and therefore has no existing entry.
      const isNewTurn = !existing || (nonce !== null && nonce !== existing.turnNonce);

      const userTurn = extractUserTurn(prompt);
      // Capture the exact operator text and the claim a correction would be
      // correcting. Both are read here, once, from the harness's own prepared
      // messages — never later from anything the model composed. The prior
      // answer is also what routes a contextual correction to the memory tier.
      const prevAssistant = isNewTurn ? lastAssistantText(event?.messages) : existing.prevAssistant;
      // Fact detection runs first so its contextual-correction verdict can
      // route grounding. Detection already excludes questions, quotations,
      // hypotheticals, hedges, jokes and third-party claims, so nothing weaker
      // than a real correction reaches the grounding classifier this way.
      const fact = isNewTurn ? detectFactStatement(userTurn, prevAssistant) : null;
      const direct = isDirectOwnerSession(ctx?.sessionKey, ctx, cfg);
      const factTransactionAllowed =
        factsApplyToAgent(cfg, ctx?.agentId) && isFactOperatorAuthorized(ctx, direct) && direct.ok;
      const verdict = isNewTurn
        ? classifyGrounding(userTurn, {
            prevAssistant,
            contextualCorrection: fact.kind === "correct",
          })
        : { kind: existing.kind, correction: existing.correction, reason: existing.reason };

      // Computed once per turn, like the verdict, and reused afterwards.
      // The hook fires again when the harness rebuilds the prompt for a
      // revision, and that rebuilt text is our own requirement rather than the
      // operator's turn. Recomputing against it derives the obligation from
      // the wrong string, which is exactly the trap the nonce guard exists for
      // and which this file already documents for classifyGrounding.
      const hard = isNewTurn
        ? hardTrigger(userTurn, { prevAssistant })
        : { kind: existing?.kind ?? null, reason: existing?.hardReason ?? "carried" };

      if (isNewTurn) {
        // Who or what produced this turn, decided here and nowhere else.
        //
        // This is the only hook that sees full host identity. OpenClaw's
        // agent-tool-result middleware receives none, so the evidence path used
        // to classify from what it had, land on the configured default, and
        // exclude itself — on every production turn since 0.2.0, while
        // telemetry recorded the correct class from this same turn. One turn,
        // two answers. The decision and the identity it was made from are both
        // frozen: a shallow freeze would still let a later hook edit the
        // identity out from under the verdict.
        const identity = trafficIdentityOf(event, ctx);
        const traffic = Object.freeze({
          ...resolveTrafficClass(identity, cfg.trafficClasses),
          resolvedAt: "before_prompt_build",
          identity,
        });
        s.begin({
          runId: key.runId,
          sessionKey: key.sessionKey,
          sessionId: key.sessionId,
          // Only a hard trigger creates an obligation. An advisory turn is
          // stored as kind:null, which makes it releasable on arrival — no
          // requirement, no revision, and structurally no route to
          // fail-closed. That is the whole of Phase 1A in one line.
          // web/memory only. A correction trigger deliberately does not become
          // a tier: binding it to "memory" would compel a search to answer,
          // which is the conflation this design exists to avoid.
          kind: hard.kind === "web" || hard.kind === "memory" ? hard.kind : null,
          correction: verdict.correction,
          correctionScope: hard.correctionScope ?? null,
          reason: verdict.reason,
          turnNonce: nonce,
          userMessage: userTurn,
          prevAssistant,
          fact,
          factTransactionAllowed,
          traffic,
        });
        // Phase 0: the signals this turn tripped, recorded beside the verdict
        // on the turn itself. Read-only — describeFeatures never influences a
        // decision. Recorded after begin, because it annotates the entry that
        // begin creates.
        //
        // Date.now() rather than the injectable clock: this starts the latency
        // measurement, and a test that freezes time must not silently make
        // every turn take zero milliseconds.
        s.noteTelemetryFeatures(key, describeFeatures(userTurn), Date.now());
      }

      // The correction rule is static, so it goes on the cacheable system
      // surface. The per-turn requirement is not static and must not be cached.
      // On a revision pass the original requirement is re-stated, so the model
      // still sees what it has to satisfy.
      const staticRules = factsApplyToAgent(cfg, ctx?.agentId)
        ? `${CORRECTION_RULE}\n\n${FACT_RULE}`
        : CORRECTION_RULE;
      const result = { prependSystemContext: staticRules };

      // Phase 1A. Only an explicit instruction, a parsed arithmetic
      // expression, or an admin command may compel a capability. Everything
      // else is offered as a hint the model may ignore.
      //
      // The legacy verdict keeps being computed and recorded; it simply no
      // longer has authority. Baseline over 28 turns: 61% compelled a tool,
      // 29% ended fail-closed, 43% were routed by capitalisation alone.
      const advisory = hard.kind === null;
      if (isNewTurn) {
        s.noteTelemetryPolicy(key, {
          policyMode: advisory ? "advisory" : "binding",
          hardTrigger: hard.kind,
          hardReason: hard.reason,
          // correctionScope is not repeated here: it lives on the entry, which
          // is what the record reads.
          evidenceSource: hard.evidenceSource ?? null,
          policyScope: hard.policyScope ?? null,
          legacyVerdict: verdict.kind,
          legacyReason: verdict.reason,
          legacyWouldCompel: Boolean(verdict.kind),
        });
      }

      const requirement = verdict.reason === "self-description"
        ? SELF_DESCRIPTION_RULE
        : advisory
          ? advisoryText(verdict.kind)
          : requirementText(hard.kind === "arithmetic" || hard.kind === "admin" ? null : hard.kind);
      // the console appends this same coda itself, immediately before its
      // per-turn nonce, so a marked turn already has it and a second copy would
      // just be duplication. Native OpenClaw turns carry no marker and no final
      // reminder, so the plugin supplies the identical line — one shared string
      // from contract.js, not two competing partial persona specifications.
      const nativeVoice = nonce === null ? VOICE_CODA : null;
      const appended = [requirement, nativeVoice].filter(Boolean).join("\n\n");
      if (appended) result.appendContext = appended;
      return result;
    },

    /**
     * Bind a fact-tool call to its run.
     *
     * This is the only hook that sees a tool call id together with a run id, so
     * it is where same-run evidence binding is established. It is also the last
     * cheap place to refuse the call outright for an agent that must not have
     * it — `execute` re-checks, but a blocked call never even runs.
     */
    before_tool_call(event, ctx) {
      const cfg = hookConfig(ctx);

      // Safety before routing. Independent of policy mode and unaffected by
      // the classifier becoming advisory: whether a tool is compelled and
      // whether a particular query may run are different questions.
      // Bind this call to its turn. The tool-result middleware receives no
      // session key, run id or agent id — measured, not assumed — so without a
      // binding made here it cannot tell which turn a result belongs to, and
      // evidence capture silently skipped every call for want of identity.
      // before_tool_call is the one hook that sees a tool call id together with
      // a run id, which is why the fact transaction already binds here.
      if (event?.toolCallId) {
        store.bindToolCall({
          toolCallId: event.toolCallId,
          ...turnKey(ctx, event),
        });
      }

      const safety = assessToolSafety(event?.toolName, event?.params);
      if (safety.blocked) {
        store?.noteTelemetryBlocked?.(turnKey(ctx, event), {
          tool: event?.toolName,
          reason: safety.reason,
        });
        pluginLogger?.warn?.(
          `llmGrounded: blocked ${event?.toolName} (${safety.reason})`,
        );
        return { block: true, blockReason: blockMessage() };
      }

      if (EVIDENCE_TOOLS.includes(event?.toolName)) {
        if (factsApplyToAgent(cfg, ctx?.agentId)) {
          authorizeOverlayCall(event?.toolCallId ?? ctx?.toolCallId, cfg);
        }
        return;
      }
      // A durable-fact turn may mutate the vault only through the guarded
      // transaction. This closes the broad memory-wiki writer as a same-turn
      // bypass for both main and chat.
      if (event?.toolName === "wiki_apply") {
        const entry = store?.get(turnKey(ctx, event));
        if (
          factsApplyToAgent(cfg, ctx?.agentId) &&
          entry?.factEligible &&
          entry?.factUnambiguous
        ) {
          return {
            block: true,
            blockReason:
              "llm-grounded: durable facts may be changed only through vault_fact_commit",
          };
        }
        return;
      }
      if (event?.toolName !== FACT_TOOL_NAME) return;
      if (!factsApplyToAgent(cfg, ctx?.agentId)) {
        return { block: true, blockReason: "llm-grounded: vault_fact_commit is not enabled for this agent" };
      }
      if (!store) {
        return { block: true, blockReason: "llm-grounded: no turn state for this run" };
      }
      const bound = store.bindToolCall({
        // OpenClaw's typed hook contract carries toolCallId on both the event
        // and trusted context. Plugin-owned tools currently populate the
        // context copy; core tools normally populate the event copy.
        toolCallId: event?.toolCallId ?? ctx?.toolCallId,
        ...turnKey(ctx, event),
      });
      if (!bound) {
        return { block: true, blockReason: "llm-grounded: this tool call could not be bound to a turn" };
      }
      return;
    },

    after_tool_call(event, ctx) {
      const cfg = hookConfig(ctx);
      if (!appliesToAgent(cfg, ctx?.agentId)) return;
      if (!store) return;
      const ok = !event?.error && !isErrorResult(event?.result);
      const key = turnKey(ctx, event);
      store.recordTool({ ...key, toolName: event?.toolName, ok, params: event?.params });
      noteToolCall(ctx, event, ok);
      // Successful retrievals become the audit packet's vault evidence. Failed
      // ones are not evidence of anything, so they are not retained.
      if (ok && EVIDENCE_TOOLS.includes(event?.toolName)) {
        store.recordEvidence({
          ...key,
          toolName: event.toolName,
          params: event?.params,
          result: event?.result,
          maxItems: cfg.maxEvidenceItems,
          maxChars: cfg.maxEvidenceChars,
        });
      }
    },

    async before_agent_finalize(event, ctx) {
      const cfg = hookConfig(ctx);
      if (!appliesToAgent(cfg, ctx?.agentId)) return;
      if (!store) return;
      const key = turnKey(ctx, event);
      const entry = store.get(key);
      if (!entry) return;

      const alreadyFailClosed = failedClosedFor(entry, event?.lastAssistantMessage);
      if (!isReleasable(entry) && !alreadyFailClosed) {
        if (entry.revisions < cfg.maxRevisions) {
          store.noteRevision(key);
          await persist(cfg, entry, event, ctx);
          const instruction = revisionInstruction(entry.kind, entry.userMessage);
          return {
            action: "revise",
            // OpenClaw 2026.7.1 builds the retry prompt from `reason`; its
            // outer embedded-run loop currently does not forward the typed
            // `retry.instruction` field. Keep the full actionable instruction
            // in both places so this works on the current runtime and remains
            // compatible when that field is forwarded.
            reason: instruction,
            retry: {
              instruction,
              idempotencyKey: `llmGrounded:${key.runId ?? key.sessionKey}`,
              maxAttempts: cfg.maxRevisions,
            },
          };
        }
        // Bounded revision spent and still unverified: the draft never ships.
        store.markFailClosed(key);
      }
      // Voice gate. Runs only once grounding is satisfied, so a correct answer
      // is never re-rolled for style while it is still unverified — and a
      // wrong answer is never made prettier instead of right.
      //
      // Its own budget: borrowing the grounding revision would mean a long
      // reply could spend the retry that correctness depends on.
      const releasableNow = isReleasable(store.get(key) ?? entry);
      if (
        releasableNow &&
        !alreadyFailClosed &&
        (cfg.maxVoiceRevisions ?? 0) > 0 &&
        (store.get(key)?.voiceRevisions ?? 0) < cfg.maxVoiceRevisions
      ) {
        const verdict = assessVoice(event?.lastAssistantMessage, {
          userMessage: entry.userMessage,
          maxWords: cfg.voiceMaxWords,
        });
        if (!verdict.ok) {
          store.noteVoiceRevision(key);
          return {
            action: "revise",
            reason: verdict.instruction,
            retry: {
              instruction: verdict.instruction,
              idempotencyKey: `llm-grounded-voice:${key.runId ?? key.sessionKey}`,
              maxAttempts: cfg.maxVoiceRevisions,
            },
          };
        }
      }

      // Grounding failure is the stronger gate. Once its exact response is
      // present (or its latch is set), do not ask the model to perform a fact
      // transaction against evidence we do not trust.
      if (!releasableNow || alreadyFailClosed) {
        // Still resolve a terminal decision: the delivery lanes render it, and
        // a grounding failure that never reaches them ships the unverified
        // draft. resolveDelivery returns "replace" here, so the fact note is
        // correctly suppressed while its outcome stays in the record.
        store.setDelivery(key, terminalDecision(cfg, key, store.get(key) ?? entry, event, ctx));
        await persist(cfg, store.get(key) ?? entry, event, ctx);
        return;
      }

      // A turn that unambiguously stated or corrected a durable fact gets one
      // bounded nudge to actually call the tool. This is about getting the
      // write attempted at all, and is separate from what the reply then says
      // about it.
      const current = store.get(key) ?? entry;
      if (factEnforcementRequired(cfg, current, ctx) && factRevisionAvailable(cfg, current)) {
        store.noteFactRevision(key);
        await persist(cfg, store.get(key) ?? entry, event, ctx);
        return factRevisionRequest(current);
      }

      // The single terminal decision. Every delivery lane renders this; none of
      // them recompute it, which is what stops them diverging.
      const decision = terminalDecision(cfg, key, store.get(key) ?? entry, event, ctx);

      // A draft that claims the write succeeded gets one bounded repair on its
      // own budget. Sharing the fact-revision budget would mean a turn that
      // already retried the commit has nothing left to fix a contradiction,
      // and would ship it.
      if (decision.action === "revise") {
        store.notePersistenceClaimRevision(key);
        await persist(cfg, store.get(key) ?? entry, event, ctx);
        return {
          action: "revise",
          reason: decision.instruction,
          retry: {
            instruction: decision.instruction,
            idempotencyKey: `llm-grounded-persistence:${key.runId ?? key.sessionKey}`,
            maxAttempts: 1,
          },
        };
      }

      store.setDelivery(key, decision);
      await persist(cfg, store.get(key) ?? entry, event, ctx);
      return;
    },

    /**
     * OpenClaw writes a completed assistant message to its transcript before
     * `before_agent_finalize` can request a retry. Delivery is suppressed, but
     * transcript-subscribing clients still render that draft, followed by the
     * revised answer. Hide only drafts which the deterministic gate already
     * knows cannot ship; tool-call messages and ordinary final answers remain
     * untouched. On the last permitted pass, persist the same fail-closed text
     * that delivery will emit, never the unverified draft.
     */
    before_message_write(event, ctx) {
      const cfg = hookConfig(ctx);
      if (!appliesToAgent(cfg, event?.agentId ?? ctx?.agentId)) return;
      if (!store || !isVisibleTerminalAssistant(event?.message)) return;
      const entry = store.get(turnKey(ctx, event));
      if (!entry) return;

      const wkey = turnKey(ctx, event);

      // A resolved decision wins outright. Finalize has already decided what
      // ships; re-deriving "is something still pending" from counters here is
      // how this lane used to disagree with the others.
      if (entry.delivery) {
        // Observe what this lane sees before deciding whether to change it.
        // This is the only lane `deliver:false` reaches, so on that transport
        // it is the authoritative record of what shipped.
        observe(wkey, "transcript", textOf(event?.message), false);
        if (entry.delivery.action === "pass") return;
        store.updateObservedText(wkey, "transcript", entry.delivery.text);
        return { message: replaceAssistantText(event.message, entry.delivery.text) };
      }

      const groundingPending = !isReleasable(entry);
      const groundingExhausted = groundingPending && entry.revisions >= cfg.maxRevisions;
      // Still retrievable: finalize will ask for the bounded revision, and this
      // draft must not reach the transcript in the meantime.
      if (groundingPending && !groundingExhausted) return { block: true };

      const factPending =
        entry.factTransactionAllowed &&
        entry.factEligible &&
        entry.factUnambiguous &&
        entry.factOutcome?.ok !== true;
      if (factPending && factRevisionAvailable(cfg, entry)) return { block: true };

      // This is the lane `deliver:false` reads from — it has no payload hook to
      // intercept — so the transcript must carry exactly what ships, not a
      // blocked draft. Resolving here rather than waiting for finalize is safe
      // because the decision is a pure function of state both hooks can see,
      // and it is stashed so finalize reuses it instead of recomputing.
      const key = turnKey(ctx, event);
      // The latch is set by the next finalize, which has not run yet. A draft
      // whose grounding budget is already spent cannot ship regardless, so it
      // is fail-closed here even though the entry does not say so yet.
      const effective = groundingExhausted ? { ...entry, failClosed: true } : entry;
      const decision =
        entry.delivery ??
        terminalDecision(cfg, key, effective, { lastAssistantMessage: textOf(event?.message) }, ctx);
      // Observed before the pass check, so an ordinary turn on this transport
      // is still recorded as having been seen leaving.
      observe(key, "transcript", textOf(event?.message), false);
      if (decision.action === "revise") return { block: true };
      if (decision.action === "pass") return;
      store.setDelivery(key, decision);
      store.updateObservedText(key, "transcript", decision.text);
      return { message: replaceAssistantText(event.message, decision.text) };
    },

    reply_payload_sending(event, ctx) {
      const cfg = hookConfig(ctx);
      if (!store) return;
      const key = turnKey(ctx, event);
      const entry = store.get(key);
      if (!entry) return;
      const decision = entry.delivery;
      // Observed whether or not anything is substituted: an unchanged payload
      // is still this turn leaving through an outbound lane.
      observe(key, "payload", event?.payload?.text, true);
      if (!decision || decision.action === "pass") return;
      const reason = deliveryReason(entry, decision);
      // One turn can normalize into several payloads. The terminal text belongs
      // on the first; repeating it per chunk would be noise. This cannot drop
      // the persistence note, because the note is inside that one text rather
      // than something appended separately per lane.
      if (store.noteFailClosedEmission({ ...key, lane: "payload" }) > 0) {
        return { cancel: true, reason };
      }
      store.updateObservedText(key, "payload", decision.text);
      // Media and rich presentation cannot carry a verified claim, so they are
      // dropped when the answer itself was withheld. An annotated answer is a
      // real answer, so its payload is left intact.
      const payload = event?.payload ?? {};
      return {
        payload: {
          ...(decision.action === "replace" ? stripUnverifiable(payload) : payload),
          text: decision.text,
        },
        reason,
      };
    },

    message_sending(event, ctx) {
      const cfg = hookConfig(ctx);
      if (!store) return;
      const key = turnKey(ctx, event);
      const entry = store.get(key);
      if (!entry) return;
      const decision = entry.delivery;
      observe(key, "message", event?.content, true);
      if (!decision || decision.action === "pass") return;
      if (store.noteFailClosedEmission({ ...key, lane: "message" }) > 0) {
        return { cancel: true, cancelReason: deliveryReason(entry, decision) };
      }
      store.updateObservedText(key, "message", decision.text);
      return {
        content: decision.text,
        metadata: {
          llmGrounded: {
            failClosed: decision.action === "replace",
            grounding: entry.kind,
            responsePolicy: decision.responsePolicy,
            persistenceOutcome: decision.persistenceOutcome,
            sessionOverlayApplied: Boolean(entry.delivery?.sessionOverlayApplied),
          },
        },
      };
    },

    /**
     * Terminal evidence flush.
     *
     * `before_agent_finalize` only fires when a harness is about to accept a
     * natural final answer, so a run that ends any other way would leave
     * the console with no record — which correctly fails closed, but fails
     * closed on turns that were actually fine. `agent_end` always runs, and
     * short-lived one-shot CLI paths (which is exactly how the console
     * invokes the agent) await it before process cleanup.
     */
    async agent_end(event, ctx) {
      const cfg = hookConfig(ctx);
      if (!appliesToAgent(cfg, ctx?.agentId)) return;
      if (!store) return;
      const entry = store.get(turnKey(ctx, event));
      if (!entry) {
        // The only way a covered agent finishes a turn with no state is that
        // `before_prompt_build` never ran — which happens when
        // `hooks.allowPromptInjection` is false for this plugin. That is a
        // silent fail-open, so say so rather than letting it pass unnoticed.
        pluginLogger?.warn?.(
          "llm-grounded: no classification for this turn; " +
            "check plugins.entries.llmGrounded.hooks.allowPromptInjection",
        );
        return;
      }
      // State is not released here: delivery hooks can still fire afterwards on
      // gateway paths, and they must still see the terminal decision. The TTL
      // reclaims it.
      await persist(cfg, entry, event, ctx);

      // Exactly one terminal record per turn. `agent_end` runs after every
      // delivery lane, so by now `entry.emitted` says what actually left and
      // through which lane. A run that never delivered records honestly as
      // unobserved rather than being lost or being labelled as shipped.
      const key = turnKey(ctx, event);
      const finalizeEvent = entry.finalizeEvent ?? event;
      // Choose the most authoritative observation rather than whichever lane
      // happened to fire first: an outbound lane is what the operator actually
      // received, and on deliver:false the transcript is the highest available.
      const terminal = selectTerminalObservation(entry.deliveryObservations, {
        action: entry.delivery?.action ?? null,
        fallbackText: entry.delivery?.text ?? finalizeEvent?.lastAssistantMessage ?? null,
        // Compared against what the model actually drafted, so a substitution
        // that changes nothing is not counted as a change.
        originalDraft: entry.delivery?.sourceDraft ?? finalizeEvent?.lastAssistantMessage ?? null,
      });
      if (store.claimTerminalRecord(key, terminal.emittedLane)) {
        await recordTurn(cfg, entry, finalizeEvent, ctx, terminal);
      }
    },
  };

  /**
   * Whether this turn owes a successful transaction before it may speak
   * normally. True for an unambiguously eligible fact turn whose transaction
   * has not committed — whether the tool was never called, or was called and
   * refused, or the audit failed, or the writer refused.
   */
  function factEnforcementRequired(cfg, entry, ctx) {
    if (!entry) return false;
    if (!factsApplyToAgent(cfg, ctx?.agentId)) return false;
    if (!entry.factTransactionAllowed) return false;
    if (!entry.factEligible || !entry.factUnambiguous) return false;
    return entry.factOutcome?.ok !== true;
  }

  /** Whether a bounded retry pass is still available for this turn. */
  function factRevisionAvailable(cfg, entry) {
    // Only a turn that never reached the tool is worth retrying. A refusal is
    // a decision, not a transient failure, and asking the model to try again
    // would just invite it to reshape the proposal until something passes.
    if (entry.factCalls > 0) return false;
    return entry.factRevisions < cfg.maxFactRevisions;
  }

  /** The bounded revision request for a turn that skipped the tool. */
  function factRevisionRequest(entry) {
    const instruction = factRevisionInstruction(entry.factKind);
    return {
      action: "revise",
      // OpenClaw 2026.7.1 turns `reason`, rather than
      // `retry.instruction`, into the next model prompt.
      reason: instruction,
      retry: {
        instruction,
        idempotencyKey: `llm-grounded-fact:${entry.runId ?? entry.sessionKey}`,
        maxAttempts: 1,
      },
    };
  }

  /**
   * Resolve what this turn delivers.
   *
   * Called from `before_agent_finalize` and, for the `deliver:false` transport,
   * from `before_message_write`. Both see the same state and the decision is
   * pure, so either ordering produces the same answer; the result is stashed so
   * the second caller reuses it rather than recomputing.
   */
  function terminalDecision(cfg, key, entry, event, ctx) {
    const sessionKey = key?.sessionKey ?? ctx?.sessionKey ?? null;
    const overlayActive = sessionKey ? sessionOverlay.active(sessionKey) : false;
    const decision = resolveDelivery({
      // A model that emitted the fail-closed line itself never sets the latch,
      // so the entry alone would understate what happened. Treat the text as
      // authoritative, or a fact note could be appended to a refusal.
      entry: {
        ...entry,
        failClosed: failedClosedFor(entry, event?.lastAssistantMessage),
      },
      draft: event?.lastAssistantMessage ?? "",
      overlayActive,
      structuredFact: entry?.factProposal ?? null,
      maxPersistenceClaimRevisions: cfg?.maxPersistenceClaimRevisions ?? 1,
    });
    return { ...decision, sessionOverlayApplied: overlayActive };
  }

  /** Per-turn evidence budgets, so limits are enforced across tool calls. */
  const evidenceBudgets = new Map();

  /**
   * Capture bounded evidence from one tool result.
   *
   * Awaited, so the ids exist before agent_end writes telemetry — a detached
   * promise would let a record reference evidence that had not finished
   * writing, or never wrote at all. Bounded by its own timeout so awaiting it
   * cannot stall a turn.
   *
   * Every failure path returns quietly: capture is an observer, and a
   * bookkeeping problem must not be able to change what the operator receives.
   */
  async function captureToolEvidence(cfg, event, ctx, result, transformsApplied) {
    try {
      // Prefer the context when the host provides one; fall back to the
      // binding made at before_tool_call, which is the only identity available
      // on this seam in practice.
      const bound = store?.peekToolCall?.(event?.toolCallId) ?? null;
      const key = {
        runId: ctx?.runId ?? event?.runId ?? bound?.runId,
        sessionKey: ctx?.sessionKey ?? event?.sessionKey ?? bound?.sessionKey,
        sessionId: event?.sessionId ?? ctx?.sessionId ?? bound?.sessionId,
      };
      const skip = (reason) => {
        // Legitimate skips are recorded too. "Nothing was captured" and
        // "nothing was captured because the tool is not allowlisted" are
        // different facts, and only one of them is a problem.
        store?.noteEvidenceSkip?.(key, reason);
        log("debug", `llmGrounded: evidence capture skipped tool=${event?.toolName} reason=${reason}`);
      };
      // Louder than a skip, because it is not one. An unresolved identity means
      // capture is inert rather than declining, and the last time that happened
      // it ran unnoticed across four releases while every diagnostic said the
      // feature was configured. It never falls back to a class, and it never
      // invents a turn to hang the reason on: with no entry there is nothing to
      // annotate, and the warning is the whole record.
      const skipUnresolved = () => {
        store?.noteEvidenceSkip?.(key, "traffic_class_unresolved");
        log("warn",
          `llmGrounded: evidence capture unavailable tool=${event?.toolName} ` +
            "reason=traffic_class_unresolved (no turn identity was resolved at before_prompt_build)");
      };

      if (!cfg?.evidenceCaptureEnabled) return skip("capture_disabled");

      const tool = event?.toolName;
      const runtimeTools = cfg.evidenceCaptureRuntimeTools ?? [];
      if (!(cfg.evidenceCaptureTools ?? []).includes(tool) && !runtimeTools.includes(tool)) {
        return skip("tool_not_allowlisted");
      }

      // A truthy result object is not proof of success. Use the same error
      // detection the grounding path uses, so "succeeded" means one thing.
      if (isErrorResult(result)) return skip("tool_not_successful");

      const entry = store?.get?.(key) ?? null;
      // Read the turn's decision. Never classify here: this seam has no
      // identity to classify from, which is precisely how it managed to
      // disagree with the rest of the turn for four releases.
      const traffic = entry?.traffic ?? null;
      if (traffic?.status !== "resolved") return skipUnresolved();
      // Heartbeats and scheduled runs are excluded initially: volume without
      // calibration value, since claim support is being characterised on human
      // answers.
      if (!(cfg.evidenceCaptureTrafficClasses ?? []).includes(traffic.trafficClass)) {
        return skip(`traffic_class_excluded:${traffic.trafficClass}`);
      }

      const budgetKey = key.runId ?? key.sessionKey;
      if (!budgetKey) return skip("no_turn_identity");
      if (!evidenceBudgets.has(budgetKey)) {
        evidenceBudgets.set(budgetKey, createTurnBudget({
          itemsPerCall: cfg.evidenceCaptureMaxItemsPerCall ?? EVIDENCE_BOUNDS.itemsPerCall,
          itemsPerTurn: cfg.evidenceCaptureMaxItemsPerTurn ?? EVIDENCE_BOUNDS.itemsPerTurn,
          charsPerTurn: cfg.evidenceCaptureMaxCharsPerTurn ?? EVIDENCE_BOUNDS.charsPerTurn,
        }));
        // Bounded, and only ever for turns that actually captured something.
        if (evidenceBudgets.size > 200) {
          evidenceBudgets.delete(evidenceBudgets.keys().next().value);
        }
      }

      const capture = captureToolCallEvidence({
        dir: cfg.evidenceCaptureDir,
        // Injectable only so a test can make the store fail for real.
        fsOps: deps.evidenceCaptureFs,
        budget: evidenceBudgets.get(budgetKey),
        logger: pluginLogger,
        tool,
        result,
        params: event?.params,
        // Same correlation key the turn record uses, and read from the same
        // place, so a capture that reached its turn through a bound tool call
        // still files under the identity telemetry will report.
        turnId: entry?.runId ?? entry?.sessionKey ?? key.runId ?? key.sessionKey,
        toolCallId: event?.toolCallId ?? null,
        runtimeTools,
        transformsApplied,
        bounds: {
          excerptChars: cfg.evidenceCaptureMaxCharsPerItem ?? EVIDENCE_BOUNDS.excerptChars,
          itemsPerCall: cfg.evidenceCaptureMaxItemsPerCall ?? EVIDENCE_BOUNDS.itemsPerCall,
          itemsPerTurn: cfg.evidenceCaptureMaxItemsPerTurn ?? EVIDENCE_BOUNDS.itemsPerTurn,
          charsPerTurn: cfg.evidenceCaptureMaxCharsPerTurn ?? EVIDENCE_BOUNDS.charsPerTurn,
        },
      });

      const timeoutMs = cfg.evidenceCaptureTimeoutMs ?? 400;
      const outcome = await Promise.race([
        capture,
        new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), timeoutMs)),
      ]);

      if (outcome?.timedOut) {
        store?.noteEvidenceCapture?.(key, { evidenceIds: [], captured: 0, skipped: 1, failed: 0 });
        log("warn", `llmGrounded: evidence capture timed out after ${timeoutMs}ms`);
        return;
      }
      store?.noteEvidenceCapture?.(key, outcome);
      log("debug",
        `llmGrounded: evidence captured tool=${tool} ids=${outcome.evidenceIds.length} ` +
          `skipped=${outcome.skipped} failed=${outcome.failed}`);
    } catch (err) {
      // Deliberately swallowed. Nothing about capture is worth failing a turn.
      log("warn", `llmGrounded: evidence capture error: ${String(err?.message ?? err)}`);
    }
  }

  /** Why a lane substituted the terminal text, for its cancel/reason field. */
  function deliveryReason(entry, decision) {
    if (decision.action === "replace") return `llmGrounded: ${entry.kind} grounding not verified`;
    return `llmGrounded: durable ${entry.factKind ?? "fact"} not recorded`;
  }

  /**
   * Record what a terminal lane saw, before any early return.
   *
   * Observed on the pass path too. An earlier version only noted a lane when
   * the plugin substituted text, which made `emissionObserved` mean "the
   * plugin changed something" rather than "a lane saw this" — false for every
   * ordinary turn, and ordinary turns are almost all of them.
   */
  function observe(key, lane, text, external) {
    store?.observeLane?.(key, { lane, text, external });
  }

  // Phase 0 telemetry. Held outside the grounding store so a logging change
  // can never alter contract state, and so a missing record degrades to "no
  // telemetry" rather than a failed turn.


  /**
   * Whether this turn failed closed.
   *
   * The latch is authoritative. The text comparison exists only because the
   * requirement asks the model to emit the sentence itself, in which case the
   * plugin never latches anything — but it is meaningful *only when the turn
   * actually owed evidence*.
   *
   * Under advisory routing most turns owe nothing, and a model that happens to
   * produce those words is making conversation, not reporting a failure. This
   * is observed behaviour, not a hypothetical: a turn with no obligation
   * produced the sentence verbatim, with the phrase absent from its prompt and
   * from every tool result, and the plugin recorded a grounding failure that
   * never happened. A fixed string is a fragile control channel, and the metric
   * it corrupts is the one this package exists to produce.
   */
  function failedClosedFor(entry, text) {
    if (entry?.failClosed) return true;
    // Nothing was owed, so nothing can have failed.
    if (entry?.kind == null) return false;
    return isFailClosedText(text);
  }

  /** Grounding obligation for a turn: hard triggers only. */
  function hardTriggerKind(turn) {
    const hard = hardTrigger(turn);
    return hard.kind === "web" || hard.kind === "memory" ? hard.kind : null;
  }

  /**
   * The host metadata a hook has, in the shape the store resolves.
   *
   * Every field it can offer, rather than a single collapsed string: the store
   * decides which one identifies the turn, and it is the only thing that
   * decides.
   */
  function turnKey(ctx, event) {
    return {
      runId: ctx?.runId ?? event?.runId,
      sessionKey: ctx?.sessionKey ?? event?.sessionKey,
      sessionId: event?.sessionId ?? ctx?.sessionId,
    };
  }

  function noteDraft(ctx, event) {
    store?.noteTelemetryDraft?.(turnKey(ctx, event), event?.lastAssistantMessage);
  }

  function noteToolCall(ctx, event, ok) {
    store?.noteTelemetryTool?.(turnKey(ctx, event), {
      name: event?.toolName ?? null,
      ok: Boolean(ok),
      params: sanitizeParams(event?.params),
    });
  }

  /** Query strings are the useful part; anything else could carry secrets. */
  function sanitizeParams(params) {
    if (!params || typeof params !== "object") return {};
    const out = {};
    for (const field of ["query", "q", "search", "text", "limit", "window", "host"]) {
      const v = params[field];
      if (typeof v === "string") out[field] = v.slice(0, 300);
      else if (typeof v === "number") out[field] = v;
    }
    return out;
  }

  /** Detect and describe a testing turn from its session key. */
  function synthetic(event, ctx) {
    const key = String(
      event?.sessionId ?? ctx?.sessionId ?? ctx?.sessionKey ?? "",
    );
    const match = /(?:^|:)synthetic-([a-z0-9-]+)/i.exec(key);
    if (!match) return { synthetic: false };
    return { synthetic: true, syntheticReason: match[1] };
  }

  async function recordTurn(cfg, entry, event, ctx, terminal = {}) {
    if (!cfg?.telemetryDir) return;
    // Compare, do not reclassify. If this hook sees a different session or
    // agent than the turn was recorded under, that is worth knowing and worth
    // recording; it is not grounds for the turn to change what it is.
    if (entry?.traffic?.identity && hasTrafficIdentityMismatch(entry.traffic.identity, trafficIdentityOf(event, ctx))) {
      store?.noteTrafficIdentityMismatch?.({ runId: entry.runId, sessionKey: entry.sessionKey });
      entry = { ...entry, trafficIdentityMismatch: true };
    }
    // One turn, one record, read from the turn itself.
    const meta = entry?.telemetry ?? null;
    const decorated = entry;
    const record = buildTurnRecord(decorated, {
      pluginVersion: PLUGIN_VERSION,
      pluginId: PLUGIN_ID,
      implementation: PLUGIN_ID,
      coreCommit: buildInfo().coreCommit,
      identity: await behaviorIdentity(cfg, { model: ctx?.modelId ?? event?.modelId }),
      policy: meta?.policy ?? null,
      blockedTools: meta?.blockedTools ?? [],
      // The latch is only set when the plugin substitutes the line itself. When
      // the model emits it directly — which the requirement text asks it to —
      // the handler takes the alreadyFailClosed path and never latches, so the
      // entry says false on a turn that plainly failed closed. Detect the
      // outcome from what shipped, not from how it got there.
      // Read from the decision rather than the event: the draft is carried on
      // the decision, while the finalize event reaches here only through the
      // hook wrapper and is absent on some paths.
      failedClosed: failedClosedFor(entry, entry?.delivery?.sourceDraft ?? event?.lastAssistantMessage),
      // The two persistence outcomes, the policy that followed from them, and
      // whether a lane was actually seen to emit the result.
      delivery: entry?.delivery ?? null,
      emittedLane: terminal.emittedLane ?? null,
      emissionObserved: Boolean(terminal.emissionObserved),
      externalDeliveryObserved: Boolean(terminal.externalDeliveryObserved),
      deliveryAction: terminal.deliveryAction ?? null,
      textMutatedByPlugin: Boolean(terminal.textMutatedByPlugin),
      terminalTextMismatch: Boolean(terminal.terminalTextMismatch),
      observedLanes: terminal.observedLanes ?? [],
      // A session key prefixed "synthetic-" marks a turn produced by testing.
      // Marking beats an external exclusion list: the flag travels with the
      // record, so a corpus copied elsewhere stays correctly labelled.
      ...synthetic(event, ctx),
      // The decision this turn already made, copied — not remade. Resolved
      // from host metadata at before_prompt_build, never from the turn text.
      traffic: entry?.traffic ?? null,
      // Whether the host has since presented a different identity for the same
      // turn. A diagnostic, not a trigger: the recorded class stands.
      trafficIdentityMismatch: entry?.trafficIdentityMismatch === true,
      // Unchanged on purpose. This is the correlation key between a turn
      // record and the evidence files it references, and evidence already on
      // disk carries the host-derived form. Read from the entry rather than
      // from this hook's context, so both sides now name the same turn even
      // when a hook was handed less identity than another.
      turnId: entry?.runId ?? entry?.sessionKey ?? null,
      // The internal id, alongside rather than instead. Nothing correlates on
      // it yet; it is here so a corpus can tell two turns apart when a host
      // reuses a session key.
      internalTurnId: entry?.turnId ?? null,
      sessionId: event?.sessionId ?? ctx?.sessionId ?? ctx?.sessionKey,
      agentId: ctx?.agentId,
      // What shipped, as observed by the first delivery lane. Falls back to the
      // resolved text, then the draft, so a record is never empty.
      final: terminal.final ?? event?.lastAssistantMessage,
      model: ctx?.modelId ?? event?.modelId ?? null,
      latencyMs: meta?.startedAt ? Date.now() - meta.startedAt : null,
      now: Date.now(),
    });
    await writeTurnRecord(cfg.telemetryDir, record, pluginLogger);
    await pruneTurnRecords(cfg.telemetryDir, cfg.telemetryRetentionDays, pluginLogger);
    if (cfg.evidenceCaptureEnabled) {
      // Its own retention, shorter than telemetry's: excerpts are verbatim
      // third-party content and should not accumulate indefinitely.
      await pruneEvidenceCapture(cfg.evidenceCaptureDir, cfg.evidenceCaptureRetentionDays, pluginLogger);
    }
    if (cfg.evidenceCaptureEnabled) {
      // Its own retention, shorter than telemetry's: excerpts are verbatim
      // third-party content and should not accumulate indefinitely.
      await pruneEvidenceCapture(cfg.evidenceCaptureDir, cfg.evidenceCaptureRetentionDays, pluginLogger);
    }
    // Nothing to clean up: the turn's telemetry is the turn's, and it is
    // released, expired and bounded with the entry that holds it.
  }

  async function persist(cfg, entry, event, ctx) {
    const sessionId = event?.sessionId ?? ctx?.sessionId ?? ctx?.sessionKey;
    if (!sessionId) return;
    const record = buildEvidence(entry, {
      sessionId,
      agentId: ctx?.agentId,
      now: now(),
    });
    await write(cfg.evidenceDir, sessionId, record, pluginLogger);
    await prune(cfg.evidenceDir);
  }

  return {
    id: PLUGIN_ID,
    name: "llm-grounded",
    description: "Deterministic grounding and voice contract for OpenClaw agents.",
    /**
     * Test-only introspection of per-turn state. Not part of the OpenClaw
     * plugin contract and not read by any handler — it exists so hook wiring
     * can be asserted on the state it actually produced rather than on a
     * downstream side effect.
     */
    get __store() {
      return store;
    },
    configSchema,
    handlers,
    register(api) {
      // One snapshot, resolved once. Configuration changes restart this
      // gateway, so per-call re-resolution would add inconsistency without
      // buying anything.
      runtimeLogger = deps.logger ?? api?.logger ?? null;
      runtimeSnapshot = resolveRuntimeSnapshot(api);
      if (runtimeSnapshot.status === "resolved") {
        const c = runtimeSnapshot.config;
        log("info",
          "llm-grounded runtime config resolved " +
            `source=${runtimeSnapshot.source} ` +
            `evidenceCaptureEnabled=${Boolean(c.evidenceCaptureEnabled)} ` +
            `behaviorEpoch=${c.behaviorEpoch} ` +
            `telemetryDir=${c.telemetryDir} ` +
            `evidenceCaptureDir=${c.evidenceCaptureDir}`,
        );
      } else {
        // High severity and once per process. This is the diagnostic whose
        // absence made the previous failure cost an hour of probing.
        log("error",
          "llm-grounded runtime config unavailable; evidence capture and overlays degraded " +
            `reason=${runtimeSnapshot.reason}` +
            (runtimeSnapshot.detail ? ` detail=${runtimeSnapshot.detail}` : ""),
        );
        unresolvedReported = true;
      }

      readRuntimeConfig = () => {
        try {
          return api.runtime?.config?.current?.() ?? api.config;
        } catch {
          return api.config;
        }
      };
      // Typed hook contexts do not carry pluginConfig in OpenClaw 2026.7.1.
      // Seed from the registration-owned config, then refresh from the live
      // runtime snapshot on every hook invocation.
      lastCfg = resolveToolConfig(
        {
          pluginConfig: api.pluginConfig,
          runtimeConfig: readRuntimeConfig(),
        },
        lastCfg,
      );
      api.on("before_prompt_build", handlers.before_prompt_build, { priority: 60 });
      api.on("before_tool_call", handlers.before_tool_call, { priority: 60 });
      api.on("after_tool_call", handlers.after_tool_call, { priority: 60 });
      // Telemetry wraps the handler rather than editing its several exit
      // paths: a record must be written on every terminal outcome, and a new
      // early return added later would silently stop logging otherwise.
      api.on(
        "before_agent_finalize",
        async (event, ctx) => {
          noteDraft(ctx, event);
          const result = await handlers.before_agent_finalize(event, ctx);
          // Telemetry is not written here. Finalize resolves what *should*
          // ship, but delivery happens afterwards, so a record written now
          // could only ever claim a resolved intention. The turn is recorded
          // from `agent_end`, once, with the text a delivery lane actually
          // observed. The finalize event is stashed because it is the only
          // place carrying the draft and the model id.
          if (result?.action !== "revise") {
            const key = turnKey(ctx, event);
            const entry = store?.get?.(key);
            if (entry) entry.finalizeEvent = event;
          }
          return result;
        },
        { priority: 60 },
      );
      api.on("before_message_write", handlers.before_message_write, { priority: 60 });
      api.on("agent_end", handlers.agent_end, { priority: 60 });
      // Delivery gates run last so a higher-priority plugin cannot ship an
      // unverified draft past them.
      api.on("reply_payload_sending", handlers.reply_payload_sending, { priority: -100 });
      api.on("message_sending", handlers.message_sending, { priority: -100 });

      // Retrieval precedence, on the supported async pre-model seam.
      //
      // A committed fact record does not win on its own: wiki_search and
      // wiki_get return whatever the vault says, and a stale synthesis
      // paragraph reads exactly as authoritative to the model as the record
      // does. When materialization was unsafe the prose was deliberately left
      // alone, so this is the designed steady state of needsRematerialization.
      //
      // This must run *before the model consumes the result*, and it must be
      // able to await a file read. `tool_result_persist` satisfies neither: it
      // is transcript persistence, after the fact, and its runner discards a
      // Promise outright. Agent tool-result middleware is the seam that does.
      api.registerAgentToolResultMiddleware?.(
        async (event, ctx) => {
          if (!middlewareSeen) {
            middlewareSeen = true;
            // One line, once per process. It answers the question that took an
            // hour to answer by inference: is this seam invoked at all?
            log("info",
              `llm-grounded tool-result middleware invoked (first call) tool=${event?.toolName} ` +
                `hasSessionKey=${Boolean(ctx?.sessionKey ?? event?.sessionKey)} ` +
                `hasRunId=${Boolean(ctx?.runId ?? event?.runId)} ` +
                `agentId=${ctx?.agentId ?? "none"}`);
          }
          const snapshot = middlewareSnapshot();
          const boundCall = store?.peekToolCall?.(event?.toolCallId) ?? null;
          const sessionKey = ctx?.sessionKey ?? event?.sessionKey ?? boundCall?.sessionKey ?? null;
          const key = {
            runId: ctx?.runId ?? event?.runId ?? boundCall?.runId,
            sessionKey: ctx?.sessionKey ?? event?.sessionKey ?? boundCall?.sessionKey,
            sessionId: event?.sessionId ?? ctx?.sessionId ?? boundCall?.sessionId,
          };

          if (snapshot.status !== "resolved") {
            // Both middlewares degrade together and both say so. Leaving one
            // silently disabled while repairing the other is how this defect
            // survived a deployment.
            store?.noteRuntimeConfigUnresolved?.(key, snapshot.reason);
            return undefined;
          }
          const cfg = snapshot.config;

          // The effective result: what the model will actually read. Starts as
          // what the tool returned and is replaced only by a trusted overlay.
          let effective = event?.result;
          let overlaid = null;
          const transformsApplied = [];

          if (EVIDENCE_TOOLS.includes(event?.toolName)) {
            // Newer runtimes may provide agentId directly. OpenClaw 2026.7.1
            // does not, so accept only a call id previously authorized by the
            // trusted before_tool_call hook and consume it exactly once.
            const contextAuthorizes =
              typeof ctx?.agentId === "string" && factsApplyToAgent(cfg, ctx.agentId);
            const callAuthorizes = overlayCalls.delete(event?.toolCallId);
            if (contextAuthorizes || callAuthorizes) {
              const loaded = await ensureOverlay(cfg).load();
              // A correction the vault refused is still true for this
              // conversation. The session layer wins on conflict: it exists
              // only because the durable record is the thing that is wrong.
              const merged = sessionKey
                ? mergeOverlays(loaded, sessionOverlay.snapshot(sessionKey))
                : loaded;
              const applied = overlayToolResult(merged, effective);
              if (applied) {
                effective = applied.result;
                overlaid = applied.result;
                transformsApplied.push("durable_fact_overlay");
                if (sessionKey && sessionOverlay.active(sessionKey)) {
                  transformsApplied.push("session_fact_overlay");
                }
                store?.noteOverlayApplied?.(key);
                log("debug", 
                  `llmGrounded: overlaid ${applied.conflicts.length} authoritative fact(s) on ${event.toolName}`,
                );
              }
            }
          }

          // Capture what the model will read, not what the tool first said. A
          // pre-overlay excerpt would be the wrong thing to check a claim
          // against later: the overlay exists precisely because the raw result
          // was stale.
          await captureToolEvidence(cfg, event, ctx, effective, transformsApplied);

          // Returned unchanged unless an overlay rewrote it. Capture is an
          // observer and must never be able to alter a tool result.
          return overlaid ? { result: overlaid } : undefined;
        },
        // Declared in openclaw.plugin.json as contracts.agentToolResultMiddleware.
        // Registration is refused without it, and refused again unless the
        // plugin is explicitly enabled in config — both are true of the staged
        // patch, which sets plugins.entries.llmGrounded.enabled: true.
        { runtimes: ["openclaw"] },
      );

      // The tool is registered as a factory so exposure is decided per run,
      // from the runtime's own trusted context, rather than being a static
      // capability of the plugin. Returning null keeps it out of the model's
      // tool list entirely for anyone who must not have it — an unrelated
      // agent, or a group/channel sender who is not the owner.
      api.registerTool?.(
        (toolCtx) => {
          const cfg = resolveToolConfig(toolCtx, lastCfg);
          const agentAllowed = factsApplyToAgent(cfg, toolCtx?.agentId);
          const direct = isDirectOwnerSession(toolCtx?.sessionKey, toolCtx, cfg);
          if (!agentAllowed) return null;
          if (!isFactOperatorAuthorized(toolCtx, direct)) return null;
          // Owner authentication is not enough on its own: it stays true when
          // the operator speaks in a group or a channel. `execute` re-checks this,
          // but exposure has to be direct-only as well — a tool the model can
          // see in a shared conversation is a tool it will try to use there,
          // and the refusal would arrive as a visible failure rather than the
          // tool simply not existing.
          if (!direct.ok) return null;
          const s = ensureStore(cfg);
          return createFactTool({
            cfg,
            store: s,
            ctx: toolCtx,
            logger: pluginLogger,
            deps: {
              ...deps.factDeps,
              llm: deps.factDeps?.llm ?? api?.runtime?.llm,
              overlay: deps.factDeps?.overlay ?? ensureOverlay(cfg),
              sessionOverlay,
            },
          });
        },
        { name: FACT_TOOL_NAME, optional: true },
      );
    },
  };
}

/** A tool result that reports its own failure counts as a failure. */
export function isErrorResult(result) {
  if (!result || typeof result !== "object") return false;
  if (result.isError === true) return true;
  const content = Array.isArray(result.content) ? result.content : [];
  return content.some((part) => part && typeof part === "object" && part.isError === true);
}

/** Remove anything that could carry an unverified claim past the text gate. */
export function stripUnverifiable(payload) {
  const {
    mediaUrl: _mediaUrl,
    mediaUrls: _mediaUrls,
    presentation: _presentation,
    interactive: _interactive,
    spokenText: _spokenText,
    btw: _btw,
    ...rest
  } = payload ?? {};
  return rest;
}

const plugin = createPlugin();

export default plugin;
