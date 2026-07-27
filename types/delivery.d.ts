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
 * Pick the terminal text from what the lanes observed.
 *
 * Returns a fallback marked `emissionObserved: false` when no lane fired, so a
 * record never claims to describe something that shipped when nothing did.
 *
 * @param {Array<{lane: string, text: string, external?: boolean}>} observations
 * @param {{fallbackText?: string, action?: string}} [opts]
 */
export declare function selectTerminalObservation(observations?: Array<{
    lane: string;
    text: string;
    external?: boolean;
}>, opts?: {
    fallbackText?: string;
    action?: string;
}): {
    deliveryAction: string | null;
    textMutatedByPlugin: boolean;
    observedLanes: string[];
    emissionObserved: boolean;
    emittedLane: null;
    externalDeliveryObserved: boolean;
    terminalTextMismatch: boolean;
    final: string | null;
} | {
    deliveryAction: string | null;
    textMutatedByPlugin: boolean;
    observedLanes: string[];
    externalDeliveryObserved: boolean;
    emissionObserved: boolean;
    emittedLane: string;
    terminalTextMismatch: boolean;
    final: string;
};
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
