export declare const DEFAULT_TIMEOUT_MS = 20000;
/**
 * Run one fact transaction.
 *
 * Never throws for a transaction problem: a refusal is data, and the caller
 * turns it into a tool result the model can read.
 *
 * @returns {Promise<{ok: boolean, code: string, [key: string]: unknown}>}
 */
export declare function commitFactTransaction(request: any, options?: {}): Promise<{
    ok: boolean;
    code: string;
    [key: string]: unknown;
}>;
