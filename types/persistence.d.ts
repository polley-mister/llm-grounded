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
export function resolveOutcomes(entry: {
    factEligible?: boolean;
    factKind?: string | null;
    factUnambiguous?: boolean;
    factTransactionAllowed?: boolean;
    factCalls?: number;
    factOutcome?: {
        ok?: boolean;
    } | null;
    correctionScope?: string | null;
}): {
    correctionOutcome: CorrectionOutcome;
    persistenceOutcome: PersistenceOutcome;
    responsePolicy: ResponsePolicy;
};
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
export function persistenceNote({ overlayActive }?: {
    overlayActive?: boolean;
}): "The durable record update failed; the correction remains active for this conversation only." | "The vault update failed, so I have not stored that correction.";
/** True when the text claims the fact reached durable storage. */
export function claimsPersistence(text: any): boolean;
/**
 * Rebuild a truthful reply from structured fact data.
 *
 * The escape hatch for a draft that still claims the write succeeded after its
 * bounded repair. Appending the note to it would knowingly ship a
 * contradiction, and rewriting the offending sentence is the one thing this
 * design refuses to do — a renderer that edits model prose to remove a claim is
 * the surface where numbers start changing. So the prose is discarded and the
 * reply is *constructed* from the proposal that was already validated and
 * captured before the commit was attempted.
 *
 * That is why this is not prohibited string replacement: nothing here reads the
 * draft. Every value comes from `structuredFact`.
 *
 * Returns null when there is no captured proposal — the model can claim to have
 * saved something without ever having called the tool, and in that case there
 * is no value we are entitled to state. The caller falls back to the fixed
 * no-mutation sentence.
 *
 * @param {{operation?: string, subject?: string, property?: string,
 *          newValue?: string, previousValue?: string}|null} structuredFact
 * @param {{overlayActive?: boolean}} [opts]
 */
export function safeFallbackText(structuredFact: {
    operation?: string;
    subject?: string;
    property?: string;
    newValue?: string;
    previousValue?: string;
} | null, { overlayActive }?: {
    overlayActive?: boolean;
}): string;
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
export function composeWithNote(answer: string, note: string): {
    text: string;
    refused: boolean;
};
export type CorrectionOutcome = "accepted" | "ambiguous" | "not_applicable";
export type PersistenceOutcome = "committed" | "failed" | "skipped";
export type ResponsePolicy = "answer" | "answer_with_persistence_note" | "clarify";
