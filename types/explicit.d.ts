/**
 * Normalise the operator characters people actually type.
 *
 * The baseline caught this: "What is 17 × 24?" did not match the arithmetic
 * rule because × is not *, so it fell through to no-external-premise. The
 * answer was right by accident. Arithmetic is about to become a hard trigger,
 * where failing to fire is a silent gap rather than a lucky escape.
 */
export function normalizeArithmetic(text: any): string;
/**
 * True only for a complete, self-contained arithmetic expression.
 *
 * The presence of an operator decides nothing. "I bought 3 x 4 boards" and
 * "the dimensions are 10 x 20 x 30 mm" contain operators and are not
 * calculation requests; "(16 + 8) / 3" is one and contains no verb at all.
 * The parser decides.
 */
export function isCompleteArithmetic(text: any): boolean;
/**
 * The result of a hard-trigger decision.
 *
 * `kind` names what the operator asked for outright. "web" and "memory" are
 * the only retrieval tiers; "arithmetic", "admin" and "correction" bind a
 * scope rather than an obligation to retrieve, so a caller routing on
 * retrieval must test for the two tiers rather than for a non-null kind.
 *
 * The fields below `reason` are populated only for a correction, which is why
 * they are optional. They were previously absent from the published type
 * entirely, so a typed caller could not read the result it actually receives.
 *
 * @typedef {object} HardTrigger
 * @property {"web"|"memory"|"arithmetic"|"admin"|"correction"|null} kind
 * @property {string} reason
 * @property {"fact_commit"} [policyScope] what the correction is allowed to touch
 * @property {string} [correctionScope]
 * @property {string} [evidenceSource] the operator's own assertion, for a correction
 * @property {string|null} [requiredTool] always null: a correction compels no retrieval
 * @property {boolean} [factEnforcementRequired]
 * @property {boolean} [commitPermitted]
 */
/**
 * The only decision that may compel a tool.
 *
 * @param {string} message raw user text for this turn
 * @param {{prevAssistant?: string}} [context] the previous assistant turn, used
 *   only to resolve whether this turn is a correction of it
 * @returns {HardTrigger}
 */
export function hardTrigger(message: string, context?: {
    prevAssistant?: string;
}): HardTrigger;
/**
 * True when a turn asks, as a question, for a fact that only retrieval can
 * supply. Exported so the boundary is testable directly rather than only
 * through the trigger it feeds.
 *
 * @param {string} text vocative-stripped user text
 * @returns {boolean}
 */
export function bindsCurrentInformation(text: string): boolean;
/**
 * Non-binding hint derived from the legacy verdict.
 *
 * Offered to the model as information, never as an obligation. It cannot
 * compel a tool, reject a response, consume a revision, or fail closed.
 */
export function advisoryText(legacyKind: any): string;
/**
 * The result of a hard-trigger decision.
 *
 * `kind` names what the operator asked for outright. "web" and "memory" are
 * the only retrieval tiers; "arithmetic", "admin" and "correction" bind a
 * scope rather than an obligation to retrieve, so a caller routing on
 * retrieval must test for the two tiers rather than for a non-null kind.
 *
 * The fields below `reason` are populated only for a correction, which is why
 * they are optional. They were previously absent from the published type
 * entirely, so a typed caller could not read the result it actually receives.
 */
export type HardTrigger = {
    kind: "web" | "memory" | "arithmetic" | "admin" | "correction" | null;
    reason: string;
    /**
     * what the correction is allowed to touch
     */
    policyScope?: "fact_commit";
    correctionScope?: string;
    /**
     * the operator's own assertion, for a correction
     */
    evidenceSource?: string;
    /**
     * always null: a correction compels no retrieval
     */
    requiredTool?: string | null;
    factEnforcementRequired?: boolean;
    commitPermitted?: boolean;
};
