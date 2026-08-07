import { resolveCorrection } from "./corrections.js";
import { stripVocative } from "./classify.js";

// ---------------------------------------------------------------------------
// Hard triggers: the only inputs that may compel a capability.
//
// This file exists so the demote-only invariant is unconditionally true in the
// file that declares it. classify.js may say a turn *resembles* a web
// question; it can no longer make one mandatory. Only the narrow, provable
// cases below can, and they are all things the operator said outright.
//
// Baseline evidence for the split, over 28 ordinary turns under the old
// binding classifier:
//   61% of turns had a tool compelled
//   29% ended fail-closed
//   43% were routed to the web tier by the proper-noun heuristic alone
// with "Big fighting words" searching storage capacity and "Dang the agent"
// searching sleep habits. The heuristics were not close to right; they were
// deciding jurisdiction on capitalisation.
// ---------------------------------------------------------------------------

/** "Search the web", "look this up online", "find me a current source". */
const EXPLICIT_WEB = [
  /\b(?:search|google|look\s*up|look\s+this\s+up|check)\b[^.?!]{0,30}\b(?:the\s+)?(?:web|internet|online|google)\b/i,
  /\b(?:web\s*search|google\s+it|search\s+online|search\s+the\s+web)\b/i,
  /\bfind\b[^.?!]{0,20}\b(?:a\s+)?(?:current\s+)?(?:source|citation|reference|article)\b/i,
  /\blook\s+it\s+up\b/i,
];

/**
 * Topics whose answer changes faster than any prompt file can hold, and which
 * nothing already in context can answer.
 *
 * Deliberately far narrower than classify.js's CURRENT_INFO. That list exists
 * to *advise* the web tier, so it can afford soft signals — "today",
 * "recently", "latest" — that also appear in questions about the agent's own
 * state. Binding on those would compel a search for "what did you change
 * today?", which SOUL.md and the session already answer. Only topics with no
 * in-context answer belong here.
 *
 * This is the one tier that fires on a topic rather than on an instruction the
 * operator gave outright, and it is here rather than in classify.js so the
 * demote-only invariant still holds where it is declared: classify.js gained
 * no power, this file took on one more narrow, enumerated case.
 *
 * Evidence for adding it: a live turn asked "How's the weather looking like
 * for you, TARS?". classify.js correctly returned current-information, but
 * that tier only ever produced advice, so the turn resolved advisory/pass and
 * the agent invented a forecast — cold, dry, visibility acceptable — for a
 * location it does not know.
 */
const BINDING_CURRENT_TOPICS = [
  /\b(?:weather|forecast|temperature|wind\s*chill|humidity)\b/i,
  /\b(?:stock|share)\s+price\b|\bmarket\s+cap\b|\bexchange\s+rate\b|\bprice\s+of\b/i,
  /\bhow\s+much\s+(?:does|do|is|are)\b[^?]{0,40}\bcost\b/i,
  /\b(?:final\s+score|score\s+of|standings|who\s+won)\b/i,
  /\b(?:news|headlines?)\b/i,
  /\b(?:release\s+date|changelog)\b/i,
];

/**
 * Frames that ask for invention or transformation rather than fact.
 *
 * A poem about the weather needs no forecast. Without this guard the topic
 * tier would compel retrieval for work the agent can complete alone, which is
 * the exact failure the 61%-compelled baseline above records.
 */
const NON_FACTUAL_FRAMES = [
  /\b(?:write|compose|draft|invent|make\s+up|come\s+up\s+with|imagine|pretend|role-?play)\b/i,
  /\b(?:translate|rewrite|reword|rephrase|paraphrase|summari[sz]e)\b/i,
  /\b(?:hypothetically|suppose|what\s+if)\b/i,
];

/**
 * Interrogative shape. The topic tier binds only on an actual question, so a
 * remark that mentions a topic ("the weather was miserable last week") states
 * the operator's own world rather than asking the agent to assert anything.
 */
