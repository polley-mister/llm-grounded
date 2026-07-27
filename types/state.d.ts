/**
 * True when a search query is plainly about something other than the question.
 *
 * The contract verified that a tool ran, never that it ran on the right
 * subject. Observed failure: a turn asking the agent to change its own humor
 * setting produced a web_search about the horsepower figures discussed several
 * turns earlier, and the answer was accepted as grounded because a search had
 * happened.
 *
 * Deliberately conservative — it rejects only when there is NO overlap at all
 * and both sides have enough words to judge. Paraphrase, synonyms and narrowed
 * queries all still pass; the target is the wholly unrelated search, which is
 * the only case observed and the only one worth failing a turn over.
 */
export declare function queryIsUnrelated(userMessage: any, params: any): boolean;
export type GroundingEntry = {
    kind: "web" | "memory" | null;
    correction: boolean;
    reason: string;
    toolCalls: number;
    toolFailures: number;
    satisfiedBy: string[];
    verified: boolean;
    revisions: number;
    failClosed: boolean;
    failClosedEmitted: Record<string, number>;
    sessionKey: string | undefined;
    runId: string | undefined;
    turnNonce: string | null;
    /**
     * exact operator text for this turn
     */
    userMessage: string;
    /**
     * the assistant message this turn may correct
     */
    prevAssistant: string;
    wikiEvidence: Array<{
        tool: string;
        query: string;
        excerpt: string;
    }>;
    factEligible: boolean;
    factKind: "create" | "correct" | null;
    factReason: string;
    factUnambiguous: boolean;
    /**
     * whether this specific direct turn exposed the transaction tool
     */
    factTransactionAllowed: boolean;
    factCalls: number;
    caseAudits: number;
    factRevisions: number;
    factOutcome: object | null;
    factFailClosed: boolean;
    createdAt: number;
    updatedAt: number;
};
/**
 * In-memory, process-local store of per-turn obligations.
 *
 * @param {{ttlMs?: number, maxEntries?: number, now?: () => number}} [opts]
 *   `now` is injectable so tests can advance time without sleeping.
 */
