/**
 * Pull readable text out of a tool result.
 *
 * Handles the shapes OpenClaw actually produces without asserting a schema:
 * a result may be a string, `{content: [{type:"text", text}]}`, or an object
 * with a `text`/`snippet` field. Anything else yields nothing, which is the
 * safe outcome — an unrecognised shape is not guessed at.
 */
export function extractText(result: any): any;
/**
 * Redact anything that looks like a credential.
 *
 * Token-wise, reusing `looksSecret` so the definition of "secret" lives in one
 * place. Returns the count as well as the text: a capture that redacted
 * something is materially different from one that did not, and the difference
 * belongs in the record rather than in a log line.
 */
export function redactExcerpt(text: any): {
    text: string;
    redactionCount: number;
};
/** Truncate on a word boundary where possible, so an excerpt ends readably. */
export function boundExcerpt(text: any, limit?: 2000): {
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
export function buildEvidenceRecord({ turnId, toolCallId, tool, params, result, evidenceItem, evidenceView, transformsApplied, now, id, }?: {
    evidenceItem?: any;
    evidenceView?: string;
    transformsApplied?: any[];
    now?: () => number;
    id?: () => string;
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
export function createTurnBudget(bounds?: Readonly<{
    excerptChars: 2000;
    itemsPerCall: 5;
    itemsPerTurn: 8;
    charsPerTurn: 10000;
}>): {
    /** Whether another record of this size may be stored. */
    admit(record: any): {
        ok: boolean;
        reason: string;
    } | {
        ok: boolean;
        reason?: undefined;
    };
    readonly used: {
        items: number;
        chars: number;
    };
};
export function writeEvidenceRecord(dir: any, record: any, logger: any, fsOps?: Readonly<{
    mkdir: any;
    writeFile: any;
    rename: any;
}>): Promise<{
    ok: boolean;
    path: any;
    reason?: undefined;
} | {
    ok: boolean;
    reason: string;
    path?: undefined;
}>;
/**
 * Drop evidence past its retention window.
 *
 * Excerpts are verbatim third-party and private content. A store with no expiry
 * becomes an unbounded private archive nobody audits, so retention is shorter
 * than telemetry's by default.
 */
export function pruneEvidenceCapture(dir: any, retentionDays: number, logger: any, now?: () => number): Promise<number>;
/**
 * Capture one tool result end to end.
 *
 * Returns what telemetry should record: references and outcome flags, never
 * excerpt text.
 */
/**
 * Capture every evidence item from one successful tool call.
 *
 * Bounded three ways — per item, per call, per turn — and every rejection is
 * reported rather than silently dropped, because "we captured nothing" and "we
 * captured nothing because the budget was spent" are different facts about a
 * turn.
 */
export function captureToolCallEvidence({ dir, budget, logger, tool, result, runtimeTools, bounds, fsOps, ...rest }: {
    [x: string]: any;
    dir: any;
    budget: any;
    logger: any;
    tool: any;
    result: any;
    runtimeTools?: any[];
    bounds?: Readonly<{
        excerptChars: 2000;
        itemsPerCall: 5;
        itemsPerTurn: 8;
        charsPerTurn: 10000;
    }>;
    fsOps: any;
}): Promise<{
    evidenceIds: any[];
    captured: number;
    skipped: number;
    failed: number;
    reasons: any[];
}>;
export function captureEvidence({ dir, budget, logger, fsOps, ...input }: {
    [x: string]: any;
    dir: any;
    budget: any;
    logger: any;
    fsOps: any;
}): Promise<{
    captured: boolean;
    reason: any;
    evidenceId: any;
} | {
    captured: boolean;
    evidenceId: any;
    reason: any;
}>;
export const EVIDENCE_SCHEMA_VERSION: "evidence-v1";
/** Where evidence excerpts live. Separate from telemetry, deliberately. */
export const DEFAULT_EVIDENCE_CAPTURE_DIR: any;
/**
 * Tools whose results can support a claim.
 *
 * An allowlist, not a denylist: an unknown tool is not captured. `exec` and
 * file reads are absent on purpose — they routinely carry secrets and large
 * private documents, and they need a stricter policy than this module provides.
 */
export const EVIDENCE_TOOLS: Readonly<{
    web_search: "web";
    web_fetch: "web";
    memory_search: "memory";
    wiki_search: "memory";
    wiki_get: "memory";
}>;
export const BOUNDS: Readonly<{
    excerptChars: 2000;
    itemsPerCall: 5;
    itemsPerTurn: 8;
    charsPerTurn: 10000;
}>;
/** How long a bounded local capture may take before the turn moves on. */
export const DEFAULT_CAPTURE_TIMEOUT_MS: 400;
/** Days before an evidence file is pruned. Shorter than telemetry on purpose. */
export const DEFAULT_RETENTION_DAYS: 14;
