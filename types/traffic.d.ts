/** True for a class this module is willing to emit. */
export function isTrafficClass(value: any): boolean;
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
 * @param {{sessionId?: string, sessionKey?: string, agentId?: string}} meta
 *   host metadata, never turn content
 * @param {{bySessionPrefix?: Record<string,string>, byAgent?: Record<string,string>,
 *          default?: string}} [rules]
 * @returns {{trafficClass: TrafficClass, reason: string, signals: object}}
 */
export function resolveTrafficClass(meta?: {
    sessionId?: string;
    sessionKey?: string;
    agentId?: string;
}, rules?: {
    bySessionPrefix?: Record<string, string>;
    byAgent?: Record<string, string>;
    default?: string;
}): {
    trafficClass: TrafficClass;
    reason: string;
    signals: object;
};
/** @typedef {"human"|"heartbeat"|"scheduled_automation"|"system"|"synthetic_test"} TrafficClass */
export const TRAFFIC_CLASSES: readonly string[];
export type TrafficClass = "human" | "heartbeat" | "scheduled_automation" | "system" | "synthetic_test";
