/**
 * Run extraction for one finished turn.
 *
 * Never throws. A failure to write, a provider outage, a timeout and a
 * malformed reply are all outcomes, because the alternative is a shadow feature
 * with the power to break a turn that has already succeeded.
 *
 * @param {{
 *   cfg: object,
 *   entry: object,
 *   finalText: string,
 *   userTurn?: string,
 *   llm?: object,
 *   logger?: object,
 *   now?: () => number,
 *   extract?: Function,
 *   fsOps?: object,
 * }} input
 */
export function runShadowExtraction(input: {
    cfg: object;
    entry: object;
    finalText: string;
    userTurn?: string;
    llm?: object;
    logger?: object;
    now?: () => number;
    extract?: Function;
    fsOps?: object;
}): Promise<{
    ran: boolean;
    extractionId: any;
    status: string;
    skipReason: any;
    detail: any;
} | {
    ran: boolean;
    extractionId: any;
    status: any;
    skipReason: any;
    storeFailed: boolean;
    scheduledAt: number;
    startedAt: number;
    completedAt: number;
    lagMs: number;
    latencyMs: number;
    claimCount: any;
    materialClaimCount: any;
    abstentionReason: any;
}>;
/**
 * The stored record.
 *
 * Claims carry their own text, because a claim that cannot be read is not
 * reviewable and review is the point. The draft is stored alongside them for
 * the same reason — a claim without the sentence it came from cannot be judged
 * material or not. Both live here rather than in telemetry, which is the store
 * that must stay free of verbatim content.
 */
export function buildShadowRecord({ cfg, entry, extraction, draft, latencyMs, now, extractionId, scheduledAt, startedAt, completedAt, }: {
    cfg: any;
    entry: any;
    extraction: any;
    draft: any;
    latencyMs: any;
    now?: () => number;
    extractionId: any;
    scheduledAt: any;
    startedAt: any;
    completedAt: any;
}): {
    schemaVersion: string;
    extractionId: any;
    extractedAt: string;
    scheduledAt: string;
    startedAt: string;
    completedAt: string;
    lagMs: number;
    internalTurnId: any;
    turnId: any;
    trafficClass: any;
    behaviorEpoch: any;
    status: any;
    abstentionReason: any;
    abstentionDetail: any;
    provenance: any;
    latencyMs: any;
    draft: any;
    claims: any;
    premises: any;
    claimCount: any;
    materialClaimCount: any;
    verificationTargetCount: any;
    claimSupported: any;
    supportLabels: any[];
};
/** One file per extraction, 0600 in a 0700 directory, like every other store here. */
export function writeShadowRecord(dir: any, record: any, logger: any, fsOps?: Readonly<{
    mkdir: any;
    writeFile: any;
}>): Promise<{
    ok: boolean;
    reason: string;
    path?: undefined;
} | {
    ok: boolean;
    path: any;
    reason?: undefined;
}>;
/**
 * Drop extractions past their retention window.
 *
 * Shorter than telemetry's by default, for the same reason evidence capture's
 * is: these records hold verbatim answer text.
 */
export function pruneShadowExtractions(dir: any, retentionDays: number, logger: any, now?: () => number): Promise<number>;
export const CLAIM_SHADOW_SCHEMA_VERSION: "claim-extraction-shadow-v1";
/** Why a turn was not extracted from. Not the same as abstaining. */
export const SHADOW_SKIP_REASONS: readonly string[];
/**
 * Statuses a stored extraction record can carry.
 *
 * `scheduled` is written *before* the model call and overwritten when it
 * returns. That costs a second small local write per extraction and buys the
 * only way to see a completion loss: if the gateway is restarted or the process
 * dies mid-call, the turn record is never written either — `agent_end` had not
 * finished — so nothing in telemetry would record that an extraction had been
 * started at all. A scheduled record left on disk is that evidence.
 *
 * Without it, a killed extraction is indistinguishable from a turn that was
 * never eligible, and completion rate cannot be measured.
 */
export const SHADOW_RECORD_STATUSES: readonly string[];
