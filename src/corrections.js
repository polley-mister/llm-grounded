// ---------------------------------------------------------------------------
// Correction scope: what a correction is allowed to change, and on whose word.
//
// The invariant being preserved is narrow:
//
//     a correction must be resolved before a durable fact is written
//
// It is NOT "every correction must run memory_search". Those are different
// claims, and conflating them is what put the grounding gate in front of
// ordinary conversation. the operator is the authoritative source for which car they
// owns; a lookup may be needed to find the record being replaced, but not to
// believe the new value.
//
// So this binds the persistence path only. It never compels retrieval merely
// so the agent can answer, and a failure here withholds the write while the
// conversational answer still ships.
//
// Assertion-mode filtering is not reimplemented: detectFactStatement already
// excludes questions, instructions, quotations, hypotheticals and hedges,
// which is exactly the guard that keeps "What if I told you I am Marlowe
// Vance?" from becoming a durable fact.
// ---------------------------------------------------------------------------

import { detectFactStatement } from "./facts-detect.js";

/** First-person ownership: the scope the operator can authoritatively report. */
const USER_OWNED = [
  /\b(?:my|mine|our|i'?m|i am|i have|i own|i drive|i run|i use|i graduate|i live|i work)\b/i,
  /\bi (?:said|meant|told you)\b/i,
];

/**
 * Subjects outside the operator's own world, which their say-so does not settle.
 *
 * A release date or a patch status is not made true by asserting it, so these
 * never become durable personal facts on assertion alone.
 */
const EXTERNAL_SUBJECT = [
  /\b(?:released?|came out|launched|premiered|published|patched|fixed|announced)\b/i,
  /\b(?:cve|version|build)\s*[-\s]?\d/i,
  /\b(?:in|during|back in)\s+(?:19|20)\d{2}\b/i,
];

/** Too little proposition to act on. */
const INSUFFICIENT = [
  /^\s*(?:that'?s|thats|it'?s)\s+(?:wrong|incorrect|not right|false)\s*[.!]?\s*$/i,
  /^\s*(?:no|nope|nah)\s*[,.!]?\s*(?:the other one|not that one|not quite|wrong)?\s*[.!]?\s*$/i,
  /^\s*it\s+wasn'?t\s+like\s+that\s*[.!]?\s*$/i,
  /^\s*(?:you'?re|your)\s+wrong\s*[.!]?\s*$/i,
];

function matchesAny(patterns, text) {
  return patterns.some((re) => re.test(text));
}

/**
 * Resolve a correction's scope and what it is permitted to do.
 *
 * @returns {{
 *   isCorrection: boolean,
 *   correctionScope: "user_owned_fact"|"external_world"|"ambiguous"|null,
 *   evidenceSource: string|null,
 *   requiredTool: null,
 *   factEnforcementRequired: boolean,
 *   commitPermitted: boolean,
 *   reason: string
 * }}
 */
export function resolveCorrection(userMessage, prevAssistant) {
  const none = (reason) => ({
    isCorrection: false,
    correctionScope: null,
    evidenceSource: null,
    requiredTool: null,
    factEnforcementRequired: false,
    commitPermitted: false,
    reason,
  });

  const text = String(userMessage ?? "").trim();
  if (!text) return none("empty");

  // Insufficient proposition: a correction was signalled but there is nothing
  // to write. This produces a clarification, never a fail-closed.
  if (matchesAny(INSUFFICIENT, text)) {
    return {
      isCorrection: true,
      correctionScope: "ambiguous",
      evidenceSource: null,
      requiredTool: null,
      factEnforcementRequired: false,
      commitPermitted: false,
      reason: "insufficient-proposition",
    };
  }

  const fact = detectFactStatement(text, prevAssistant);
  if (!fact?.eligible) return none(fact?.reason ?? "not-a-fact");
  if (fact.kind !== "correct") return none("statement-not-correction");

  // Assertions about the outside world are not settled by asserting them, so
  // they never become durable personal facts on the user's say-so.
  if (matchesAny(EXTERNAL_SUBJECT, text) && !matchesAny(USER_OWNED, text)) {
    return {
      isCorrection: true,
      correctionScope: "external_world",
      evidenceSource: null,
      requiredTool: null,
      factEnforcementRequired: false,
      commitPermitted: false,
      reason: "external-subject",
    };
  }

  if (!fact.unambiguous) {
    return {
      isCorrection: true,
      correctionScope: "ambiguous",
      evidenceSource: null,
      requiredTool: null,
      factEnforcementRequired: false,
      commitPermitted: false,
      reason: "ambiguous-proposition",
    };
  }

  // the operator's own world, stated plainly. Their assertion is the evidence; any
  // lookup that follows is to find the record being superseded.
  return {
    isCorrection: true,
    correctionScope: "user_owned_fact",
    evidenceSource: "current_user_assertion",
    requiredTool: null,
    factEnforcementRequired: true,
    commitPermitted: true,
    reason: "user-owned-correction",
  };
}
