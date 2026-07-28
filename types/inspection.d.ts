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
        abstentionReason?: string;
        status: string;
        claims: any[];
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
        abstentionReason?: string;
        status: string;
        claims: any[];
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
/** How one referenced excerpt resolved. */
export const EVIDENCE_RESOLUTIONS: readonly string[];
