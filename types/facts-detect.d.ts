/**
 * A fact value looks like a value: a digit, or a capitalized token that is not
 * merely the first word of the sentence. "an M2" qualifies; "a great car" does
 * not. Deterministic, cheap, and biased toward refusing.
 */
export declare function hasValueToken(text: any): boolean;
/**
 * A message that is mostly a quotation is reporting text, not asserting it.
 * Measured by share of characters inside quotes rather than by presence, so an
 * ordinary statement that happens to quote a two-word name still counts.
 */
export declare function isMostlyQuotation(text: any): boolean;
/**
 * Classify one turn for the fact-transaction pipeline.
 *
 * @param {string} userMessage raw operator text for this turn
 * @param {string|null|undefined} prevAssistant the assistant's previous message
 * @returns {{eligible: boolean, kind: "create"|"correct"|null, reason: string,
 *            unambiguous: boolean}}
 */
export declare function detectFactStatement(userMessage: string, prevAssistant: string | null | undefined): {
    eligible: boolean;
    kind: "create" | "correct" | null;
    reason: string;
    unambiguous: boolean;
};
