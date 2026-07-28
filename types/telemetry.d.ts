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
export function behaviorIdentity(cfg: any, extra?: {}): Promise<any>;
/** Reset between tests, and after any deliberate config change. */
export function resetFingerprint(): void;
export function buildInfo(read?: any): any;
/** Test seam: drop the memoised build info. */
export function resetBuildInfo(): void;
export function buildTurnRecord(entry: any, extra?: {}): {
    ts: string;
    pluginVersion: any;
    pluginId: any;
    implementation: any;
    coreCommit: any;
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
    correctionOutcome: any;
    persistenceOutcome: any;
    responsePolicy: any;
    correctionAppliedToResponse: boolean;
    persistenceFailureNoted: boolean;
    sessionOverlayApplied: boolean;
    factCommitAttempted: boolean;
    factCommitSucceeded: boolean;
    persistenceClaimRevisions: any;
    emissionObserved: boolean;
    emittedLane: any;
    externalDeliveryObserved: boolean;
    deliveryAction: any;
    textMutatedByPlugin: boolean;
    terminalTextMismatch: boolean;
    observedLanes: any;
    evidenceIds: any;
    evidenceCaptureAttempted: boolean;
    evidenceCapturedCount: any;
    evidenceCaptureSkippedCount: any;
    evidenceCaptureLostCount: any;
    evidenceCaptureFailedCount: any;
    evidenceCaptureStatus: string;
    evidenceCaptureSkipReason: any;
    evidenceCaptureSkipReasons: any;
    runtimeConfigResolved: boolean;
    runtimeConfigReason: any;
    overlayConfigResolved: boolean;
    overlayApplied: boolean;
    overlaySkipReason: any;
    claimSupported: any;
    blockedTools: any;
    toolBlocked: boolean;
    trafficClass: any;
    trafficResolutionStatus: any;
    trafficClassSource: any;
    trafficClassResolvedAt: any;
    trafficIdentityMismatch: boolean;
    synthetic: boolean;
    syntheticReason: any;
    sessionId: any;
    agentId: any;
    runId: any;
    turnId: any;
    internalTurnId: any;
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
export function writeTurn(dir: any, record: any, logger: any): Promise<any>;
/** Drop day files older than the retention window. Never throws. */
export function pruneTurns(dir: any, retentionDays: number, logger: any): Promise<number>;
