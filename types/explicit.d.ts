/**
 * Normalise the operator characters people actually type.
 *
 * The baseline caught this: "What is 17 × 24?" did not match the arithmetic
 * rule because × is not *, so it fell through to no-external-premise. The
 * answer was right by accident. Arithmetic is about to become a hard trigger,
 * where failing to fire is a silent gap rather than a lucky escape.
 */
export declare function normalizeArithmetic(text: any): string;
/**
 * True only for a complete, self-contained arithmetic expression.
 *
 * The presence of an operator decides nothing. "I bought 3 x 4 boards" and
 * "the dimensions are 10 x 20 x 30 mm" contain operators and are not
 * calculation requests; "(16 + 8) / 3" is one and contains no verb at all.
 * The parser decides.
 */
export declare function isCompleteArithmetic(text: any): boolean;
/**
 * The only decision that may compel a tool.
 *
 * @param {string} message raw user text for this turn
 * @param {{prevAssistant?: string}} [context] the previous assistant turn, used
 *   only to resolve whether this turn is a correction of it
 * @returns {{kind: "web"|"memory"|"arithmetic"|"admin"|null, reason: string}}
 */
export declare function hardTrigger(message: string, context?: {
    prevAssistant?: string;
}): {
    kind: "web" | "memory" | "arithmetic" | "admin" | null;
    reason: string;
};
/**
 * Non-binding hint derived from the legacy verdict.
 *
 * Offered to the model as information, never as an obligation. It cannot
 * compel a tool, reject a response, consume a revision, or fail closed.
 */
export declare function advisoryText(legacyKind: any): "" | "This may depend on current external information. Use web search if you need it." | "This may depend on something the operator told you before. Check memory if you need it.";
