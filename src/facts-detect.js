// Deterministic detection of durable personal facts and contextual corrections.
//
// No LLM call, no network, no filesystem — same rules as classify.js, and for
// the same reason: whether a turn is even *allowed* to touch the vault must not
// be a model decision.
//
// This answers one narrow question: "is this turn one where the operator stated a
// durable fact about their own world, or corrected one?" It never answers "what
// the fact is". CASE audits the proposal and the Vault Tools writer validates
// it; this file only decides whether the door opens at all.
//
// Everything here fails toward *not eligible*. A missed capture costs one
// missing record. A false positive writes something the operator never said into the
// state of record, which is much worse.

import { isNegatedAssertion, stripChannelContext, stripVocative } from "./classify.js";

/** A turn that asks rather than asserts is never a fact statement. */
const QUESTION_SHAPES = [
  /\?/,
  /^\s*(?:who|what|when|where|why|how|which|whose|is|are|was|were|do|does|did|can|could|should|would|will|have|has|had|am)\b/i,
  /^\s*(?:tell me|remind me|show me|look up|find|search|check)\b/i,
];

/** Hedged statements. Uncertainty is not a durable fact. */
const UNCERTAINTY = [
  /\bi (?:think|believe|guess|assume|suspect|reckon)\b/i,
  /\b(?:i'?m|i am) not (?:sure|certain|positive)\b/i,
  /\bnot (?:sure|certain)\b/i,
  /\b(?:maybe|perhaps|possibly|probably|apparently|supposedly|allegedly)\b/i,
  /\b(?:might|may|could)\s+(?:be|have)\b/i,
  /\biirc\b/i,
  /\bif i (?:recall|remember)\b/i,
  /\bi could be wrong\b/i,
];

/** Counterfactuals and role-play. */
const HYPOTHETICAL = [
  /^\s*(?:if|suppose|imagine|pretend|say)\b/i,
  /\bwhat if\b/i,
  /\bhypothetical(?:ly)?\b/i,
  /\blet'?s say\b/i,
  /\bwould (?:be|have been)\b/i,
  /\bin theory\b/i,
];

/** Humor markers. A joke is not a record. */
const JOKE = [
  /\b(?:jk|j\/k|just kidding|kidding|lol|lmao|rofl|haha+|hehe)\b/i,
  /\bi wish\b/i,
  /\bsarcas(?:m|tic)\b/i,
  /\/s\s*$/,
  /😂|🤣|😜|😉/u,
];

/**
 * Attribution to somebody else. The fact may be true, but it is not the operator
 * stating something about their own world, so it is out of scope for this
 * pipeline.
 */
const THIRD_PARTY = [
  /\b(?:he|she|they|him|her|them|his|their)\s+(?:said|says|told|claims?|thinks?|reckons?)\b/i,
  /\b(?:someone|somebody|a friend|my (?:friend|buddy|coworker|instructor|manager))\s+(?:said|says|told|mentioned)\b/i,
  /\baccording to\b/i,
  /\bi (?:read|heard|saw)\s+(?:that|somewhere|online)\b/i,
  /\bapparently\b/i,
  // Any other attributed assertion — "is what the forum said". First and
  // second person are excluded, because "you said" is how a correction of *our*
  // claim is phrased and "I said" is the operator restating himself.
  /(?<!\b(?:you|i|we)\s)\b(?:said|says|claimed|claims|reported|posted)\b/i,
];

/**
 * Evaluative reactions. "That's a great car." has the exact shape of a
 * contextual correction and asserts no competing fact at all.
 */
const EVALUATIVE = [
  /\b(?:great|nice|cool|awesome|terrible|awful|beautiful|lovely|fine|good|bad|interesting|funny|weird|impressive|sad|amazing|perfect|ugly|boring|clever|smart|stupid)\b/i,
  /\b(?:i (?:like|love|hate|prefer) (?:that|it|this))\b/i,
];

/**
 * A fact value looks like a value: a digit, or a capitalized token that is not
 * merely the first word of the sentence. "an TC20" qualifies; "a great car" does
 * not. Deterministic, cheap, and biased toward refusing.
 */
export function hasValueToken(text) {
  const body = String(text ?? "").replace(
    /^\s*(?:no[,.\s]+|nope[,.\s]+|actually[,.\s]+)?(?:it'?s|it is|it was|that'?s|that is|that was|they'?re|they are|he'?s|she'?s|mine'?s|mine is)\b/i,
    "",
  );
  if (/\d/.test(body)) return true;
  return /\b\p{Lu}[\p{L}\p{N}]*/u.test(body);
}

/** An instruction to do something, not a statement about the world. */
const IMPERATIVE = [
  /^\s*(?:please\s+)?(?:do|don'?t|never|always|remember to|make sure|update|write|set|add|remove|delete|change|fix|run|stop|start|use)\b/i,
  /^\s*remember\s+(?:that\s+)?/i,
];

/**
 * A message that is mostly a quotation is reporting text, not asserting it.
 * Measured by share of characters inside quotes rather than by presence, so an
 * ordinary statement that happens to quote a two-word name still counts.
 */
export function isMostlyQuotation(text) {
  const quoted = [...String(text ?? "").matchAll(/"[^"]*"|“[^”]*”/gu)]
    .reduce((sum, m) => sum + m[0].length, 0);
  const total = String(text ?? "").trim().length;
  return total > 0 && quoted / total >= 0.5;
}

/**
 * First-person durable assertions: the operator telling us something about their own
 * world that is expected to stay true.
 */
const DURABLE_FIRST_PERSON = [
  /\bmy\s+[\w'-]+(?:\s+[\w'-]+){0,3}\s+(?:is|are|was|were|has|have|runs?|uses?|lives?)\b/i,
  /\bi\s+(?:own|drive|run|use|prefer|live in|work at|serve in|study|switched to|moved to|bought|built|named)\b/i,
  /\bi'?m\s+(?:a|an|the|now|currently)\b/i,
  /\bmine (?:is|are)\b/i,
  /\bwe (?:switched|moved|settled on|standardi[sz]ed on|renamed)\b/i,
];

/**
 * Contextual corrections: a short declarative whose subject is a pronoun
 * pointing back at what the assistant just said. "It's an TC20." is the whole
 * acceptance case — it contains no correction vocabulary at all, and is only a
 * correction because of what preceded it.
 */
const CONTEXTUAL_CORRECTION = [
  /^\s*(?:no[,.\s]+|nope[,.\s]+|actually[,.\s]+)?(?:it'?s|it is|it was|that'?s|that is|that was|they'?re|they are|he'?s|she'?s|mine'?s|mine is|hers|his)\b/i,
  /^\s*(?:it'?s|that'?s)\s+(?:actually|really)\b/i,
];

/** Explicit rejections, mirrored from classify.js so both gates agree. */
const EXPLICIT_CORRECTION = [
  /\b(?:that|this|it)(?:'s| is| was) (?:not right|wrong|incorrect|false|untrue|backwards)\b/i,
  /\byou(?:'re| are) wrong\b/i,
  /\byou got (?:that|it) wrong\b/i,
  /^\s*(?:no|nope|wrong|incorrect)\b[\s,.!—-]/i,
  /^\s*actually\b[\s,]/i,
  /\b(?:correction|i think you (?:mean|meant)|check (?:that|it) again)\b/i,
  /\bnot (?:true|correct|right)\b/i,
];

function matchesAny(patterns, text) {
  return patterns.some((re) => re.test(text));
}

/** Longest bound on a fact statement. Essays are not single durable facts. */
const MAX_STATEMENT_CHARS = 600;

/**
 * Classify one turn for the fact-transaction pipeline.
 *
 * @param {string} userMessage raw operator text for this turn
 * @param {string|null|undefined} prevAssistant the assistant's previous message
 * @returns {{eligible: boolean, kind: "create"|"correct"|null, reason: string,
 *            unambiguous: boolean}}
 */
export function detectFactStatement(userMessage, prevAssistant) {
  const raw = String(userMessage ?? "");
  const text = stripVocative(stripChannelContext(raw)).trim();
  const no = (reason) => ({ eligible: false, kind: null, reason, unambiguous: false });

  if (!text) return no("empty");
  if (text.length > MAX_STATEMENT_CHARS) return no("too-long");

  // Exclusions first, and unconditionally. Every one of these can co-occur with
  // a fact-shaped sentence, and when they do the answer is still "no".
  if (matchesAny(QUESTION_SHAPES, text)) return no("question");
  if (matchesAny(IMPERATIVE, text)) return no("instruction");
  if (isMostlyQuotation(text)) return no("quotation");
  if (matchesAny(HYPOTHETICAL, text)) return no("hypothetical");
  if (matchesAny(UNCERTAINTY, text)) return no("uncertain");
  if (matchesAny(JOKE, text)) return no("joke");
  if (matchesAny(THIRD_PARTY, text)) return no("third-party");

  const hasPrior = typeof prevAssistant === "string" && prevAssistant.trim().length > 0;
  const explicitCorrection = matchesAny(EXPLICIT_CORRECTION, text);
  const negatedAssertion = isNegatedAssertion(text);
  // A bare "it's …" is a correction only when it actually names a competing
  // value. Without that guard, every "that's nice" would open a transaction.
  const contextualShape = matchesAny(CONTEXTUAL_CORRECTION, text);
  if (contextualShape && !explicitCorrection && matchesAny(EVALUATIVE, text)) return no("opinion");
  const contextualCorrection = contextualShape && hasValueToken(text);

  if (explicitCorrection || negatedAssertion || contextualCorrection) {
    // A contextual shorthand ("It's an TC20") needs the preceding answer to
    // supply its subject and old value. A self-contained rejection
    // ("the car's chassis is TC20, not TC10") does not: the transaction may bind
    // its old value to same-run vault evidence instead, as the work-package
    // contract explicitly permits.
    if (contextualCorrection && !explicitCorrection && !negatedAssertion && !hasPrior) {
      return no("correction-without-prior-answer");
    }
    return {
      eligible: true,
      kind: "correct",
      reason: explicitCorrection
        ? "explicit-correction"
        : negatedAssertion
          ? "negated-correction"
          : "contextual-correction",
      // Explicit rejections are unambiguous; a bare "it's an TC20" is a
      // correction only by context, which is exactly the case the finalize
      // nudge exists for, so it counts too.
      unambiguous: true,
    };
  }

  if (matchesAny(DURABLE_FIRST_PERSON, text)) {
    return { eligible: true, kind: "create", reason: "durable-first-person", unambiguous: true };
  }

  return no("no-durable-assertion");
}
