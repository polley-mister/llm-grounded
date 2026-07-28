/**
 * @param {{maxPerSession?: number, maxSessions?: number}} [opts]
 */
export function createSessionOverlay(opts?: {
    maxPerSession?: number;
    maxSessions?: number;
}): {
    /**
     * Hold an accepted correction whose durable write did not land.
     *
     * Shaped like a vault overlay record so `facts-overlay.js` can merge the
     * two without knowing which is which.
     */
    hold({ sessionKey, factKey, subject, property, currentValue, supersededValues }: {
        sessionKey: any;
        factKey: any;
        subject: any;
        property: any;
        currentValue: any;
        supersededValues?: any[];
    }): {
        subject: any;
        property: any;
        currentValue: any;
        supersededValues: any[];
        revision: string;
        sessionOnly: boolean;
    };
    /**
     * Drop a correction once it reaches durable storage.
     *
     * Called on a successful commit, including a later retry of an earlier
     * failure. Leaving it held would be harmless for reads but would keep
     * reporting `sessionOverlayApplied` for a fact that is now properly stored.
     */
    release({ sessionKey, factKey }: {
        sessionKey: any;
        factKey: any;
    }): boolean;
    /** Whether this session is holding anything. Gates the note's wording. */
    active(sessionKey: any): boolean;
    /** Overlay-shaped view for merging with the durable overlay. */
    snapshot(sessionKey: any): {
        facts: {
            [k: string]: any;
        };
    };
    /** Forget a whole session. */
    clear(sessionKey: any): boolean;
    readonly size: number;
};
/**
 * Merge a durable overlay with a session overlay.
 *
 * The session wins on conflict. It is by definition newer: it exists only
 * because the operator corrected something the durable record still gets wrong.
 */
export function mergeOverlays(durable: any, session: any): any;
