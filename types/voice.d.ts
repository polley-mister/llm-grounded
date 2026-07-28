/** True when the operator asked for something that legitimately runs long. */
export function depthWasRequested(userMessage: any): boolean;
/**
 * Assess one reply against the objective half of the voice rules.
 *
 * @param {string} replyText the drafted reply, before delivery
 * @param {{userMessage?: string, maxWords?: number}} [options] the turn that
 *   prompted it (depth requests suspend the length rule) and the length bound
 * @returns {{ok: boolean, violations: string[], instruction: string}}
 */
export function assessVoice(replyText: string, options?: {
    userMessage?: string;
    maxWords?: number;
}): {
    ok: boolean;
    violations: string[];
    instruction: string;
};
/**
 * The correction handed back to the model.
 *
 * Names the measured fact and the target. "Be more concise" is advice; "that
 * was 118 words, answer in under 90" is an instruction, and a model can act on
 * the second without guessing what it did wrong.
 */
export function revisionText(violations: any, words: any, maxWords: any): string;
/** Words above which a reply is long by any reading of Verbosity 35. */
export const DEFAULT_MAX_WORDS: 90;
