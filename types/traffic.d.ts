/** True for a class this module is willing to emit. */
export function isTrafficClass(value: any): boolean;
/** True for a verdict that names a real class. */
export function isResolvedTraffic(verdict: any): boolean;
/**
 * Resolve the traffic class for one turn.
 *
 * Precedence, most specific first:
 *   1. a configured session-key or session-id prefix
 *   2. a built-in prefix marking test traffic
 *   3. a configured agent id
 *   4. the configured default
 *
 * Session identity wins over agent identity because one agent serves several
 * kinds of traffic: `main` answers both the scheduled heartbeat and a named
 * operations run, and only the session tells them apart.
 *
 * Before any of that: a turn with no identity at all is unresolved. A written
 * `default: "system"` is the operator's answer for turns that carry identity
 * and match no rule. It is not an answer for turns that carry no identity, and
 * letting it serve as one is what made missing host metadata indistinguishable
 * from a configured decision.
 *
 * @param {{sessionId?: string, sessionKey?: string, agentId?: string}} meta
 *   host metadata, never turn content
 * @param {{bySessionPrefix?: Record<string,string>, byAgent?: Record<string,string>,
 *          default?: string}} [rules]
 * @returns {TrafficVerdict}
 */
export function resolveTrafficClass(meta?: {
    sessionId?: string;
    sessionKey?: string;
    agentId?: string;
}, rules?: {
    bySessionPrefix?: Record<string, string>;
    byAgent?: Record<string, string>;
    default?: string;
}): TrafficVerdict;
/** @typedef {"human"|"heartbeat"|"scheduled_automation"|"system"|"synthetic_test"} TrafficClass */
/**
 * @typedef {object} TrafficVerdict
 * @property {"resolved"|"unresolved"} status
 * @property {TrafficClass|null} trafficClass the class, or null when unresolved
 * @property {string} reason which rule matched, or why none could
 * @property {{sessionId: string|null, sessionKey: string|null, agentId: string|null}} signals
 */
export const TRAFFIC_CLASSES: readonly string[];
export type TrafficClass = "human" | "heartbeat" | "scheduled_automation" | "system" | "synthetic_test";
export type TrafficVerdict = {
    status: "resolved" | "unresolved";
    /**
     * the class, or null when unresolved
     */
    trafficClass: TrafficClass | null;
    /**
     * which rule matched, or why none could
     */
    reason: string;
    signals: {
        sessionId: string | null;
        sessionKey: string | null;
        agentId: string | null;
    };
};
