/**
 * Behaviour identity for a record.
 *
 * Split rather than a single fingerprint so analysis can ask which surface
 * moved. A prompt edit and a rule edit both change behaviour, but they change
 * different things, and a combined hash only says "something differs".
 *
 * This is what makes rolling epochs work: development need not stop, because
 * every record carries the exact configuration that produced it. Freeze
 * interpretability, not progress.
 */
export declare function behaviorIdentity(cfg: any, extra?: {}): Promise<any>;
/** Reset between tests, and after any deliberate config change. */
export declare function resetFingerprint(): void;
/**
 * Build the record from a completed turn's store entry.
 *
 * Kept pure so it can be unit tested without touching the filesystem, and so
 * the shape is asserted in tests rather than discovered later when Phase 4
 * finds a field missing.
 */
export declare function buildTurnRecord(entry: any, extra?: {}): {
    ts: string;
    pluginVersion: any;
    behaviorEpoch: any;
    promptHash: any;
    rulesetHash: any;
    configHash: any;
    policyMode: any;
    hardTrigger: any;
    hardReason: any;
    correctionScope: any;
    evidenceSource: any;
    policyScope: any;
    legacyVerdict: any;
    legacyReason: any;
    legacyWouldCompel: any;
    actualToolUsed: boolean;
    blockedTools: any;
    toolBlocked: boolean;
    synthetic: boolean;
    syntheticReason: any;
    sessionId: any;
    agentId: any;
    runId: any;
    turnId: any;
    turn: string;
    verdict: {
        kind: any;
        reason: any;
        correction: boolean;
        enforced: boolean;
    };
    features: any;
    tools: any;
    draft: string;
    final: string;
    draftCount: any;
    gates: {
        revised: any;
        voiceRevised: any;
        failedClosed: any;
        offTopicTools: any;
        voiceViolations: any;
    };
    model: any;
    latencyMs: any;
    draftWords: number;
    replyWords: number;
};
/** Append one record. Never throws. */
export declare function writeTurn(dir: any, record: any, logger: any): Promise<any>;
/** Drop day files older than the retention window. Never throws. */
export declare function pruneTurns(dir: any, retentionDays: number | undefined, logger: any): Promise<number>;
