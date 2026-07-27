export declare const EVIDENCE_VERSION = 1;
export declare const DEFAULT_EVIDENCE_DIR: any;
/** OpenClaw session ids are operator-controlled; keep the filename inert. */
export declare function evidenceFileName(sessionId: any): string;
export declare function buildEvidence(entry: any, extra?: {}): {
    version: number;
    sessionId: any;
    runId: any;
    turnNonce: any;
    agentId: any;
    grounding: any;
    groundingVerified: boolean;
    correction: boolean;
    toolCalls: any;
    toolFailures: any;
    satisfiedBy: any;
    revisions: any;
    failClosed: boolean;
    fact: {
        eligible: boolean;
        kind: any;
        reason: any;
        calls: any;
        audits: any;
        revisions: any;
        outcome: {
            ok: boolean;
            code: any;
            factKey: any;
            revision: any;
            needsRematerialization: boolean;
            caseModel: any;
            caseAgentId: any;
        } | null;
    };
    thinkingLevel: any;
    updatedAt: string;
};
/**
 * Write one evidence record. Best effort: an unwritable directory must never
 * fail the agent turn — it degrades to "no evidence", which fails closed.
 */
export declare function writeEvidence(dir: any, sessionId: any, record: any, logger: any): Promise<any>;
/** Keep the evidence directory bounded; oldest-by-name pruning is enough. */
export declare function pruneEvidence(dir: any, maxFiles?: number): Promise<any>;