const QUESTION_SHAPE = [
  /\?\s*$/,
  /^\s*(?:what|what'?s|how|how'?s|when|where|which|who|whose|is|are|was|were|do|does|did|can|could|will|would|has|have|any)\b/i,
  /\b(?:tell\s+me|do\s+you\s+know)\b/i,
];

/** "Check your memory", "what did I previously tell you", "search the vault". */
const EXPLICIT_MEMORY = [
  /\b(?:check|search|look\s+in|consult)\b[^.?!]{0,24}\b(?:your\s+)?(?:memory|memories|vault|notes|wiki)\b/i,
  /\bwhat\s+did\s+I\s+(?:previously\s+)?(?:tell|say\s+to)\s+you\b/i,
  /\bremember\s+what\s+I\s+(?:told|said)\b/i,
];

/** Plugin, daemon and direct tool syntax. */
const ADMIN_COMMANDS = [
  /^\s*\//, // slash commands
  /\b(?:openclaw|systemctl|docker)\s+\w+/i,
  /\b(?:restart|reload|enable|disable)\s+the\s+(?:daemon|gateway|plugin|service)\b/i,
  /\bset\s+(?:humor|humour|honesty|verbosity|initiative)\s+to\s+\d{1,3}\b/i,
];

/**
 * Normalise the operator characters people actually type.
 *
 * The baseline caught this: "What is 17 × 24?" did not match the arithmetic
 * rule because × is not *, so it fell through to no-external-premise. The
 * answer was right by accident. Arithmetic is about to become a hard trigger,
 * where failing to fire is a silent gap rather than a lucky escape.
 */
export function normalizeArithmetic(text) {
  return String(text ?? "")
    .normalize("NFKC")
    .replace(/[×✕✖·⋅]/g, "*")
    .replace(/[÷]/g, "/")
    .replace(/[−–—]/g, "-")
    .replace(/[（]/g, "(")
    .replace(/[）]/g, ")");
}

