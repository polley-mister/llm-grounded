/** Where the truth of a claim comes from. Epistemic source, not subject. */
export declare const CLAIM_TYPES: readonly string[];
/** How the proposition is presented. Does not decide whether it is checkable. */
export declare const MODALITIES: readonly string[];
/** Evidence kinds. Multi-label: one claim may need several. */
export declare const EVIDENCE_KINDS: readonly string[];
export declare const ABSTENTION_REASONS: readonly string[];
export declare const SCHEMA_VERSION = "claims-v2";
export declare const PROMPT_VERSION = "claims-v2";
/**
 * Whether a claim was produced in the v2 shape.
 *
 * The parser accepts v1 so the frozen baseline can still be replayed, but a v2
 * run that quietly emits legacy-shaped claims would score as a success while
 * having ignored the contract. Counted rather than assumed.
 */
export declare function isV2Shape(raw: any): boolean;
/**
 * Split a draft into sentence spans, preserving offsets.
 *
 * Offsets are what make prediction-versus-gold matching deterministic later,
 * so they are carried rather than recomputed. Questions and quotations are
 * segmented like anything else and deliberately not removed.
 */
export declare function segment(draft: any): any[];
/**
 * Replace anything that looks like a credential before it reaches a model.
 *
 * Redaction is the one semantic-ish thing the deterministic layer does, and it
 * only ever removes; it never reclassifies.
 */
export declare function redact(text: any): string;
/**
 * Validate one claim against the contract.
 *
 * Returns null for anything off-schema. The caller abstains rather than
 * repairing: a half-understood claim is worse than none, because it enters the
 * ladder with authority it has not earned.
 */
export declare function validateClaim(raw: any, { draft, spans }: {
    draft: any;
    spans: any;
}): {
    id: any;
    surfaceText: any;
    proposition: any;
    text: any;
    dependsOn: any;
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
} | null;
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
export declare function checkAtomicity(claims: any): string | null;
/**
 * Parse and validate a whole extraction payload.
 *
 * Exported so the offline harness can replay recorded model output without a
 * live model.
 */
export declare function parseExtraction(text: any, { draft, spans }: {
    draft: any;
    spans: any;
}): {
    ok: boolean;
    reason: string;
    claims?: undefined;
} | {
    reason?: undefined;
    ok: boolean;
    claims: {
        surfaceText: any;
        proposition: any;
        text: any;
        dependsOn: any;
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
        id: any;
    }[];
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
export declare function extractClaims(input?: {
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
    detail: string | undefined;
    claims: never[];
} | {
    status: string;
    provenance: any;
    claims: never[];
} | {
    status: string;
    provenance: {
        provider: any;
        model: any;
        schemaVersion: string;
        promptVersion: string;
    };
    claims: {
        surfaceText: any;
        proposition: any;
        text: any;
        dependsOn: any;
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
        id: any;
    }[] | undefined;
}>;
/** Material claims that should be checked. The ladder's input. */
export declare function verificationTargets(extraction: any): any;
