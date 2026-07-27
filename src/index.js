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
  FACT_FAIL_CLOSED_TEXT,
  FACT_RULE,
  FAIL_CLOSED_TEXT,
  factRevisionInstruction,
  isFactFailClosedText,
  isFailClosedText,
  requirementText,
  revisionInstruction,
  SELF_DESCRIPTION_RULE,
  VOICE_CODA,
} from "./contract.js";
import { buildEvidence, pruneEvidence, writeEvidence } from "./evidence.js";
import { detectFactStatement } from "./facts-detect.js";
import { createOverlayReader, overlayToolResult } from "./facts-overlay.js";
import {
  createFactTool,
  FACT_TOOL_NAME,
  isDirectOwnerSession,
  isFactOperatorAuthorized,
} from "./facts-tool.js";
import { createGroundingStore, isReleasable } from "./state.js";
import { assessVoice } from "./voice.js";
import { readFileSync } from "node:fs";
import { behaviorIdentity, buildTurnRecord, pruneTurns, writeTurn } from "./telemetry.js";
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
  function middlewareConfig(api) {
    return lastCfg ?? resolveToolConfig({ runtimeConfig: api?.config }, null);
  }

  function ensureOverlay(cfg) {
    if (!overlay) {
      overlay =
        deps.overlayReader ??
        createOverlayReader({ vaultPath: cfg.vaultPath, logger: deps.logger });
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

  const handlers = {
    async before_prompt_build(event, ctx) {
      const cfg = hookConfig(ctx);
      if (!appliesToAgent(cfg, ctx?.agentId)) return;
      const s = ensureStore(cfg);
      const prompt = event?.prompt ?? "";
      const key = { runId: ctx?.runId, sessionKey: ctx?.sessionKey };
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
        // Phase 0: record the signals this turn tripped, alongside the verdict.
        // Read-only — describeFeatures never influences the decision.
        telemetryFeatures.set(key.runId ?? key.sessionKey, {
          features: describeFeatures(userTurn),
          startedAt: Date.now(),
        });
        s.begin({
          runId: key.runId,
          sessionKey: key.sessionKey,
          // Only a hard trigger creates an obligation. An advisory turn is
          // stored as kind:null, which makes it releasable on arrival — no
          // requirement, no revision, and structurally no route to
          // fail-closed. That is the whole of Phase 1A in one line.
          // web/memory only. A correction trigger deliberately does not become
          // a tier: binding it to "memory" would compel a search to answer,
          // which is the conflation this design exists to avoid.
          kind: hard.kind === "web" || hard.kind === "memory" ? hard.kind : null,
          correction: verdict.correction,
          reason: verdict.reason,
          turnNonce: nonce,
          userMessage: userTurn,
          prevAssistant,
          fact,
          factTransactionAllowed,
        });
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
        telemetryPolicy.set(key.runId ?? key.sessionKey, {
          policyMode: advisory ? "advisory" : "binding",
          hardTrigger: hard.kind,
          hardReason: hard.reason,
          correctionScope: hard.correctionScope ?? null,
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
      const safety = assessToolSafety(event?.toolName, event?.params);
      if (safety.blocked) {
        const k = telemetryKey(ctx, event);
        if (k) {
          const blocked = telemetryBlocked.get(k) ?? [];
          blocked.push({ tool: event?.toolName, reason: safety.reason });
          telemetryBlocked.set(k, blocked);
        }
        deps.logger?.warn?.(
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
        const entry = store?.get({
          runId: ctx?.runId ?? event?.runId,
          sessionKey: ctx?.sessionKey,
        });
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
        runId: ctx?.runId ?? event?.runId,
        sessionKey: ctx?.sessionKey,
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
      const key = { runId: ctx?.runId ?? event?.runId, sessionKey: ctx?.sessionKey };
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
      const key = { runId: ctx?.runId ?? event?.runId, sessionKey: ctx?.sessionKey ?? event?.sessionKey };
      const entry = store.get(key);
      if (!entry) return;

      const alreadyFailClosed = isFailClosedText(event?.lastAssistantMessage);
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
        await persist(cfg, store.get(key) ?? entry, event, ctx);
        return;
      }

      // A turn that unambiguously stated or corrected a durable fact gets one
      // bounded nudge to record it. If that pass is spent, or the transaction
      // was attempted and failed, the turn must not ship a normal-sounding
      // acknowledgement: "got it, the car is an M2" when nothing was written is
      // a false statement about the state of record, and the operator would believe
      // it. Delivery is replaced with the standard no-mutation sentence.
      const current = store.get(key) ?? entry;
      if (factEnforcementRequired(cfg, current, ctx)) {
        if (factRevisionAvailable(cfg, current)) {
          store.noteFactRevision(key);
          await persist(cfg, store.get(key) ?? entry, event, ctx);
          return factRevisionRequest(current);
        }
        if (!isFactFailClosedText(event?.lastAssistantMessage)) {
          store.markFactFailClosed(key);
          await persist(cfg, store.get(key) ?? entry, event, ctx);
          return factFailureClosureRequest(current);
        }
      }

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
      const entry = store.get({ sessionKey: event?.sessionKey ?? ctx?.sessionKey });
      if (!entry) return;

      const groundingPending = !isReleasable(entry);
      const factPending =
        entry.factTransactionAllowed &&
        entry.factEligible &&
        entry.factUnambiguous &&
        entry.factOutcome?.ok !== true;
      if (!groundingPending && !factPending) return;

      const groundingExhausted = groundingPending && entry.revisions >= cfg.maxRevisions;
      const factExhausted = factPending && entry.factRevisions >= cfg.maxFactRevisions;
      if (groundingExhausted) {
        return {
          message: replaceAssistantText(
            event.message,
            FAIL_CLOSED_TEXT,
          ),
        };
      }
      // Fact failures deliberately get one response-only closure pass so the
      // non-delivery transport (`deliver:false`) receives the same sentence.
      // Do not persist the preceding failed draft; once the latch is set, the
      // closure answer itself is persisted after deterministic normalization.
      if (factExhausted) {
        if (entry.factFailClosed) {
          return { message: replaceAssistantText(event.message, FACT_FAIL_CLOSED_TEXT) };
        }
        return { block: true };
      }
      return { block: true };
    },

    reply_payload_sending(event, ctx) {
      const cfg = hookConfig(ctx);
      if (!store) return;
      const key = {
        runId: event?.runId ?? ctx?.runId,
        sessionKey: event?.sessionKey ?? ctx?.sessionKey,
      };
      const entry = store.get(key);
      if (!entry) return;
      if (!entry.failClosed && !entry.factFailClosed) return;
      const factOnly = !entry.failClosed && entry.factFailClosed;
      const replacement = factOnly ? FACT_FAIL_CLOSED_TEXT : FAIL_CLOSED_TEXT;
      const reason = factOnly
        ? `llmGrounded: durable ${entry.factKind} not recorded`
        : `llmGrounded: ${entry.kind} grounding not verified`;
      // One turn can normalize into several payloads. The replacement line
      // belongs on the first; repeating it once per chunk would be noise.
      if (store.noteFailClosedEmission({ ...key, lane: "payload" }) > 0) {
        return { cancel: true, reason };
      }
      // Media and rich presentation cannot carry a verified claim, so they are
      // dropped rather than relabelled.
      return {
        payload: {
          ...stripUnverifiable(event?.payload ?? {}),
          text: replacement,
        },
        reason,
      };
    },

    message_sending(event, ctx) {
      const cfg = hookConfig(ctx);
      if (!store) return;
      const key = { runId: ctx?.runId, sessionKey: ctx?.sessionKey };
      const entry = store.get(key);
      if (!entry) return;
      if (!entry.failClosed && !entry.factFailClosed) return;
      const factOnly = !entry.failClosed && entry.factFailClosed;
      if (store.noteFailClosedEmission({ ...key, lane: "message" }) > 0) {
        return {
          cancel: true,
          cancelReason: factOnly
            ? `llmGrounded: durable ${entry.factKind} not recorded`
            : `llmGrounded: ${entry.kind} grounding not verified`,
        };
      }
      return {
        content: factOnly ? FACT_FAIL_CLOSED_TEXT : FAIL_CLOSED_TEXT,
        metadata: {
          llmGrounded: {
            failClosed: !factOnly,
            factFailClosed: entry.factFailClosed,
            grounding: entry.kind,
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
      const entry = store.get({
        runId: ctx?.runId ?? event?.runId,
        sessionKey: ctx?.sessionKey,
      });
      if (!entry) {
        // The only way a covered agent finishes a turn with no state is that
        // `before_prompt_build` never ran — which happens when
        // `hooks.allowPromptInjection` is false for this plugin. That is a
        // silent fail-open, so say so rather than letting it pass unnoticed.
        deps.logger?.warn?.(
          "llm-grounded: no classification for this turn; " +
            "check plugins.entries.llmGrounded.hooks.allowPromptInjection",
        );
        return;
      }
      // State is not released here: delivery hooks can still fire afterwards on
      // gateway paths, and they must still see the fail-closed latch. The TTL
      // reclaims it.
      await persist(cfg, entry, event, ctx);
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
   * Force the deterministic no-mutation sentence through non-delivery
   * transports (notably `openclaw agent --json`). Delivery hooks replace the
   * payload themselves, but `deliver:false` has no payload hook to intercept.
   * This pass cannot call the transaction or CASE again; it only renders the
   * already-latched safety outcome.
   */
  function factFailureClosureRequest(entry) {
    const instruction = [
      "The vault fact transaction did not commit. Do not call any tool and do not claim the fact was saved.",
      `Reply with exactly: ${FACT_FAIL_CLOSED_TEXT}`,
    ].join(" ");
    return {
      action: "revise",
      reason: instruction,
      retry: {
        instruction,
        idempotencyKey: `llm-grounded-fact-closure:${entry.runId ?? entry.sessionKey}`,
        maxAttempts: 1,
      },
    };
  }

  // Phase 0 telemetry. Held outside the grounding store so a logging change
  // can never alter contract state, and so a missing record degrades to "no
  // telemetry" rather than a failed turn.
  const telemetryPolicy = new Map();
  const telemetryBlocked = new Map();

  /** Grounding obligation for a turn: hard triggers only. */
  function hardTriggerKind(turn) {
    const hard = hardTrigger(turn);
    return hard.kind === "web" || hard.kind === "memory" ? hard.kind : null;
  }

  const telemetryFeatures = new Map();
  const telemetryDrafts = new Map();
  const telemetryTools = new Map();

  function telemetryKey(ctx, event) {
    return ctx?.runId ?? event?.runId ?? ctx?.sessionKey ?? event?.sessionKey ?? null;
  }

  function noteDraft(ctx, event) {
    const k = telemetryKey(ctx, event);
    if (!k) return;
    const text = event?.lastAssistantMessage;
    if (typeof text !== "string" || !text.trim()) return;
    const list = telemetryDrafts.get(k) ?? [];
    // Only distinct passes are interesting; finalize can fire more than once
    // with identical text.
    if (list[list.length - 1] !== text) list.push(text);
    telemetryDrafts.set(k, list);
  }

  function noteToolCall(ctx, event, ok) {
    const k = telemetryKey(ctx, event);
    if (!k) return;
    const list = telemetryTools.get(k) ?? [];
    list.push({
      name: event?.toolName ?? null,
      ok: Boolean(ok),
      params: sanitizeParams(event?.params),
    });
    telemetryTools.set(k, list);
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

  async function recordTurn(cfg, entry, event, ctx) {
    if (!cfg?.telemetryDir) return;
    const k = telemetryKey(ctx, event);
    const meta = k ? telemetryFeatures.get(k) : null;
    const decorated = {
      ...entry,
      telemetry: {
        features: meta?.features ?? {},
        drafts: k ? telemetryDrafts.get(k) ?? [] : [],
        tools: k ? telemetryTools.get(k) ?? [] : [],
      },
    };
    const record = buildTurnRecord(decorated, {
      pluginVersion: PLUGIN_VERSION,
      identity: await behaviorIdentity(cfg, { model: ctx?.modelId ?? event?.modelId }),
      policy: k ? telemetryPolicy.get(k) ?? null : null,
      blockedTools: k ? telemetryBlocked.get(k) ?? [] : [],
      // The latch is only set when the plugin substitutes the line itself. When
      // the model emits it directly — which the requirement text asks it to —
      // the handler takes the alreadyFailClosed path and never latches, so the
      // entry says false on a turn that plainly failed closed. Detect the
      // outcome from what shipped, not from how it got there.
      failedClosed:
        Boolean(entry?.failClosed) || isFailClosedText(event?.lastAssistantMessage),
      // A session key prefixed "synthetic-" marks a turn produced by testing.
      // Marking beats an external exclusion list: the flag travels with the
      // record, so a corpus copied elsewhere stays correctly labelled.
      ...synthetic(event, ctx),
      turnId: k,
      sessionId: event?.sessionId ?? ctx?.sessionId ?? ctx?.sessionKey,
      agentId: ctx?.agentId,
      final: event?.lastAssistantMessage,
      model: ctx?.modelId ?? event?.modelId ?? null,
      latencyMs: meta?.startedAt ? Date.now() - meta.startedAt : null,
      now: Date.now(),
    });
    await writeTurn(cfg.telemetryDir, record, deps.logger);
    await pruneTurns(cfg.telemetryDir, cfg.telemetryRetentionDays, deps.logger);
    if (k) {
      telemetryFeatures.delete(k);
      telemetryDrafts.delete(k);
      telemetryTools.delete(k);
      telemetryPolicy.delete(k);
      telemetryBlocked.delete(k);
    }
  }

  async function persist(cfg, entry, event, ctx) {
    const sessionId = event?.sessionId ?? ctx?.sessionId ?? ctx?.sessionKey;
    if (!sessionId) return;
    const record = buildEvidence(entry, {
      sessionId,
      agentId: ctx?.agentId,
      now: now(),
    });
    await write(cfg.evidenceDir, sessionId, record, deps.logger);
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
          // A revision is not the end of the turn — the next pass logs it.
          if (result?.action !== "revise") {
            const cfg = hookConfig(ctx);
            const key = {
              runId: ctx?.runId ?? event?.runId,
              sessionKey: ctx?.sessionKey ?? event?.sessionKey,
            };
            const entry = store?.get?.(key);
            if (entry) await recordTurn(cfg, entry, event, ctx);
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
          if (!EVIDENCE_TOOLS.includes(event?.toolName)) return;
          const cfg = middlewareConfig(api);
          // Newer runtimes may provide agentId directly. OpenClaw 2026.7.1
          // does not, so accept only a call id previously authorized by the
          // trusted before_tool_call hook and consume it exactly once.
          const contextAuthorizes =
            typeof ctx?.agentId === "string" && factsApplyToAgent(cfg, ctx.agentId);
          const callAuthorizes = overlayCalls.delete(event?.toolCallId);
          if (!contextAuthorizes && !callAuthorizes) return;
          const loaded = await ensureOverlay(cfg).load();
          const applied = overlayToolResult(loaded, event?.result);
          if (!applied) return;
          deps.logger?.debug?.(
            `llmGrounded: overlaid ${applied.conflicts.length} authoritative fact(s) on ${event.toolName}`,
          );
          return { result: applied.result };
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
            logger: deps.logger,
            deps: {
              ...deps.factDeps,
              llm: deps.factDeps?.llm ?? api?.runtime?.llm,
              overlay: deps.factDeps?.overlay ?? ensureOverlay(cfg),
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
