export declare const EVIDENCE_SCHEMA_VERSION = "evidence-v1";
/** Where evidence excerpts live. Separate from telemetry, deliberately. */
export declare const DEFAULT_EVIDENCE_CAPTURE_DIR: any;
/**
 * Tools whose results can support a claim.
 *
 * An allowlist, not a denylist: an unknown tool is not captured. `exec` and
 * file reads are absent on purpose — they routinely carry secrets and large
 * private documents, and they need a stricter policy than this module provides.
 */
export declare const EVIDENCE_TOOLS: Readonly<{
    web_search: "web";
    web_fetch: "web";
    memory_search: "memory";
    wiki_search: "memory";
    wiki_get: "memory";
}>;
export declare const BOUNDS: Readonly<{
    excerptChars: 2000;
    itemsPerTurn: 8;
    charsPerTurn: 10000;
}>;
/** Days before an evidence file is pruned. Shorter than telemetry on purpose. */
export declare const DEFAULT_RETENTION_DAYS = 14;
/**
 * Pull readable text out of a tool result.
 *
 * Handles the shapes OpenClaw actually produces without asserting a schema:
 * a result may be a string, `{content: [{type:"text", text}]}`, or an object
 * with a `text`/`snippet` field. Anything else yields nothing, which is the
 * safe outcome — an unrecognised shape is not guessed at.
 */
export declare function extractText(result: any): any;
/**
 * Redact anything that looks like a credential.
 *
 * Token-wise, reusing `looksSecret` so the definition of "secret" lives in one
 * place. Returns the count as well as the text: a capture that redacted
 * something is materially different from one that did not, and the difference
 * belongs in the record rather than in a log line.
 */
export declare function redactExcerpt(text: any): {
    text: string;
    redactionCount: number;
};
/** Truncate on a word boundary where possible, so an excerpt ends readably. */
export declare function boundExcerpt(text: any, limit?: 2000): {
    text: string;
    truncated: boolean;
};
/**
 * Build one evidence record, or explain why not.
 *
 * Pure: does no I/O, so the decision to capture is testable apart from whether
 * the disk cooperated.
 *
 * @returns {{captureStatus: "captured"|"skipped", reason?: string, record?: object}}
 */
export declare function buildEvidenceRecord({ turnId, toolCallId, tool, params, result, now, id, }?: {
    id?: (() => string) | undefined;
    now?: (() => number) | undefined;
}): {
    captureStatus: "captured" | "skipped";
    reason?: string;
    record?: object;
};
/**
 * Track what a single turn has already captured.
 *
 * Bounds are per turn as well as per item: eight two-thousand-character
 * excerpts is a lot of third-party text to accumulate from one question.
 */
export declare function createTurnBudget(bounds?: Readonly<{
    excerptChars: 2000;
    itemsPerTurn: 8;
    charsPerTurn: 10000;
}>): {
    /** Whether another record of this size may be stored. */
    admit(record: any): {
        ok: boolean;
        reason: string;
    } | {
        reason?: undefined;
        ok: boolean;
    };
    readonly used: {
        items: number;
        chars: number;
    };
};
/**
 * Write one record atomically.
 *
 * Temporary file, then rename: a crash mid-write leaves either the previous
 * state or the new one, never a truncated record whose hash describes nothing.
 *
 * Never throws. Capture is best-effort by design — an unwritable store must not
 * be able to fail a user's turn.
 */
export declare function writeEvidenceRecord(dir: any, record: any, logger: any): Promise<{
    reason?: undefined;
    ok: boolean;
    path: any;
} | {
    path?: undefined;
    ok: boolean;
    reason: string;
}>;
/**
 * Drop evidence past its retention window.
 *
 * Excerpts are verbatim third-party and private content. A store with no expiry
 * becomes an unbounded private archive nobody audits, so retention is shorter
 * than telemetry's by default.
 */
export declare function pruneEvidenceCapture(dir: any, retentionDays: number | undefined, logger: any, now?: () => number): Promise<number>;
/**
 * Capture one tool result end to end.
 *
 * Returns what telemetry should record: references and outcome flags, never
 * excerpt text.
 */
export declare function captureEvidence({ dir, budget, logger, ...input }: {
    [x: string]: any;
    budget: any;
    dir: any;
    logger: any;
}): Promise<{
    captured: boolean;
    reason: any;
    evidenceId: null;
} | {
    captured: boolean;
    evidenceId: any;
    reason: null;
}>;
