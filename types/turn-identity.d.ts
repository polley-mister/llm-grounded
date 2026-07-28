/**
 * The alias index.
 *
 * @param {{newId?: () => string}} [opts] `newId` is injectable so tests and
 *   replays get stable ids; nothing about the value is meaningful.
 */
export function createTurnIndex(opts?: {
    newId?: () => string;
}): {
    /**
     * Mint an id for a turn and index every alias its host identity provides.
     *
     * Re-registering the same host identity returns the existing id rather than
     * minting a second one: `before_prompt_build` fires again on every prompt
     * rebuild, and a rebuild is the same turn.
     */
    register(identity?: {}): any;
    /**
     * Point this turn's aliases at it, taking any that named another turn.
     *
     * Taking is correct and is what a session alias means: a session key names
     * whichever turn is current, and a new turn in an existing session is
     * exactly the case where that has changed. A run alias is never contested,
     * because a run id belongs to one turn for its lifetime.
     */
    adopt(turnId: any, identity?: {}): any;
    /**
     * Find the turn some partial host metadata refers to.
     *
     * A supplied run id is authoritative and is not backed away from: if it
     * names no known turn, the answer is "no turn", not "whatever this session
     * did last". An earlier version of the store did fall back, which could
     * hand one run's verified tool call or fail-closed latch to a different
     * concurrent run in the same session.
     */
    resolve(partial?: {}): any;
    /** Drop a turn's aliases. Called when its entry is evicted or expires. */
    forget(turnId: any): void;
    /** Test-only: how many aliases are held, so leaks are assertable. */
    readonly size: number;
};
