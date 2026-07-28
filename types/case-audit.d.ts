export declare const AUDIT_PURPOSE = "llm-grounded.vault-fact-audit";
export declare const CASE_AGENT_ID = "case";
export declare const AUDIT_DECISIONS: readonly string[];
/**
 * Build the audit packet.
 *
 * `evidence` is the run's own successful wiki_search/wiki_get excerpts, already
 * bounded by the caller. The model never supplies any of this.
 */
export declare function buildAuditPacket({ userMessage, prevAssistant, evidence, proposal, prechecks, maxEvidenceChars, maxMessageChars, }: {
    evidence?: never[] | undefined;
    maxEvidenceChars?: number | undefined;
    maxMessageChars?: number | undefined;
    prechecks?: {} | undefined;
    prevAssistant: any;
    proposal: any;
    userMessage: any;
}): {
    role: string;
    content: string;
}[];
/**
 * Parse CASE's reply under a strict contract.
 *
 * Fenced, oversized, multi-object, extra-key, or wrong-typed output all fail
 * closed by returning null. There is deliberately no repair step: a auditor
 * that cannot emit four fields is an auditor whose judgement we should not be
 * acting on.
 *
 * @returns {{decision: string, supportedOldValue: string|null,
 *            supportedNewValue: string|null, reason: string}|null}
 */
export declare function parseCaseDecision(text: any): {
    decision: string;
    supportedOldValue: string | null;
    supportedNewValue: string | null;
    reason: string;
} | null;
/**
 * Run one audit. Returns a discriminated result; never throws for a model
 * problem, because every model problem is the same answer: do not write.
 */
export declare function runCaseAudit({ llm, packet, timeoutMs, maxTokens, signal }: {
    llm: any;
    maxTokens?: number | undefined;
    packet: any;
    signal: any;
    timeoutMs: any;
}): Promise<{
    ok: boolean;
    code: string;
    message: string;
    decision?: undefined;
    attribution?: undefined;
} | {
    ok: boolean;
    code: string;
    message: string;
    attribution: {
        provider: any;
        model: any;
        agentId: any;
    };
    decision?: undefined;
} | {
    code?: undefined;
    message?: undefined;
    ok: boolean;
    decision: {
        decision: string;
        supportedOldValue: string | null;
        supportedNewValue: string | null;
        reason: string;
    };
    attribution: {
        provider: any;
        model: any;
        agentId: any;
    };
}>;
/** Provider/model/agent attribution, with no credentials and no prompt text. */
export declare function attributionOf(result: any): {
    provider: any;
    model: any;
    agentId: any;
};