export declare function createGroundingStore(opts?: {
    ttlMs?: number;
    maxEntries?: number;
    now?: () => number;
}): {
    /** Start (or restart) tracking for one turn. */
    begin({ runId, sessionKey, kind, correction, correctionScope, reason, turnNonce, userMessage, prevAssistant, fact, factTransactionAllowed }: {
        correction: any;
        correctionScope: any;
        fact: any;
        factTransactionAllowed: any;
        kind: any;
        prevAssistant: any;
        reason: any;
        runId: any;
        sessionKey: any;
        turnNonce: any;
        userMessage: any;
    }): GroundingEntry | null;
    /** Count one voice revision for this turn. */
    noteVoiceRevision({ runId, sessionKey }: {
        runId: any;
        sessionKey: any;
    }): GroundingEntry | null;
    /** Record one completed tool call. */
    recordTool({ runId, sessionKey, toolName, ok, params }: {
        ok: any;
        params: any;
        runId: any;
        sessionKey: any;
        toolName: any;
    }): GroundingEntry | null;
    /**
     * Retain a bounded excerpt of one successful wiki retrieval.
     *
     * This is the only vault evidence the CASE audit will ever see, and it is
     * captured from the run's own tool results rather than accepted from the
     * model — a quotation the model composes is not evidence of anything.
     */
    recordEvidence({ runId, sessionKey, toolName, params, result, maxItems, maxChars }: {
        maxChars: any;
        maxItems: any;
        params: any;
        result: any;
        runId: any;
        sessionKey: any;
        toolName: any;
    }): GroundingEntry | null;
    /** Bind a tool call id to the run that issued it. */
    bindToolCall({ toolCallId, runId, sessionKey }: {
        runId: any;
        sessionKey: any;
        toolCallId: any;
    }): any;
    /**
     * Resolve a bound tool call to its turn key. Single-use: the binding is
     * consumed, so a replayed tool call id cannot reach a live turn twice.
     */
    resolveToolCall(toolCallId: any): {
        runId: string | undefined;
        sessionKey: string | undefined;
    } | null;
    /** Count one evidence-backed fact transaction attempt for this turn. */
    noteFactCall({ runId, sessionKey }: {
        runId: any;
        sessionKey: any;
    }): GroundingEntry | null;
    /** Count one CASE audit for this turn. */
    noteCaseAudit({ runId, sessionKey }: {
        runId: any;
        sessionKey: any;
    }): GroundingEntry | null;
    /** Count one bounded fact-capture revision request. */
    noteFactRevision({ runId, sessionKey }: {
        runId: any;
        sessionKey: any;
    }): GroundingEntry | null;
    /**
     * Latch the fact fail-closed decision.
     *
     * Separate from `failClosed`, which belongs to the grounding gate: the two
     * have different causes and different replacement text, and a turn can hit
     * one without the other.
     */
    markFactFailClosed({ runId, sessionKey }: {
        runId: any;
        sessionKey: any;
    }): GroundingEntry | null;
    /** Capture the validated proposal a commit is about to be attempted with. */
    setFactProposal({ runId, sessionKey }: {
        runId: any;
        sessionKey: any;
    }, proposal: any): GroundingEntry | null;
    /** Spend one repair on a draft that falsely claimed durable persistence. */
    notePersistenceClaimRevision({ runId, sessionKey }: {
        runId: any;
        sessionKey: any;
    }): GroundingEntry | null;
    /**
     * Record what a terminal lane saw.
     *
     * Called before any early return, so a pass-through turn is observed too.
     * `external` distinguishes a lane that sends outward from the transcript
     * write, which is the only lane `deliver:false` reaches.
     */
    observeLane({ runId, sessionKey }: {
        runId: any;
        sessionKey: any;
    }, { lane, text, external }: {
        external?: boolean | undefined;
        lane: any;
        text: any;
    }): any;
    /** Correct a lane's observation once the plugin has substituted its text. */
    updateObservedText({ runId, sessionKey }: {
        runId: any;
        sessionKey: any;
    }, lane: any, text: any): any;
    /** Stash the resolved terminal decision for the delivery lanes to render. */
    setDelivery({ runId, sessionKey }: {
        runId: any;
        sessionKey: any;
    }, decision: any): GroundingEntry | null;
    /**
     * Claim the right to write this turn's terminal telemetry record.
     *
     * Returns true exactly once per turn, for the first lane that asks. Delivery
     * happens after finalize, so the first lane to fire is the only place that
     * can honestly report what shipped.
     */
    claimTerminalRecord({ runId, sessionKey }: {
        runId: any;
        sessionKey: any;
    }, lane: any): boolean;
    /** Record the terminal outcome of this turn's fact transaction. */
    setFactOutcome({ runId, sessionKey }: {
        runId: any;
        sessionKey: any;
    }, outcome: any): GroundingEntry | null;
    get({ runId, sessionKey }: {
        runId: any;
        sessionKey: any;
    }): GroundingEntry | null;
    /** Count one bounded revision request. */
    noteRevision({ runId, sessionKey }: {
        runId: any;
        sessionKey: any;
    }): GroundingEntry | null;
    /** Latch the fail-closed decision so delivery hooks agree with finalize. */
    markFailClosed({ runId, sessionKey }: {
        runId: any;
        sessionKey: any;
    }): GroundingEntry | null;
    /**
     * Count one fail-closed substitution for a delivery lane and report how
     * many have happened there before. A turn can produce several payloads;
     * the replacement line belongs on the first one only, and the rest are
     * cancelled rather than repeated. Lanes are counted separately because
     * `reply_payload_sending` and `message_sending` can both fire for one
     * delivery, and cancelling the second lane would drop the reply entirely.
     */
    noteFailClosedEmission({ runId, sessionKey, lane }: {
        lane: any;
        runId: any;
        sessionKey: any;
    }): number;
    /** Drop a turn's state once it can no longer be needed. */
    release({ runId, sessionKey }: {
        runId: any;
        sessionKey: any;
    }): void;
    expire: () => void;
    readonly size: number;
};
/**
 * Flatten an OpenClaw tool result into one bounded text excerpt.
 *
 * Tool results are `{content: [{type: "text", text}], details}`; some tools
 * return a bare string or a JSON-ish object. Anything unreadable yields "" and
 * is simply not treated as evidence.
 */
export declare function excerptFromToolResult(result: any, maxChars: any): string;
/**
 * Whether the turn may release its draft.
 * Missing evidence never releases the draft.
 *
 * @param {{kind: string|null, verified?: boolean, failClosed?: boolean}|null} entry
 * @returns {boolean}
 */
export declare function isReleasable(entry: {
    kind: string | null;
    verified?: boolean;
    failClosed?: boolean;
} | null): boolean;
