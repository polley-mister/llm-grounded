/**
 * Whether a claim was produced in the v2 shape.
 *
 * The parser accepts v1 so the frozen baseline can still be replayed, but a v2
 * run that quietly emits legacy-shaped claims would score as a success while
 * having ignored the contract. Counted rather than assumed.
 */
export function isV2Shape(raw: any): boolean;
/**
 * Split a draft into sentence spans, preserving offsets.
 *
 * Offsets are what make prediction-versus-gold matching deterministic later,
 * so they are carried rather than recomputed. Questions and quotations are
 * segmented like anything else and deliberately not removed.
 */
export function segment(draft: any): any[];
/**
 * Replace anything that looks like a credential before it reaches a model.
 *
 * Redaction is the one semantic-ish thing the deterministic layer does, and it
 * only ever removes; it never reclassifies.
 */
export function redact(text: any): string;
/**
 * Validate one claim against the contract.
 *
 * Returns null for anything off-schema. The caller abstains rather than
 * repairing: a half-understood claim is worse than none, because it enters the
 * ladder with authority it has not earned.
 */
export function validateClaim(raw: any, { draft, spans }: {
    draft: any;
    spans: any;
}): {
    id: any;
    surfaceText: any;
    proposition: any;
    text: any;
    dependsOn: any;
    dependsOnPremises: any;
    sourceStart: any;
    sourceEnd: any;
    sentenceIndex: any;
    claimType: any;
    modality: any;
    factual: boolean;
    material: boolean;
    verificationTarget: any;
    requiredEvidence: any[];
    confidence: number;
    v2Shape: boolean;
};
/**
 * Validate one implied evidence premise.
 *
 * A premise is a fact the answer *depends on* without stating it. "You are $500
 * short at today's price" asserts a comparison; the budget and the price are
 * required for it to hold, and neither has a span in the draft.
 *
 * Requiring every premise to be draft-anchored made that decomposition
 * impossible — the case failed in five of five runs — and the only ways out
 * were to invent spans or to accept a bundled claim. Both are worse than
 * naming the premise as what it is.
 */
export function validatePremise(raw: any): {
    id: any;
    proposition: any;
    sourceType: any;
    requiredEvidence: any[];
    explicitInDraft: boolean;
};
/**
 * Reject a claim set that is not atomic.
 *
 * Only the cases decidable *mechanically* are checked. A third rule was
 * considered and rejected — "the proposition contains several truth-evaluable
 * clauses" cannot be decided without parsing meaning, and a regex that tried
 * would be the same mistake as the classifier: a heuristic making a semantic
 * judgement it is not equipped to make. Non-atomicity of that kind shows up in
 * scoring instead, where a human can see it.
 *
 * @returns {string|null} a reason, or null when the set is acceptable
 */
export function checkAtomicity(claims: any, premises?: any[]): string | null;
/**
 * Parse and validate a whole extraction payload.
 *
 * Exported so the offline harness can replay recorded model output without a
 * live model.
 */
export function parseExtraction(text: any, { draft, spans }: {
    draft: any;
    spans: any;
}): {
    ok: boolean;
    reason: string;
    claims?: undefined;
    premises?: undefined;
} | {
    ok: boolean;
    claims: {
        id: any;
        surfaceText: any;
        proposition: any;
        text: any;
        dependsOn: any;
        dependsOnPremises: any;
        sourceStart: any;
        sourceEnd: any;
        sentenceIndex: any;
        claimType: any;
        modality: any;
        factual: boolean;
        material: boolean;
        verificationTarget: any;
        requiredEvidence: any[];
        confidence: number;
        v2Shape: boolean;
    }[];
    premises: {
        id: any;
        proposition: any;
        sourceType: any;
        requiredEvidence: any[];
        explicitInDraft: boolean;
    }[];
    reason?: undefined;
};
/**
 * Extract claims from one draft.
 *
 * Provider-neutral, mirroring `runCaseAudit` in case-audit.js: the model is
 * injected, a model problem is an outcome rather than an exception, and the
 * result is discriminated.
 *
 * The request deliberately carries no tools, no memory, no workspace context
 * and no persona. That isolation is asserted by test — a claim extractor that
 * can see the agent's persona is being asked to reason about its own output as
 * a character, which is not the question.
 *
 * @param {{userTurn?: string, draft?: string, conversationFacts?: string[]}} input
 * @param {{llm?: object, timeoutMs?: number, maxTokens?: number, signal?: object,
 *          minConfidence?: number}} [opts]
 */
export function extractClaims(input?: {
    userTurn?: string;
    draft?: string;
    conversationFacts?: string[];
}, opts?: {
    llm?: object;
    timeoutMs?: number;
    maxTokens?: number;
    signal?: object;
    minConfidence?: number;
}): Promise<{
    status: string;
    reason: any;
    detail: string;
    claims: any[];
} | {
    status: string;
    provenance: any;
    claims: any[];
}>;
/** Material claims that should be checked. The ladder's input. */
export function verificationTargets(extraction: any): any;
/** Where the truth of a claim comes from. Epistemic source, not subject. */
export const CLAIM_TYPES: readonly string[];
/** How the proposition is presented. Does not decide whether it is checkable. */
export const MODALITIES: readonly string[];
/** Evidence kinds. Multi-label: one claim may need several. */
export const EVIDENCE_KINDS: readonly string[];
export const ABSTENTION_REASONS: readonly string[];
export const SCHEMA_VERSION: "claims-v2";
export const PROMPT_VERSION: "claims-v2";
