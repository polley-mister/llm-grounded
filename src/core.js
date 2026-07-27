// llm-grounded — the host-independent core.
//
// Nothing in this file, or anything it imports, knows what an OpenClaw hook is,
// opens a network socket, or calls a model. `tests/core.test.mjs` asserts all
// three structurally, so the claim stays true rather than merely being stated.
//
// The *decision* path is entirely synchronous code over strings and plain
// objects. The recorders at the bottom of this file are the one exception: they
// are async and they write JSONL to disk. They are exported here because they
// are host-independent and a corpus is most of the value — but they are opt-in,
// and every gate works without ever calling them.
//
// Not exported, and not part of the core: `./case-audit.js` (makes a model
// call), `./facts-tool.js`, `./facts-overlay.js`, `./vault-txn.js` (assume an
// external CLI and a durable store). Import those directly if you want them.
//
// `src/index.js` is the OpenClaw adapter. It is one consumer of this surface,
// not a layer beneath it — if you are integrating into another stack, import
// from here and write the equivalent ~200 lines of adapter for your own
// framework. See docs/INTEGRATION.md.
//
// The division that matters: this module decides *what a turn obliges* and
// *whether a reply satisfies it*. It never decides when to call a model, how to
// retry, or where state lives. Those are the host's job, because they are the
// things every host does differently.

// ---------------------------------------------------------------------------
// Policy — what this turn is allowed to compel
// ---------------------------------------------------------------------------

export {
  // The hard triggers. This is the only function that may create an
  // obligation: an explicit tool request, a parseable arithmetic expression,
  // an admin command, or a correction scoped to a fact write. Returns
  // {kind: null} for everything else, which is the permissive default.
  hardTrigger,
  // The advisory hint offered for a turn with no hard trigger. Safe to ignore;
  // by construction it cannot fail a turn closed.
  advisoryText,
  normalizeArithmetic,
  isCompleteArithmetic,
} from "./explicit.js";

export {
  // The legacy classifier. Retained deliberately and kept running with no
  // authority: its verdict is a *measurement*, so a false-positive rate is
  // observable rather than theoretical. Never promote a turn on its output.
  classifyGrounding,
  // Read-only: which patterns a turn tripped. Never influences a decision.
  // Log it, or old traffic cannot be re-scored when a rule changes.
  describeFeatures,
  // Installation vocabulary. Both default to empty; call these at startup.
  configureAgentNames,
  configurePersonalTerms,
  personalTermCount,
  // Individual signals, exported because they are useful on their own.
  isAcknowledgement,
  isSelfSettingsQuestion,
  isSelfReferenceQuestion,
  isNegatedAssertion,
  hasNamedExternalEntity,
  hasLowercaseExternalReference,
  stripVocative,
  stripChannelContext,
  SATISFYING_TOOLS,
} from "./classify.js";

// ---------------------------------------------------------------------------
// Contract — the exact text handed to the model
// ---------------------------------------------------------------------------

export {
  requirementText,
  revisionInstruction,
  factRevisionInstruction,
  persistenceRevisionInstruction,
  isFailClosedText,
  isFactFailClosedText,
  CORRECTION_RULE,
  FACT_RULE,
  SELF_DESCRIPTION_RULE,
  VOICE_CODA,
  FAIL_CLOSED_TEXT,
  FACT_FAIL_CLOSED_TEXT,
} from "./contract.js";

// ---------------------------------------------------------------------------
// Gates — each one answers a question about a single turn
// ---------------------------------------------------------------------------

export {
  // Is this proposed tool call hunting for a private individual?
  assessToolSafety,
  blockMessage,
} from "./sensitive.js";

export {
  // Is this reply the shape the operator asked for?
  assessVoice,
  revisionText as voiceRevisionText,
  depthWasRequested,
  DEFAULT_MAX_WORDS,
} from "./voice.js";

export {
  // Did the operator just state or correct a durable fact? Excludes questions,
  // imperatives, quotations, hypotheticals and hedges before anything else
  // runs, which is what keeps a playful "what if I told you..." from ever
  // becoming durable.
  detectFactStatement,
  hasValueToken,
  isMostlyQuotation,
} from "./facts-detect.js";

export {
  // A correction is a scope, not a tier. Resolves who is authoritative for the
  // corrected fact; never compels retrieval to answer.
  resolveCorrection,
} from "./corrections.js";

export {
  // Claim extraction: read what a draft asserts rather than predict it from the
  // turn. Offline in this release; see docs/claim-verification.md.
  extractClaims,
  verificationTargets,
  segment as segmentDraft,
  checkAtomicity,
  CLAIM_TYPES,
  MODALITIES,
  EVIDENCE_KINDS,
  ABSTENTION_REASONS,
  SCHEMA_VERSION,
  PROMPT_VERSION,
} from "./claims.js";

export {
  // The single terminal decision: what this turn actually delivers. Resolved
  // once and rendered by every delivery lane, so they cannot diverge.
  resolveDelivery,
  selectTerminalObservation,
} from "./delivery.js";

export {
  // Two independent outcomes for a fact turn: did the correction land for this
  // conversation, and did it reach durable storage. Conflating them is what
  // made a failed write discard an otherwise good answer.
  resolveOutcomes,
  persistenceNote,
  composeWithNote,
  claimsPersistence,
  safeFallbackText,
} from "./persistence.js";

export {
  // Holds an accepted correction whose durable write failed, so the next turn
  // in the same session does not read the stale value back.
  createSessionOverlay,
  mergeOverlays,
} from "./session-overlay.js";

export {
  normalizeForMatch,
  tokenize,
  valuesEquivalent,
  statesValue,
  looksSecret,
} from "./values.js";

// ---------------------------------------------------------------------------
// State and configuration
// ---------------------------------------------------------------------------

export {
  // In-memory per-run obligation store. Pure; holds no host types.
  createGroundingStore,
  isReleasable,
  queryIsUnrelated,
  excerptFromToolResult,
} from "./state.js";

export {
  parseConfig,
  appliesToAgent,
  factsApplyToAgent,
  DEFAULTS,
  CONFIG_JSON_SCHEMA,
} from "./config.js";

export { stateHome, varDir } from "./paths.js";

export {
  // Human, heartbeat, scheduled automation, system or test. Resolved from host
  // metadata only; turn content is never consulted.
  resolveTrafficClass,
  isTrafficClass,
  TRAFFIC_CLASSES,
} from "./traffic.js";

// ---------------------------------------------------------------------------
// Recorders — optional, async, and the only things here that touch disk
// ---------------------------------------------------------------------------
//
// One JSONL record per turn is what makes a false-positive rate observable
// instead of theoretical, so this is worth wiring up even on a host that skips
// every other part. Both writers prune on their own bound: nothing here grows
// without a limit.

export {
  // The Phase 0 turn logger: verdict, matched features, tools called, the
  // pre-revision draft, the delivered text, which gates fired, latency, model.
  buildTurnRecord,
  writeTurn,
  pruneTurns,
  // Hashes of the prompt/ruleset/config surfaces in force. Record it, or the
  // corpus cannot tell you which code produced it.
  behaviorIdentity,
  resetFingerprint,
} from "./telemetry.js";

export {
  buildEvidence,
  writeEvidence,
  pruneEvidence,
  evidenceFileName,
  EVIDENCE_VERSION,
} from "./evidence.js";
