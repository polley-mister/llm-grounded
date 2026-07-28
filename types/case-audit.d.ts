/**
 * Build the audit packet.
 *
 * `evidence` is the run's own successful wiki_search/wiki_get excerpts, already
 * bounded by the caller. The model never supplies any of this.
 */
export function buildAuditPacket({ userMessage, prevAssistant, evidence, proposal, prechecks, maxEvidenceChars, maxMessageChars, }: {
    userMessage: any;
    prevAssistant: any;
    evidence?: any[];
    proposal: any;
    prechecks?: {};
    maxEvidenceChars?: number;
    maxMessageChars?: number;
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
export function parseCaseDecision(text: any): {
    decision: string;
    supportedOldValue: string | null;
    supportedNewValue: string | null;
    reason: string;
} | null;
/**
 * Run one audit. Returns a discriminated result; never throws for a model
 * problem, because every model problem is the same answer: do not write.
 */
export function runCaseAudit({ llm, packet, timeoutMs, maxTokens, signal }: {
    llm: any;
    packet: any;
    timeoutMs: any;
    maxTokens?: number;
    signal: any;
}): Promise<{
    ok: boolean;
    code: string;
    message: string;
    attribution?: undefined;
    decision?: undefined;
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
    code?: undefined;
    message?: undefined;
}>;
/** Provider/model/agent attribution, with no credentials and no prompt text. */
export function attributionOf(result: any): {
    provider: any;
    model: any;
    agentId: any;
};
export const AUDIT_PURPOSE: "llm-grounded.vault-fact-audit";
export const CASE_AGENT_ID: "case";
export const AUDIT_DECISIONS: readonly string[];
