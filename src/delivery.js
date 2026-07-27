// The one terminal decision, resolved once per turn.
//
// Four delivery lanes exist — `before_message_write`, `reply_payload_sending`,
// `message_sending`, and the `deliver:false` transport that reads the
// transcript. Each of them previously derived its own answer to "what ships",
// from the same three or four entry fields, in three slightly different ways.
// That is a divergence waiting to happen: a fix applied to two of them and not
// the third is invisible until a transport nobody tests hits the missed branch.
//
// So this module answers it once and returns the *complete terminal text*.
// Lanes assign; they never compose. Four properties become structural rather
// than merely tested:
//
//   * every lane emits identical bytes
//   * the persistence note cannot be duplicated across lanes
//   * no lane can omit it
//   * no lane reimplements precedence
//
// Pure and synchronous. No host types, no I/O, no model call.

import { FAIL_CLOSED_TEXT, FACT_FAIL_CLOSED_TEXT, persistenceRevisionInstruction } from "./contract.js";
import {
  claimsPersistence,
  composeWithNote,
  persistenceNote,
  resolveOutcomes,
  safeFallbackText,
} from "./persistence.js";

/**
 * @typedef {"pass"|"replace"|"annotate"|"revise"|"safe_fallback"} DeliveryAction
 * @typedef {{
 *   action: DeliveryAction,
 *   responsePolicy: string,
 *   text?: string,
 *   instruction?: string,
 *   correctionOutcome: string,
 *   persistenceOutcome: string,
 *   persistenceFailureNoted: boolean,
 *   correctionAppliedToResponse: boolean,
 * }} DeliveryDecision
 */

/**
 * Decide what this turn actually delivers.
 *
 * @param {{
 *   entry: object,
 *   draft?: string,
 *   overlayActive?: boolean,
 *   structuredFact?: object|null,
 *   maxPersistenceClaimRevisions?: number,
 * }} input
 * @returns {DeliveryDecision}
 */
export function resolveDelivery({
  entry,
  draft = "",
  overlayActive = false,
  structuredFact = null,
  maxPersistenceClaimRevisions = 1,
} = {}) {
  const e = entry ?? {};
  const outcomes = resolveOutcomes(e);
  const base = {
    correctionOutcome: outcomes.correctionOutcome,
    persistenceOutcome: outcomes.persistenceOutcome,
    persistenceFailureNoted: false,
    correctionAppliedToResponse: false,
  };

  // Grounding outranks persistence. A turn replaced for missing evidence must
  // not also carry a note about the vault: annotating it would imply the answer
  // itself was fine and only the bookkeeping failed. The persistence outcome is
  // still reported, so the corpus can see the combined case even though the
  // operator is not told about it on this turn.
  if (e.failClosed) {
    return {
      ...base,
      action: "replace",
      responsePolicy: "grounding_fail_closed",
      text: FAIL_CLOSED_TEXT,
    };
  }

  if (outcomes.responsePolicy !== "answer_with_persistence_note") {
    return {
      ...base,
      action: "pass",
      responsePolicy: outcomes.responsePolicy === "clarify" ? "clarify" : "pass",
      text: String(draft ?? ""),
      correctionAppliedToResponse: outcomes.correctionOutcome === "accepted",
    };
  }

  // From here the durable write did not land and the operator must be told.
  const body = String(draft ?? "");

  if (claimsPersistence(body)) {
    const spent = Number(e.persistenceClaimRevisions ?? 0);
    if (spent < maxPersistenceClaimRevisions) {
      return {
        ...base,
        action: "revise",
        responsePolicy: "repair_false_persistence_claim",
        instruction: persistenceRevisionInstruction(),
      };
    }
    // Budget spent and the draft still claims it saved. Appending the note here
    // would ship a self-contradiction, so the prose is discarded and the reply
    // is rebuilt from the captured proposal. Nothing below reads the draft.
    const rebuilt = safeFallbackText(structuredFact, { overlayActive });
    if (rebuilt) {
      return {
        ...base,
        action: "safe_fallback",
        responsePolicy: "truthful_persistence_fallback",
        text: rebuilt,
        persistenceFailureNoted: true,
        correctionAppliedToResponse: true,
      };
    }
    // No captured proposal — the model claimed to have saved something it never
    // proposed. There is no value we are entitled to state, so the only honest
    // terminal is the fixed no-mutation sentence. This is the single surviving
    // use of FACT_FAIL_CLOSED_TEXT.
    return {
      ...base,
      action: "safe_fallback",
      responsePolicy: "truthful_persistence_fallback",
      text: FACT_FAIL_CLOSED_TEXT,
      persistenceFailureNoted: true,
      correctionAppliedToResponse: false,
    };
  }

  const composed = composeWithNote(body, persistenceNote({ overlayActive }));
  return {
    ...base,
    action: "annotate",
    responsePolicy: "answer_with_persistence_note",
    text: composed.text,
    persistenceFailureNoted: true,
    correctionAppliedToResponse: true,
  };
}
