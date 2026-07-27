// The session-local correction overlay.
//
// `facts-overlay.js` makes a *committed* record win over stale retrieved prose.
// It reads the vault index, which only a successful transaction writes. So when
// a commit fails, that overlay holds nothing, and this happens:
//
//   operator: It's an RX60.
//   agent:    Correct. RX60, not RX40. The vault update failed…
//   operator: How many exterior mouldings does my car have?
//   agent:    Your stored RX40 has four…
//
// The durable record is allowed to stay stale. The conversation is not allowed
// to forget what the operator just established. This module holds accepted
// corrections for the life of the session so retrieval results are corrected
// even though nothing was written.
//
// It is also what licenses the stronger persistence note. "The correction
// remains active for this conversation only" is a promise about the next turn;
// this is the thing that keeps it. `persistence.js` will not emit that wording
// unless an overlay is actually active.
//
// Bounded like everything else here: per-session cap, whole-session eviction,
// and it dies with the process. Nothing durable is written, deliberately —
// a failed durable write must not be quietly replaced by a different durable
// write in a place nobody is looking at.

/** Corrections held per session. Beyond this, the oldest is dropped. */
const DEFAULT_MAX_PER_SESSION = 32;
/** Sessions tracked at once. */
const DEFAULT_MAX_SESSIONS = 200;

/**
 * @param {{maxPerSession?: number, maxSessions?: number}} [opts]
 */
export function createSessionOverlay(opts = {}) {
  const maxPerSession = intOr(opts.maxPerSession, DEFAULT_MAX_PER_SESSION);
  const maxSessions = intOr(opts.maxSessions, DEFAULT_MAX_SESSIONS);

  /** @type {Map<string, Map<string, object>>} sessionKey -> factKey -> record */
  const sessions = new Map();

  function slot(sessionKey) {
    const id = String(sessionKey ?? "");
    if (!id) return null;
    let facts = sessions.get(id);
    if (!facts) {
      if (sessions.size >= maxSessions) {
        // Insertion order: the least recently created session goes first.
        const oldest = sessions.keys().next().value;
        if (oldest !== undefined) sessions.delete(oldest);
      }
      facts = new Map();
      sessions.set(id, facts);
    }
    return facts;
  }

  return {
    /**
     * Hold an accepted correction whose durable write did not land.
     *
     * Shaped like a vault overlay record so `facts-overlay.js` can merge the
     * two without knowing which is which.
     */
    hold({ sessionKey, factKey, subject, property, currentValue, supersededValues = [] }) {
      const facts = slot(sessionKey);
      if (!facts || !factKey || !currentValue) return null;
      // Re-holding a key refreshes its position, so the cap evicts genuinely
      // stale corrections rather than the most recently restated one.
      facts.delete(factKey);
      if (facts.size >= maxPerSession) {
        const oldest = facts.keys().next().value;
        if (oldest !== undefined) facts.delete(oldest);
      }
      const record = {
        subject: subject ?? "",
        property: property ?? "",
        currentValue,
        supersededValues: [...supersededValues].filter(Boolean),
        revision: "session",
        sessionOnly: true,
      };
      facts.set(factKey, record);
      return record;
    },

    /**
     * Drop a correction once it reaches durable storage.
     *
     * Called on a successful commit, including a later retry of an earlier
     * failure. Leaving it held would be harmless for reads but would keep
     * reporting `sessionOverlayApplied` for a fact that is now properly stored.
     */
    release({ sessionKey, factKey }) {
      const facts = sessions.get(String(sessionKey ?? ""));
      if (!facts) return false;
      const had = facts.delete(factKey);
      if (facts.size === 0) sessions.delete(String(sessionKey));
      return had;
    },

    /** Whether this session is holding anything. Gates the note's wording. */
    active(sessionKey) {
      const facts = sessions.get(String(sessionKey ?? ""));
      return Boolean(facts && facts.size > 0);
    },

    /** Overlay-shaped view for merging with the durable overlay. */
    snapshot(sessionKey) {
      const facts = sessions.get(String(sessionKey ?? ""));
      if (!facts || facts.size === 0) return { facts: {} };
      return { facts: Object.fromEntries(facts) };
    },

    /** Forget a whole session. */
    clear(sessionKey) {
      return sessions.delete(String(sessionKey ?? ""));
    },

    get size() {
      return sessions.size;
    },
  };
}

/**
 * Merge a durable overlay with a session overlay.
 *
 * The session wins on conflict. It is by definition newer: it exists only
 * because the operator corrected something the durable record still gets wrong.
 */
export function mergeOverlays(durable, session) {
  const a = durable?.facts ?? {};
  const b = session?.facts ?? {};
  if (Object.keys(b).length === 0) return durable ?? { facts: {} };
  return { ...(durable ?? {}), facts: { ...a, ...b } };
}

function intOr(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
