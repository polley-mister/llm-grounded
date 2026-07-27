/**
 * Decide whether a proposed tool call is looking for private personal data.
 *
 * @param {string} toolName the tool about to run
 * @param {{query?: string} & Record<string, unknown>} params its parameters
 * @returns {{blocked: boolean, reason?: string, matched?: string}}
 */
export declare function assessToolSafety(toolName: string, params: {
    query?: string;
} & Record<string, unknown>): {
    blocked: boolean;
    reason?: string;
    matched?: string;
};
/** Message returned to the model in place of results. */
export declare function blockMessage(): string;