/** Strip the phrasing that wraps a calculation request. */
const CALC_PREFIX =
  /^\s*(?:what(?:'s| is)|calculate|compute|solve|evaluate|eval|work\s+out|how\s+much\s+is)\s+/i;

/**
 * True only for a complete, self-contained arithmetic expression.
 *
 * The presence of an operator decides nothing. "I bought 3 x 4 boards" and
 * "the dimensions are 10 x 20 x 30 mm" contain operators and are not
 * calculation requests; "(16 + 8) / 3" is one and contains no verb at all.
 * The parser decides.
 */
export function isCompleteArithmetic(text) {
  let s = normalizeArithmetic(text).trim();
  s = s.replace(/[?.!]+\s*$/, "");
  s = s.replace(CALC_PREFIX, "");
  if (!s) return false;

  // Nothing but numbers, operators, decimal points and balanced parentheses.
  if (!/^[-+]?[\d\s+\-*/^%().,]+$/.test(s)) return false;
  if (!/\d/.test(s)) return false;
  if (!/[+\-*/^%]/.test(s)) return false;

  let depth = 0;
  for (const ch of s) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (depth < 0) return false;
  }
  if (depth !== 0) return false;

  // An operator must sit between two operands. This rejects a bare negative
  // number and trailing-operator fragments.
  return /\d\s*[+\-*/^%]\s*[-+(]?\s*\d/.test(s);
}

function matchesAny(patterns, text) {
  return patterns.some((re) => re.test(text));
}

/**
 * The result of a hard-trigger decision.
 *
 * `kind` names what the operator asked for outright. "web" and "memory" are
 * the only retrieval tiers; "arithmetic", "admin" and "correction" bind a
 * scope rather than an obligation to retrieve, so a caller routing on
 * retrieval must test for the two tiers rather than for a non-null kind.
 *
 * The fields below `reason` are populated only for a correction, which is why
 * they are optional. They were previously absent from the published type
 * entirely, so a typed caller could not read the result it actually receives.
 *
 * @typedef {object} HardTrigger
 * @property {"web"|"memory"|"arithmetic"|"admin"|"correction"|null} kind
 * @property {string} reason
 * @property {"fact_commit"} [policyScope] what the correction is allowed to touch
 * @property {string} [correctionScope]
 * @property {string} [evidenceSource] the operator's own assertion, for a correction
 * @property {string|null} [requiredTool] always null: a correction compels no retrieval
 * @property {boolean} [factEnforcementRequired]
 * @property {boolean} [commitPermitted]
 */

/**
 * The only decision that may compel a tool.
 *
 * @param {string} message raw user text for this turn
 * @param {{prevAssistant?: string}} [context] the previous assistant turn, used
 *   only to resolve whether this turn is a correction of it
 * @returns {HardTrigger}
 */
export function hardTrigger(message, context = {}) {
  const raw = String(message ?? "").trim();
  if (!raw) return { kind: null, reason: "" };

  // Address the agent by name and the turn is unchanged in substance, so match
  // against the text with the vocative removed. Without this, "Hey TARS, what
  // is 1 + 1?" resolves to no trigger while "what is 1 + 1?" resolves to
  // arithmetic - the one path that may compel anything, disabled by a
  // greeting. stripVocative lives in classify.js but is pure normalisation and
  // carries no verdict, so it does not weaken the demote-only invariant: this
  // file still owns every decision that binds.
  const stripped = stripVocative(raw).trim();
  const text = stripped || raw;

  if (matchesAny(ADMIN_COMMANDS, text)) return { kind: "admin", reason: "explicit-admin" };

  // A correction binds the persistence path and nothing else. It compels no
  // retrieval: the operator is the authoritative source for their own world, so their
  // assertion is the evidence. Any lookup that follows is to locate the record
  // being superseded, not to believe the new value.
  const correction = resolveCorrection(text, context.prevAssistant);
  if (correction.isCorrection) {
    return {
      kind: "correction",
      reason: correction.reason,
      policyScope: "fact_commit",
      correctionScope: correction.correctionScope,
      evidenceSource: correction.evidenceSource,
      requiredTool: null,
      factEnforcementRequired: correction.factEnforcementRequired,
      commitPermitted: correction.commitPermitted,
    };
  }

  if (isCompleteArithmetic(text)) return { kind: "arithmetic", reason: "complete-expression" };
  if (matchesAny(EXPLICIT_WEB, text)) return { kind: "web", reason: "explicit-web-request" };
  if (matchesAny(EXPLICIT_MEMORY, text)) return { kind: "memory", reason: "explicit-memory-request" };

  // Last, so that an instruction the operator gave outright keeps its own
  // reason. "Check your vault for the forecast" is an explicit memory request
  // that happens to mention a bound topic, and routing it to the web would
  // override the tier they named.
  if (bindsCurrentInformation(text)) {
    return { kind: "web", reason: "current-information-topic" };
  }
  return { kind: null, reason: "" };
}

/**
 * True when a turn asks, as a question, for a fact that only retrieval can
 * supply. Exported so the boundary is testable directly rather than only
 * through the trigger it feeds.
 *
 * @param {string} text vocative-stripped user text
 * @returns {boolean}
 */
export function bindsCurrentInformation(text) {
  const s = String(text ?? "").trim();
  if (!s) return false;
  if (!matchesAny(BINDING_CURRENT_TOPICS, s)) return false;
  if (matchesAny(NON_FACTUAL_FRAMES, s)) return false;
  return matchesAny(QUESTION_SHAPE, s);
}

/**
 * Non-binding hint derived from the legacy verdict.
 *
 * Offered to the model as information, never as an obligation. It cannot
 * compel a tool, reject a response, consume a revision, or fail closed.
 */
export function advisoryText(legacyKind) {
  if (legacyKind === "web") {
    // "Use web search if you need it" left the agent to judge its own need, and
    // it judged wrong: the weather turn took the escape hatch and invented an
    // answer. This still advises rather than binds — the topic tier above is
    // what compels — but it names the only two acceptable outcomes instead of
    // offering answering-from-memory as a third.
    return (
      "This depends on current external information that is not in your context. " +
      "Search the web before answering, or say you do not have it. Do not answer from memory."
    );
  }
  if (legacyKind === "memory") {
    return "This may depend on something the operator told you before. Check memory if you need it.";
  }
  return "";
}
