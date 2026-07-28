/**
 * Join one turn record to its evidence.
 *
 * @param {object} turn a record from the turn telemetry store
 * @param {{
 *   readEvidence: (id: string) => Promise<{ok: boolean, record?: object, reason?: string}>,
 *   extraction?: {status: string, claims?: object[], abstentionReason?: string}|null,
 *   retentionDays?: number,
 *   now?: () => number,
 * }} opts
 */
export function inspectTurn(turn: object, opts?: {
    readEvidence: (id: string) => Promise<{
        ok: boolean;
        record?: object;
        reason?: string;
    }>;
    extraction?: {
        status: string;
        claims?: object[];
        abstentionReason?: string;
    } | null;
    retentionDays?: number;
    now?: () => number;
}): Promise<{
    schemaVersion: string;
    internalTurnId: any;
    turnId: any;
    sessionId: any;
    agentId: any;
    ts: any;
    pluginVersion: any;
    behaviorEpoch: any;
    trafficClass: any;
    trafficResolutionStatus: any;
    draft: any;
    final: any;
    claimExtraction: {
        claims: any;
        claimCount: any;
        extractionId: any;
        resolution: string;
        status: any;
        skipReason: any;
        scheduledAt?: undefined;
        abstentionReason?: undefined;
        startedAt?: undefined;
        completedAt?: undefined;
        lagMs?: undefined;
        latencyMs?: undefined;
        materialClaimCount?: undefined;
        provenance?: undefined;
    } | {
        claims: any;
        claimCount: any;
        extractionId: any;
        resolution: string;
        status: any;
        skipReason?: undefined;
        scheduledAt?: undefined;
        abstentionReason?: undefined;
        startedAt?: undefined;
        completedAt?: undefined;
        lagMs?: undefined;
        latencyMs?: undefined;
        materialClaimCount?: undefined;
        provenance?: undefined;
    } | {
        claims: any;
        claimCount: any;
        extractionId: any;
        resolution: string;
        status: string;
        scheduledAt: any;
        skipReason?: undefined;
        abstentionReason?: undefined;
        startedAt?: undefined;
        completedAt?: undefined;
        lagMs?: undefined;
        latencyMs?: undefined;
        materialClaimCount?: undefined;
        provenance?: undefined;
    } | {
        claims: any;
        claimCount: any;
        extractionId: any;
        resolution: string;
        status: any;
        abstentionReason: any;
        scheduledAt: any;
        startedAt: any;
        completedAt: any;
        lagMs: any;
        latencyMs: any;
        materialClaimCount: any;
        provenance: any;
        skipReason?: undefined;
    } | {
        claims: any;
        claimCount: any;
        abstentionReason?: string;
        resolution: string;
        status: string;
    };
    evidence: ({
        evidenceId: any;
        resolution: string;
        detail: any;
        tool?: undefined;
        sourceType?: undefined;
        evidenceView?: undefined;
        transformsApplied?: undefined;
        capturedAt?: undefined;
        source?: undefined;
        title?: undefined;
        query?: undefined;
        redacted?: undefined;
        truncated?: undefined;
        excerptHash?: undefined;
        excerptChars?: undefined;
        claimSupported?: undefined;
    } | {
        evidenceId: any;
        resolution: string;
        detail: any;
        tool: any;
        sourceType: any;
        evidenceView: any;
        transformsApplied: any[];
        capturedAt: any;
        source: any;
        title: any;
        query: any;
        redacted: boolean;
        truncated: boolean;
        excerptHash: any;
        excerptChars: any;
        claimSupported: any;
    })[];
    evidenceCounts: {
        [k: string]: number;
    };
    evidenceReferenced: any;
    evidenceCaptureStatus: any;
    evidenceCaptureLostCount: any;
    joinStatus: string;
    supportLabels: any[];
}>;
/**
 * Join many turns, in the order given.
 *
 * Sequential on purpose. This reads a private evidence store on a machine that
 * is also serving an agent, and the work is not urgent enough to be worth
 * competing for its disk.
 */
