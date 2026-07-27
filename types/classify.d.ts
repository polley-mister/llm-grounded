/**
 * Register the operator's own names, projects, hosts, and schedule vocabulary.
 *
 * Called once at plugin load from resolved config. Terms are matched
 * case-insensitively on word boundaries, and each is also treated as a
 * personally-owned proper noun so it cannot be mistaken for an external entity.
 *
 * @param {string[]} terms
 */
export declare function configurePersonalTerms(terms: string[]): void;
/** Read back what is configured. Exported for tests and for describeFeatures. */
export declare function personalTermCount(): number;
/** True for a brief conversational reaction with no external premise. */
export declare function isAcknowledgement(message: any): any;
/** True when the turn is about the agent's own Live Settings. */
export declare function isSelfSettingsQuestion(message: any): any;
/**
 * A declarative counter-claim: no question mark, a negation that is not the
 * opening word, and at least one word of subject before it.
 */
export declare function isNegatedAssertion(message: any): boolean;
/** Remove transport framing. Returns the original if stripping empties it. */
export declare function stripChannelContext(message: any): string;
/**
 * Register the names this agent answers to, so being addressed by name is not
 * mistaken for a reference to something in the outside world.
 *
 * @param {string[]} names
 */
export declare function configureAgentNames(names: string[]): void;
/**
 * Remove a leading greeting and/or vocative address. Returns the original text
 * when stripping would empty it, so a bare "hey" is still a greeting.
 */
export declare function stripVocative(message: any): string;
/**
 * Lowercase counterpart to `hasNamedExternalEntity`.
 *
 * Real questions are rarely capitalized — "how did romily die from
 * lord of the rings" names an external person and an external work with no capital
 * letter anywhere. This finds a content word in subject position after an
 * interrogative frame, or the source a claim is attributed to, and treats a
 * word that is neither ordinary English nor ours as an external referent.
 */
export declare function hasLowercaseExternalReference(message: any): boolean;
/**
 * Best-effort detection of a named external person, work, event, product, or
 * place. Conservative in one direction only: when it is unsure it says "named",
 * because an unnecessary web_search costs a search while a wrong unverified
 * claim costs trust.
 */
export declare function hasNamedExternalEntity(message: any): boolean;
/**
 * Return the operator's turn from a composed prompt. Native OpenClaw channels
 * send the bare message and carry no markers, so the prompt is returned as-is.
 *
 * @param {string} prompt
 * @returns {string}
 */
export declare function extractUserTurn(prompt: string): string;
/**
 * The per-turn nonce the console wraps around the operator's message.
 *
 * This is the only value in the run that is unique to one the console turn.
 * The OpenClaw CLI derives its run id from the session id when no `--run-id` is
 * passed (and `openclaw agent` exposes no such flag), so every turn in a chat
 * session shares one run id and one session id. Recording the nonce in the
 * evidence record is what lets the console bind a record to the exact turn
 * it is about to release, rather than to any turn in the session.
 *
 * Returns null for native channels, which carry no marker.
 *
 * @param {string} prompt
 * @returns {string|null}
 */
export declare function extractTurnNonce(prompt: string): string | null;
/**
 * The most recent assistant text in a run's prepared session messages.
 *
 * This is the claim a contextual correction is correcting — "It's an TC20."
 * means nothing without it. Assistant content arrives as an array of typed
 * parts; a bare string is accepted too, because not every harness normalizes.
 * Anything unreadable yields "", which makes a correction ineligible rather
 * than guessed at.
 *
 * @param {unknown[]} messages
 * @returns {string}
 */
export declare function lastAssistantText(messages: unknown[]): string;
/**
 * A non-current question about the agent itself.
 *
 * Answered from the prompt files that are already in context, so it needs no
 * store and no search. Two exclusions keep it honest: anything with a
 * current-information marker ("is the gateway still running", "what did you
 * just deploy") is a live-state question and stays grounded, and anything that
 * names an external entity ("are you sure Romily died first") is a factual
 * claim wearing a second-person opener.
 *
 * @param {string} message
 * @returns {boolean}
 */
export declare function isSelfReferenceQuestion(message: string): boolean;
/**
 * Classify one user turn.
 *
 * @param {string} message raw user text for this turn
 * @param {{prevAssistant?: string, contextualCorrection?: boolean}} [context]
 * @returns {{kind: "web"|"memory"|null, correction: boolean, reason: string}}
 */
export declare function classifyGrounding(message: string, context?: {
    prevAssistant?: string;
    contextualCorrection?: boolean;
}): {
    kind: "web" | "memory" | null;
    correction: boolean;
    reason: string;
};
/**
 * Report which signals a turn trips, without deciding anything.
 *
 * Phase 0 telemetry records this alongside the verdict so old traffic can be
 * re-scored when a rule changes. A verdict alone is not enough: "web" tells you
 * the outcome but not whether CURRENT_INFO or the proper-noun heuristic caused
 * it, so a later edit to one of them cannot be evaluated against past turns.
 *
 * Deliberately read-only and deliberately not consulted by classifyGrounding.
 * If this function ever influences a decision it stops being an instrument and
 * becomes another rule to maintain.
 */
export declare function describeFeatures(message: any): {
    words?: undefined;
    currentInfo?: undefined;
    memoryTerms?: undefined;
    personalTerms?: undefined;
    acknowledgement?: undefined;
    selfSettings?: undefined;
    selfState?: undefined;
    selfReference?: undefined;
    selfTerms?: undefined;
    directShape?: undefined;
    correctionShape?: undefined;
    emotionShape?: undefined;
    namedEntity?: undefined;
    lowercaseExternal?: undefined;
    arithmetic?: undefined;
} | {
    words: number;
    currentInfo: boolean;
    memoryTerms: boolean;
    personalTerms: boolean;
    acknowledgement: boolean;
    selfSettings: boolean;
    selfState: boolean;
    selfReference: boolean;
    selfTerms: boolean;
    directShape: boolean;
    correctionShape: boolean;
    emotionShape: boolean;
    namedEntity: boolean;
    lowercaseExternal: boolean;
    arithmetic: boolean;
};
/** Tool names that satisfy each grounding kind. */
export declare const SATISFYING_TOOLS: {
    web: string[];
    memory: string[];
};
/**
 * The exact fail-closed reply. Never reword: acceptance asserts it verbatim.
 *
 * Deliberately short and plain. This is the most frequently seen line the
 * assistant produces, so it sets the register more than any other single
 * string. Process vocabulary ("verify", "invent", "the missing piece") reads
 * as a compliance notice rather than as the agent, and at seven words this matches
 * the length a terse agent actually speaks at.
 */
export declare const FAIL_CLOSED_TEXT = "I couldn't confirm that. I won't guess.";
