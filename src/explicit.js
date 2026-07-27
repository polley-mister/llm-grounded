import { resolveCorrection } from "./corrections.js";

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
 * The only decision that may compel a tool.
 *
 * @returns {{kind: "web"|"memory"|"arithmetic"|"admin"|null, reason: string}}
 */
export function hardTrigger(message, context = {}) {
  const text = String(message ?? "").trim();
  if (!text) return { kind: null, reason: "" };

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
  return { kind: null, reason: "" };
}

/**
 * Non-binding hint derived from the legacy verdict.
 *
 * Offered to the model as information, never as an obligation. It cannot
 * compel a tool, reject a response, consume a revision, or fail closed.
 */
export function advisoryText(legacyKind) {
  if (legacyKind === "web") {
    return "This may depend on current external information. Use web search if you need it.";
  }
  if (legacyKind === "memory") {
    return "This may depend on something the operator told you before. Check memory if you need it.";
  }
  return "";
}
