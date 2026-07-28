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
export function queryIsUnrelated(userMessage: any, params: any): boolean;
/**
 * In-memory, process-local store of per-turn obligations.
 *
 * @param {{ttlMs?: number, maxEntries?: number, now?: () => number}} [opts]
 *   `now` is injectable so tests can advance time without sleeping.
 */
export function createGroundingStore(opts?: {
    ttlMs?: number;
    maxEntries?: number;
    now?: () => number;
}): {
    /** Start (or restart) tracking for one turn. */
    begin({ runId, sessionKey, kind, correction, correctionScope, reason, turnNonce, userMessage, prevAssistant, fact, factTransactionAllowed }: {
        runId: any;
        sessionKey: any;
        kind: any;
        correction: any;
        correctionScope: any;
        reason: any;
        turnNonce: any;
        userMessage: any;
        prevAssistant: any;
        fact: any;
        factTransactionAllowed: any;
    }): GroundingEntry;
    /** Count one voice revision for this turn. */
    noteVoiceRevision({ runId, sessionKey }: {
        runId: any;
        sessionKey: any;
    }): GroundingEntry;
    /** Record one completed tool call. */
    recordTool({ runId, sessionKey, toolName, ok, params }: {
        runId: any;
        sessionKey: any;
        toolName: any;
        ok: any;
        params: any;
    }): GroundingEntry;
    /**
     * Retain a bounded excerpt of one successful wiki retrieval.
     *
     * This is the only vault evidence the CASE audit will ever see, and it is
     * captured from the run's own tool results rather than accepted from the
     * model — a quotation the model composes is not evidence of anything.
     */
    recordEvidence({ runId, sessionKey, toolName, params, result, maxItems, maxChars }: {
        runId: any;
        sessionKey: any;
        toolName: any;
        params: any;
        result: any;
        maxItems: any;
        maxChars: any;
    }): GroundingEntry;
    /** Bind a tool call id to the run that issued it. */
    bindToolCall({ toolCallId, runId, sessionKey }: {
        toolCallId: any;
        runId: any;
        sessionKey: any;
    }): any;
    /**
     * Resolve a bound tool call to its turn key. Single-use: the binding is
     * consumed, so a replayed tool call id cannot reach a live turn twice.
     */
    resolveToolCall(toolCallId: any): {
        runId: string;
        sessionKey: string;
    };
    /** Count one evidence-backed fact transaction attempt for this turn. */
    noteFactCall({ runId, sessionKey }: {
        runId: any;
        sessionKey: any;
    }): GroundingEntry;
    /** Count one CASE audit for this turn. */
    noteCaseAudit({ runId, sessionKey }: {
        runId: any;
        sessionKey: any;
    }): GroundingEntry;
    /** Count one bounded fact-capture revision request. */
    noteFactRevision({ runId, sessionKey }: {
        runId: any;
        sessionKey: any;
    }): GroundingEntry;
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
    }): GroundingEntry;
    /** Capture the validated proposal a commit is about to be attempted with. */
    setFactProposal({ runId, sessionKey }: {
        runId: any;
        sessionKey: any;
    }, proposal: any): GroundingEntry;
    /** Spend one repair on a draft that falsely claimed durable persistence. */
    notePersistenceClaimRevision({ runId, sessionKey }: {
        runId: any;
        sessionKey: any;
    }): GroundingEntry;
    /**
     * Record what a terminal lane saw.
     *
     * Called before any early return, so a pass-through turn is observed too.
     * `external` distinguishes a lane that sends outward from the transcript
     * write, which is the only lane `deliver:false` reaches.
     */
    /**
     * Record the outcome of capturing one tool call's evidence.
     *
     * Never throws and never rejects a turn: capture is best-effort by design,
     * and a bookkeeping failure must not be able to change what the operator
     * receives.
     */
    /**
     * Record that the plugin could not resolve its configuration.
     *
     * Never alters the turn. It marks the record so a corpus reader can tell a
     * degraded build from one that legitimately had nothing to capture.
     */
    noteRuntimeConfigUnresolved({ runId, sessionKey }: {
        runId: any;
        sessionKey: any;
    }, reason: any): GroundingEntry;
    /** Note that the fact overlay actually rewrote a retrieval. */
    noteOverlayApplied({ runId, sessionKey }: {
        runId: any;
        sessionKey: any;
    }): GroundingEntry;
    /** Record why evidence capture did not run for this tool call. */
    noteEvidenceSkip({ runId, sessionKey }: {
        runId: any;
        sessionKey: any;
    }, reason: any): GroundingEntry;
    noteEvidenceCapture({ runId, sessionKey }: {
        runId: any;
        sessionKey: any;
    }, outcome: any): GroundingEntry;
    observeLane({ runId, sessionKey }: {
        runId: any;
        sessionKey: any;
    }, { lane, text, external }: {
        lane: any;
        text: any;
        external?: boolean;
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
    }, decision: any): GroundingEntry;
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
    }, outcome: any): GroundingEntry;
    get({ runId, sessionKey }: {
        runId: any;
        sessionKey: any;
    }): GroundingEntry;
    /** Count one bounded revision request. */
    noteRevision({ runId, sessionKey }: {
        runId: any;
        sessionKey: any;
    }): GroundingEntry;
    /** Latch the fail-closed decision so delivery hooks agree with finalize. */
    markFailClosed({ runId, sessionKey }: {
        runId: any;
        sessionKey: any;
    }): GroundingEntry;
    /**
     * Count one fail-closed substitution for a delivery lane and report how
     * many have happened there before. A turn can produce several payloads;
     * the replacement line belongs on the first one only, and the rest are
     * cancelled rather than repeated. Lanes are counted separately because
     * `reply_payload_sending` and `message_sending` can both fire for one
     * delivery, and cancelling the second lane would drop the reply entirely.
     */
    noteFailClosedEmission({ runId, sessionKey, lane }: {
        runId: any;
        sessionKey: any;
        lane: any;
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
export function excerptFromToolResult(result: any, maxChars: any): string;
/**
 * Whether the turn may release its draft.
 * Missing evidence never releases the draft.
 *
 * @param {{kind: string|null, verified?: boolean, failClosed?: boolean}|null} entry
 * @returns {boolean}
 */
export function isReleasable(entry: {
    kind: string | null;
    verified?: boolean;
    failClosed?: boolean;
} | null): boolean;
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
