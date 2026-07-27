export type DeliveryAction = "pass" | "replace" | "annotate" | "revise" | "safe_fallback";
export type DeliveryDecision = {
    action: DeliveryAction;
    responsePolicy: string;
    text?: string;
    instruction?: string;
    correctionOutcome: string;
    persistenceOutcome: string;
    persistenceFailureNoted: boolean;
    correctionAppliedToResponse: boolean;
};
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
export declare function resolveDelivery({ entry, draft, overlayActive, structuredFact, maxPersistenceClaimRevisions, }?: {
    entry: object;
    draft?: string;
    overlayActive?: boolean;
    structuredFact?: object | null;
    maxPersistenceClaimRevisions?: number;
}): DeliveryDecision;
