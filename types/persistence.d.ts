export type CorrectionOutcome = "accepted" | "ambiguous" | "not_applicable";
export type PersistenceOutcome = "committed" | "failed" | "skipped";
export type ResponsePolicy = "answer" | "answer_with_persistence_note" | "clarify";
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
export declare function resolveOutcomes(entry: {
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
export declare function persistenceNote({ overlayActive }?: {
    overlayActive?: boolean;
}): "The durable record update failed; the correction remains active for this conversation only." | "The vault update failed, so I have not stored that correction.";
/** True when the text claims the fact reached durable storage. */
export declare function claimsPersistence(text: any): boolean;
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
export declare function composeWithNote(answer: string, note: string): {
    text: string;
    refused: boolean;
};
