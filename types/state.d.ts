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
    begin({ runId, sessionKey, sessionId, kind, correction, correctionScope, reason, turnNonce, userMessage, prevAssistant, fact, factTransactionAllowed, traffic }: {
        runId: any;
        sessionKey: any;
        sessionId: any;
        kind: any;
        correction: any;
        correctionScope: any;
        reason: any;
        turnNonce: any;
        userMessage: any;
        prevAssistant: any;
        fact: any;
        factTransactionAllowed: any;
        traffic: any;
    }): GroundingEntry;
    /**
     * Record the matched classifier features, and start the latency clock.
     *
     * Read-only signals: they never influence a decision, they explain one.
     */
    noteTelemetryFeatures(ref: any, features: any, startedAt: any): GroundingEntry;
    /** Record which policy governed this turn, and what the legacy verdict said. */
    noteTelemetryPolicy(ref: any, policy: any): GroundingEntry;
    /** Append one draft pass. Identical consecutive text is one pass, not two. */
    noteTelemetryDraft(ref: any, text: any): GroundingEntry;
    /** Append one tool call, with its parameters already sanitized by the caller. */
    noteTelemetryTool(ref: any, call: any): GroundingEntry;
    /** Append one refused tool call. A count of zero is the success criterion. */
    noteTelemetryBlocked(ref: any, blocked: any): GroundingEntry;
    /** Count one voice revision for this turn. */
    noteVoiceRevision(ref: any): GroundingEntry;
    /** Record one completed tool call. */
    recordTool(ref: any): GroundingEntry;
    /**
     * Retain a bounded excerpt of one successful wiki retrieval.
     *
     * This is the only vault evidence the CASE audit will ever see, and it is
     * captured from the run's own tool results rather than accepted from the
     * model — a quotation the model composes is not evidence of anything.
     */
    recordEvidence(ref: any): GroundingEntry;
    /** Bind a tool call id to the run that issued it. */
    bindToolCall({ toolCallId, runId, sessionKey, sessionId }: {
        toolCallId: any;
        runId: any;
        sessionKey: any;
        sessionId: any;
    }): any;
    /**
     * Whether this tool call was ever bound, regardless of whether its turn
     * still exists.
     *
     * `resolveToolCall` answers null for both "never bound" and "bound to a
     * turn that has since gone", which made the second indistinguishable from
     * the first — a timing fault reported as a wiring fault, and the
     * `no-turn-state` branch that existed to say so was unreachable.
     */
    hasToolCallBinding(toolCallId: any): boolean;
    /**
     * Resolve a bound tool call to its turn key. Single-use: the binding is
     * consumed, so a replayed tool call id cannot reach a live turn twice.
     */
    resolveToolCall(toolCallId: any): {
        runId: string;
        sessionKey: string;
        sessionId: string;
        turnId: string;
    };
    /**
     * Look up a bound tool call without consuming the binding.
     *
     * `resolveToolCall` is single-use so a replayed id cannot reach a live turn
     * twice, which is right for the fact transaction. Evidence capture needs
     * the same turn identity but must not spend the binding the fact path
     * depends on, so it peeks.
     */
    peekToolCall(toolCallId: any): {
        runId: string;
        sessionKey: string;
        sessionId: string;
        turnId: string;
    };
    /** Count one evidence-backed fact transaction attempt for this turn. */
    noteFactCall(ref: any): GroundingEntry;
    /** Count one CASE audit for this turn. */
    noteCaseAudit(ref: any): GroundingEntry;
    /** Count one bounded fact-capture revision request. */
    noteFactRevision(ref: any): GroundingEntry;
    /**
     * Latch the fact fail-closed decision.
     *
     * Separate from `failClosed`, which belongs to the grounding gate: the two
     * have different causes and different replacement text, and a turn can hit
     * one without the other.
     */
    markFactFailClosed(ref: any): GroundingEntry;
    /** Capture the validated proposal a commit is about to be attempted with. */
    setFactProposal(ref: any, proposal: any): GroundingEntry;
    /** Spend one repair on a draft that falsely claimed durable persistence. */
    notePersistenceClaimRevision(ref: any): GroundingEntry;
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
    noteRuntimeConfigUnresolved(ref: any, reason: any): GroundingEntry;
    /** Note that the fact overlay actually rewrote a retrieval. */
    noteOverlayApplied(ref: any): GroundingEntry;
    /**
     * Note that the host later presented a different identity for this turn.
     *
     * Does not touch `traffic`. The recorded class remains what it was — the
     * point of storing it is that it stops moving.
     */
    noteTrafficIdentityMismatch(ref: any): GroundingEntry;
    /** Record why evidence capture did not run for this tool call. */
    noteEvidenceSkip(ref: any, reason: any): GroundingEntry;
    noteEvidenceCapture(ref: any, outcome: any): GroundingEntry;
    observeLane(ref: any, { lane, text, external }: {
        lane: any;
        text: any;
        external?: boolean;
    }): any;
    /** Correct a lane's observation once the plugin has substituted its text. */
    updateObservedText(ref: any, lane: any, text: any): any;
    /** Stash the resolved terminal decision for the delivery lanes to render. */
    setDelivery(ref: any, decision: any): GroundingEntry;
    /**
     * Claim the right to write this turn's terminal telemetry record.
     *
     * Returns true exactly once per turn, for the first lane that asks. Delivery
     * happens after finalize, so the first lane to fire is the only place that
     * can honestly report what shipped.
     */
    claimTerminalRecord(ref: any, lane: any): boolean;
    /** Record the terminal outcome of this turn's fact transaction. */
    setFactOutcome(ref: any, outcome: any): GroundingEntry;
    get({ runId, sessionKey, sessionId }: {
        runId: any;
        sessionKey: any;
        sessionId: any;
    }): GroundingEntry;
    /** Count one bounded revision request. */
    noteRevision(ref: any): GroundingEntry;
    /** Latch the fail-closed decision so delivery hooks agree with finalize. */
    markFailClosed(ref: any): GroundingEntry;
    /**
     * Count one fail-closed substitution for a delivery lane and report how
     * many have happened there before. A turn can produce several payloads;
     * the replacement line belongs on the first one only, and the rest are
     * cancelled rather than repeated. Lanes are counted separately because
     * `reply_payload_sending` and `message_sending` can both fire for one
     * delivery, and cancelling the second lane would drop the reply entirely.
     */
    noteFailClosedEmission(ref: any): number;
    /** Drop a turn's state once it can no longer be needed. */
    release({ runId, sessionKey, sessionId }: {
        runId: any;
        sessionKey: any;
        sessionId: any;
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
    sessionId: string | undefined;
    /**
     * internal id; not derived from any host field
     */
    turnId: string;
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
    traffic: (import("./traffic.js").TrafficVerdict & {
        resolvedAt: string;
        identity: object;
    }) | null;
    trafficIdentityMismatch: boolean;
    /**
     * eligible excerpts dropped, not merely ineligible
     */
    evidenceCaptureLostCount: number;
    /**
     * every reason, with counts
     */
    evidenceCaptureSkipReasons: Record<string, number>;
    telemetry: {
        features: object;
        startedAt: number | null;
        drafts: string[];
        tools: object[];
        policy: object | null;
        blockedTools: object[];
    };
    createdAt: number;
    updatedAt: number;
};
