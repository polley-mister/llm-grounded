// One turn, one identity, however partially the host describes it.
//
// The host describes a turn differently at each hook. `before_prompt_build`
// gets a run id, a session key and a session id. The delivery hooks get no run
// id at all. The agent-tool-result middleware gets nothing, and reaches its
// turn only through a tool call id bound earlier. Every place that needed to
// find "the state for this turn" therefore invented its own derivation, and
// they disagreed:
//
//   the state store      runId ? `run:${runId}` : `session:${sessionKey}`
//   the telemetry maps   runId ?? sessionKey
//
// Those are different strings for the same turn, and the difference is not
// theoretical: a hook holding only a session key writes to `mc-chat-9` while
// the entry lives under `run:abc`, so one logical turn occupies two identities
// depending on which metadata its observer happened to receive. That is the
// same shape as the traffic defect — several derivations of one fact — and it
// gets worse with every field added to a turn.
//
// So identity is minted once and looked up by alias. The internal id is
// meaningless on purpose: it is not a run id, so nothing can be tempted to
// reconstruct it from host metadata instead of resolving it.

/** Alias namespaces, so a run id equal to some session id cannot collide. */
const RUN = "run";
const SESSION_KEY = "skey";
const SESSION_ID = "sid";

/**
 * Resolution order, most specific first.
 *
 * A run identifies exactly one turn. A session identifies whichever turn spoke
 * most recently, which is the right answer for the delivery hooks and the wrong
 * answer for anything that could have said "run".
 */
const LOOKUP_ORDER = [
  [RUN, "runId"],
  [SESSION_KEY, "sessionKey"],
  [SESSION_ID, "sessionId"],
];

function alias(namespace, value) {
  return typeof value === "string" && value ? `${namespace}:${value}` : null;
}

/**
 * The alias index.
 *
 * @param {{newId?: () => string}} [opts] `newId` is injectable so tests and
 *   replays get stable ids; nothing about the value is meaningful.
 */
export function createTurnIndex(opts = {}) {
  let counter = 0;
  const newId = typeof opts.newId === "function" ? opts.newId : () => `t${(counter += 1)}`;

  /** alias -> turn id */
  const aliases = new Map();
  /** turn id -> the aliases it owns, so forgetting a turn leaves nothing behind */
  const owned = new Map();

  return {
    /**
     * Mint an id for a turn and index every alias its host identity provides.
     *
     * Re-registering the same host identity returns the existing id rather than
     * minting a second one: `before_prompt_build` fires again on every prompt
     * rebuild, and a rebuild is the same turn.
     */
    register(identity = {}) {
      const existing = this.resolve(identity);
      if (existing) {
        this.adopt(existing, identity);
        return existing;
      }
      const turnId = newId();
      this.adopt(turnId, identity);
      return turnId;
    },

    /**
     * Point this turn's aliases at it, taking any that named another turn.
     *
     * Taking is correct and is what a session alias means: a session key names
     * whichever turn is current, and a new turn in an existing session is
     * exactly the case where that has changed. A run alias is never contested,
     * because a run id belongs to one turn for its lifetime.
     */
    adopt(turnId, identity = {}) {
      for (const [namespace, field] of LOOKUP_ORDER) {
        const key = alias(namespace, identity[field]);
        if (!key) continue;
        const previous = aliases.get(key);
        if (previous && previous !== turnId) {
          owned.get(previous)?.delete(key);
        }
        aliases.set(key, turnId);
        if (!owned.has(turnId)) owned.set(turnId, new Set());
        owned.get(turnId).add(key);
      }
      return turnId;
    },

    /**
     * Find the turn some partial host metadata refers to.
     *
     * A supplied run id is authoritative and is not backed away from: if it
     * names no known turn, the answer is "no turn", not "whatever this session
     * did last". An earlier version of the store did fall back, which could
     * hand one run's verified tool call or fail-closed latch to a different
     * concurrent run in the same session.
     */
    resolve(partial = {}) {
      if (typeof partial.runId === "string" && partial.runId) {
        return aliases.get(alias(RUN, partial.runId)) ?? null;
      }
      for (const [namespace, field] of LOOKUP_ORDER) {
        const key = alias(namespace, partial[field]);
        if (!key) continue;
        const found = aliases.get(key);
        if (found) return found;
      }
      return null;
    },

    /** Drop a turn's aliases. Called when its entry is evicted or expires. */
    forget(turnId) {
      for (const key of owned.get(turnId) ?? []) aliases.delete(key);
      owned.delete(turnId);
    },

    /** Test-only: how many aliases are held, so leaks are assertable. */
    get size() {
      return aliases.size;
    },
  };
}
