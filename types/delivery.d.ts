/**
 * Pick the terminal text from what the lanes observed.
 *
 * Returns a fallback marked `emissionObserved: false` when no lane fired, so a
 * record never claims to describe something that shipped when nothing did.
 *
 * @param {Array<{lane: string, text: string, external?: boolean}>} observations
 * @param {{fallbackText?: string, action?: string, originalDraft?: string}} [opts]
 */
export function selectTerminalObservation(observations?: Array<{
    lane: string;
    text: string;
    external?: boolean;
}>, opts?: {
    fallbackText?: string;
    action?: string;
    originalDraft?: string;
}): {
    emissionObserved: boolean;
    emittedLane: string;
    terminalTextMismatch: boolean;
    textMutatedByPlugin: boolean;
    final: string;
    deliveryAction: string;
    observedLanes: string[];
    externalDeliveryObserved: boolean;
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
export function resolveDelivery({ entry, draft, overlayActive, structuredFact, maxPersistenceClaimRevisions, }?: {
    entry: object;
    draft?: string;
    overlayActive?: boolean;
    structuredFact?: object | null;
    maxPersistenceClaimRevisions?: number;
}): DeliveryDecision;
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
