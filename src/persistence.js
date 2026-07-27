// Two outcomes, not one.
//
// A fact turn produces two independent results, and the delivery path was
// conflating them:
//
//   correctionOutcome    did the operator's correction land for this conversation?
//   persistenceOutcome   did it reach durable storage?
//
// A failed write does not make the correction false. The old behaviour replaced
// the entire reply with a fixed sentence, which discarded a good answer to
// avoid a claim nobody had made yet. The rule that replaces it:
//
//   Persistence failure prevents a claim of persistence, not a truthful answer
//   using the operator's correction.
//
// So the reply ships, using the corrected value, with a note stating that the
// durable record was not updated. What must never happen is the reply *sounding
// saved* — "got it, I'll remember that" when nothing was written is a false
// statement about the state of record, and the operator will believe it.
//
// The note's wording is load-bearing and is gated on the session overlay
// actually existing. "The correction remains active for this conversation"
// is a promise about the next turn; see `state.js` for the overlay that keeps
// it. Without an active overlay the note says only that nothing was stored.

/** @typedef {"accepted"|"ambiguous"|"not_applicable"} CorrectionOutcome */
/** @typedef {"committed"|"failed"|"skipped"} PersistenceOutcome */
/** @typedef {"answer"|"answer_with_persistence_note"|"clarify"} ResponsePolicy */

/**
 * Resolve the two outcomes and the delivery policy that follows from them.
 *
 * Deliberately a pure function of the store entry: the delivery hooks run on
 * several transports and must not each re-derive this from different fields.
 *
 * @param {{
 *   factEligible?: boolean,
 *   factKind?: string|null,
 *   factUnambiguous?: boolean,
 *   factTransactionAllowed?: boolean,
 *   factCalls?: number,
 *   factOutcome?: {ok?: boolean}|null,
 *   correctionScope?: string|null,
 * }} entry
 * @returns {{
 *   correctionOutcome: CorrectionOutcome,
 *   persistenceOutcome: PersistenceOutcome,
 *   responsePolicy: ResponsePolicy,
 * }}
 */
export function resolveOutcomes(entry) {
  const e = entry ?? {};

  // A correction that named no proposition is not accepted and not refused;
  // it needs a question back. This never reaches a write and never fails a
  // turn closed.
  if (e.correctionScope === "ambiguous") {
    return {
      correctionOutcome: "ambiguous",
      persistenceOutcome: "skipped",
      responsePolicy: "clarify",
    };
  }

  const isFactTurn = Boolean(e.factEligible) && e.factKind != null;
  if (!isFactTurn) {
    return {
      correctionOutcome: "not_applicable",
      persistenceOutcome: "skipped",
      responsePolicy: "answer",
    };
  }

  // The operator is authoritative for their own world, so their assertion is
  // what makes the correction accepted. Whether we managed to write it down is
  // a separate question, answered below.
  const correctionOutcome = "accepted";

  if (e.factOutcome?.ok === true) {
    return { correctionOutcome, persistenceOutcome: "committed", responsePolicy: "answer" };
  }

  // Never attempted, and not because anything went wrong: the transaction is
  // disabled, or this agent is not permitted to use it. Nothing failed, so
  // there is nothing to disclose — a note here would be noise on every turn.
  const attempted = (e.factCalls ?? 0) > 0 || e.factOutcome != null;
  if (!attempted && !e.factTransactionAllowed) {
    return { correctionOutcome, persistenceOutcome: "skipped", responsePolicy: "answer" };
  }

  // Attempted and did not commit, or eligible and permitted but never reached
  // the tool. Both are a durable record that does not reflect what the
  // operator just said, and both must be disclosed.
  return {
    correctionOutcome,
    persistenceOutcome: "failed",
    responsePolicy: "answer_with_persistence_note",
  };
}

/**
 * The sentence appended to an otherwise good answer.
 *
 * Two forms, and which one is legal depends on whether the session overlay is
 * holding the corrected value. Claiming the correction "remains active for this
 * conversation" while nothing holds it would be the same class of lie as
 * claiming it was saved.
 *
 * @param {{overlayActive?: boolean}} [opts]
 */
export function persistenceNote({ overlayActive = false } = {}) {
  return overlayActive
    ? "The durable record update failed; the correction remains active for this conversation only."
    : "The vault update failed, so I have not stored that correction.";
}

/**
 * Words that assert the write happened. A reply carrying one of these after a
 * failed commit is the exact failure this module exists to prevent, so the
 * check is exported and asserted in tests rather than left as a comment.
 */
const PERSISTENCE_CLAIM =
  /\b(saved|stored|storing|remembered|remembering|recorded|recording|updated|updating|noted it down|written down|committed to memory|added to (?:my |the )?(?:memory|vault|record))\b/i;

/** True when the text claims the fact reached durable storage. */
export function claimsPersistence(text) {
  const s = String(text ?? "");
  if (!s.trim()) return false;
  // The note itself says "failed", "not stored", "did not". Strip the note's
  // own negated forms before looking, or the disclosure trips its own check.
  const withoutNegated = s
    .replace(/\b(?:not|never|n't|failed to|could not|couldn't|did not|didn't)\s+(?:\w+\s+){0,2}(?:save|saved|store|stored|remember|remembered|record|recorded|update|updated)\b/gi, " ")
    .replace(/\b(?:update|write|commit)\s+failed\b/gi, " ");
  return PERSISTENCE_CLAIM.test(withoutNegated);
}

/**
 * Compose the delivered reply.
 *
 * Appends rather than rewrites. Deletion and addition cannot invent; rewriting
 * a sentence to remove a persistence claim is the surface where a renderer
 * starts altering meaning, so a draft that already claims persistence is
 * refused here and handled by the caller's revision budget instead.
 *
 * @param {string} answer the model's draft
 * @param {string} note from {@link persistenceNote}
 * @returns {{text: string, refused: boolean}} `refused` when the draft claims
 *   the write succeeded and therefore cannot simply be annotated
 */
export function composeWithNote(answer, note) {
  const body = String(answer ?? "").trim();
  if (!body) return { text: note, refused: false };
  if (claimsPersistence(body)) return { text: body, refused: true };
  const separator = /[.!?)"']$/.test(body) ? " " : ". ";
  return { text: `${body}${separator}${note}`, refused: false };
}