export function inspectTurns(turns: any, opts?: {}): Promise<{
    schemaVersion: string;
    internalTurnId: any;
    turnId: any;
    sessionId: any;
    agentId: any;
    ts: any;
    pluginVersion: any;
    behaviorEpoch: any;
    trafficClass: any;
    trafficResolutionStatus: any;
    draft: any;
    final: any;
    claimExtraction: {
        claims: any;
        claimCount: any;
        extractionId: any;
        resolution: string;
        status: any;
        skipReason: any;
        scheduledAt?: undefined;
        abstentionReason?: undefined;
        startedAt?: undefined;
        completedAt?: undefined;
        lagMs?: undefined;
        latencyMs?: undefined;
        materialClaimCount?: undefined;
        provenance?: undefined;
    } | {
        claims: any;
        claimCount: any;
        extractionId: any;
        resolution: string;
        status: any;
        skipReason?: undefined;
        scheduledAt?: undefined;
        abstentionReason?: undefined;
        startedAt?: undefined;
        completedAt?: undefined;
        lagMs?: undefined;
        latencyMs?: undefined;
        materialClaimCount?: undefined;
        provenance?: undefined;
    } | {
        claims: any;
        claimCount: any;
        extractionId: any;
        resolution: string;
        status: string;
        scheduledAt: any;
        skipReason?: undefined;
        abstentionReason?: undefined;
        startedAt?: undefined;
        completedAt?: undefined;
        lagMs?: undefined;
        latencyMs?: undefined;
        materialClaimCount?: undefined;
        provenance?: undefined;
    } | {
        claims: any;
        claimCount: any;
        extractionId: any;
        resolution: string;
        status: any;
        abstentionReason: any;
        scheduledAt: any;
        startedAt: any;
        completedAt: any;
        lagMs: any;
        latencyMs: any;
        materialClaimCount: any;
        provenance: any;
        skipReason?: undefined;
    } | {
        claims: any;
        claimCount: any;
        abstentionReason?: string;
        resolution: string;
        status: string;
    };
    evidence: ({
        evidenceId: any;
        resolution: string;
        detail: any;
        tool?: undefined;
        sourceType?: undefined;
        evidenceView?: undefined;
        transformsApplied?: undefined;
        capturedAt?: undefined;
        source?: undefined;
        title?: undefined;
        query?: undefined;
        redacted?: undefined;
        truncated?: undefined;
        excerptHash?: undefined;
        excerptChars?: undefined;
        claimSupported?: undefined;
    } | {
        evidenceId: any;
        resolution: string;
        detail: any;
        tool: any;
        sourceType: any;
        evidenceView: any;
        transformsApplied: any[];
        capturedAt: any;
        source: any;
        title: any;
        query: any;
        redacted: boolean;
        truncated: boolean;
        excerptHash: any;
        excerptChars: any;
        claimSupported: any;
    })[];
    evidenceCounts: {
        [k: string]: number;
    };
    evidenceReferenced: any;
    evidenceCaptureStatus: any;
    evidenceCaptureLostCount: any;
    joinStatus: string;
    supportLabels: any[];
}[]>;
/** Counts by join status, for a corpus summary. */
export function summarizeInspections(inspections: any): {
    turns: any;
    byStatus: {
        [k: string]: number;
    };
    byExtraction: {
        [k: string]: number;
    };
    byTraffic: {};
    evidenceReferenced: number;
    evidenceResolved: number;
};
export const INSPECTION_SCHEMA_VERSION: "claim-evidence-inspection-v1";
/**
 * How a turn's evidence resolved, worst first.
 *
 * Precedence is by how much the result should be distrusted, not by how
 * interesting it is. An integrity failure means the store is telling us
 * something untrue, which outranks an abstention — abstention is an expected,
 * measured outcome, and a corrupt store is a fault in the instrument.
 */
export const JOIN_STATUSES: readonly string[];
/**
 * How a turn's extraction resolved.
 *
 * `pending` and `lost` are the two the settlement window exists to separate.
 * Extraction runs after delivery, so a turn record can be written and read
 * before the extraction store has caught up — and an inspector that read that
 * as loss would report a completion failure on every turn it happened to catch
 * mid-flight. Past the window, an extraction that announced itself and never
 * finished is a real loss: the process died holding it.
 */
export const EXTRACTION_RESOLUTIONS: readonly string[];
/**
 * How long after a turn an unwritten extraction is still merely late.
 *
 * Sixty seconds against a twenty-second extraction timeout: three times the
 * ceiling, so a record that has not appeared is not simply slow.
 */
export const DEFAULT_SETTLEMENT_MS: 60000;
/** How one referenced excerpt resolved. */
export const EVIDENCE_RESOLUTIONS: readonly string[];
