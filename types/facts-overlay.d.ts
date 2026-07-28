export function overlayPath(vaultPath: any): any;
/**
 * Cached overlay reader. A missing or malformed overlay yields no facts, which
 * degrades to today's behaviour rather than failing a retrieval.
 */
export function createOverlayReader({ vaultPath, cacheMs, now, read, logger }?: {
    cacheMs?: number;
    now?: () => number;
    read?: any;
}): {
    /** Drop the cache, so a just-committed record is visible immediately. */
    invalidate(): void;
    load(): Promise<any>;
};
/**
 * Find records the retrieved text contradicts.
 *
 * A conflict is a record whose superseded value the text states while not
 * stating the current one. Text that already agrees is left alone — an overlay
 * that fires on every retrieval would be noise, and noise gets ignored.
 */
export function findConflicts(overlay: any, text: any): {
    factKey: string;
    entry: any;
    stale: any;
}[];
/** The block prepended ahead of contradicted retrieval text. */
export function renderAuthoritativeBlock(conflicts: any): string;
/**
 * Overlay one retrieved text. Returns the original when nothing conflicts, so
 * the caller can skip the rewrite entirely.
 */
export function overlayText(overlay: any, text: any): {
    changed: boolean;
    text: string;
    conflicts: {
        factKey: string;
        entry: any;
        stale: any;
    }[];
};
/**
 * Rewrite a retrieval tool's result before the model consumes it.
 *
 * This operates on `AgentToolResult` — `{content: [{type: "text", text}], details}`
 * — which is what the agent tool-result middleware hands over on its way to the
 * model. The block goes on the first text part so it leads; later parts and
 * `details` are untouched, and nothing retrieved is dropped.
 *
 * Returns null when nothing conflicts, so the caller can leave the result
 * object identical rather than cloning it for no reason.
 */
export function overlayToolResult(overlay: any, result: any): {
    result: any;
    conflicts: {
        factKey: string;
        entry: any;
        stale: any;
    }[];
};
export const META_DIR: ".openclaw-facts";
export const OVERLAY_NAME: "index.json";
