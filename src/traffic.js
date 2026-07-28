// Who or what produced this turn.
//
// The Phase 0 corpus recorded scheduled heartbeat runs as ordinary use. Every
// rate computed from it was therefore a rate over robot traffic, and the
// heartbeat runs every 30 minutes — so it dominates by volume and would have
// quietly become the denominator of the false-positive number this whole
// exercise exists to produce.
//
// Two rules about how the answer is obtained:
//
//   * From host metadata, never from the prompt text. "Read HEARTBEAT.md" is a
//     string a human could type, and a classifier that reads turn content is
//     the same mistake as routing on capitalisation.
//   * From explicit configured rules, not from shape-guessing. An earlier
//     sketch inferred "heartbeat" from the session id looking like a bare UUID.
//     That is an accident of `heartbeat.isolatedSession: true` rather than a
//     property of heartbeats, and it would silently reclassify every turn the
//     day that setting changed.
//
// And one rule about what an answer is. A verdict is either *resolved* — a rule
// the operator wrote matched this turn's identity — or *unresolved*, and an
// unresolved turn has no class at all. This function used to return `system`
// for three different situations: a configured default, an absent default, and
// a misconfigured one. Only the first is a decision. The other two were
// "nothing is known" wearing a real class's name, and that is how evidence
// capture came to be excluded on every production turn for four releases — the
// tool-result middleware carries no session or agent identity, so it fell to
// the default, and the default looked like an answer.
//
// The raw signals stay on the record alongside the verdict, so a turn can be
// re-scored when the rules change instead of being stranded.

/** @typedef {"human"|"heartbeat"|"scheduled_automation"|"system"|"synthetic_test"} TrafficClass */

/**
 * @typedef {object} TrafficVerdict
 * @property {"resolved"|"unresolved"} status
 * @property {TrafficClass|null} trafficClass the class, or null when unresolved
 * @property {string} reason which rule matched, or why none could
 * @property {{sessionId: string|null, sessionKey: string|null, agentId: string|null}} signals
 */

export const TRAFFIC_CLASSES = Object.freeze([
  "human",
  "heartbeat",
  "scheduled_automation",
  "system",
  "synthetic_test",
]);

/**
 * Prefixes recognised without configuration.
 *
 * Only the two that mark a turn as *not real traffic*. Everything else is
 * deployment-specific and must be configured, because guessing which sessions
 * are human is exactly the judgement that should not live in a library.
 */
const BUILTIN_PREFIXES = Object.freeze({
  "synthetic-": "synthetic_test",
  "smoke-": "synthetic_test",
});

/** True for a class this module is willing to emit. */
export function isTrafficClass(value) {
  return TRAFFIC_CLASSES.includes(value);
}

/** True for a verdict that names a real class. */
export function isResolvedTraffic(verdict) {
  return verdict?.status === "resolved" && isTrafficClass(verdict.trafficClass);
}

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
export function resolveTrafficClass(meta = {}, rules = {}) {
  const sessionId = str(meta.sessionId);
  const sessionKey = str(meta.sessionKey);
  const agentId = str(meta.agentId);
  const signals = { sessionId: sessionId || null, sessionKey: sessionKey || null, agentId: agentId || null };

  if (!sessionId && !sessionKey && !agentId) {
    return unresolved("identity_unavailable", signals);
  }

  const configured = rules.bySessionPrefix ?? {};
  // Longest prefix first, so a specific rule beats a general one regardless of
  // the order an operator happened to write them in.
  const prefixes = Object.keys(configured).sort((a, b) => b.length - a.length);
  for (const prefix of prefixes) {
    if (!prefix) continue;
    if (startsWithAny([sessionId, sessionKey], prefix)) {
      return finish(configured[prefix], `session-prefix:${prefix}`, signals);
    }
  }

  for (const [prefix, cls] of Object.entries(BUILTIN_PREFIXES)) {
    if (startsWithAny([sessionId, sessionKey], prefix)) {
      return finish(cls, `builtin-prefix:${prefix}`, signals);
    }
  }

  const byAgent = rules.byAgent ?? {};
  if (agentId && Object.hasOwn(byAgent, agentId)) {
    return finish(byAgent[agentId], `agent:${agentId}`, signals);
  }

  return finish(rules.default, "default", signals);
}

/**
 * Never emit a class outside the enum, and never emit one nobody chose.
 *
 * Label drift is what makes a corpus unqueryable: "Performance Assurance
 * Intent" and "Performance Intent" as two labels for one thing. An
 * unrecognised value is refused rather than admitted under a fallback name,
 * and the offending value is kept in the reason, so the misconfiguration is
 * visible in the data instead of silently splitting a bucket.
 */
function finish(value, reason, signals) {
  if (isTrafficClass(value)) return { status: "resolved", trafficClass: value, reason, signals };
  if (value == null || value === "") return unresolved("configuration_unresolved:unset", signals);
  return unresolved(`configuration_unresolved:invalid(${String(value).slice(0, 40)})`, signals);
}

function unresolved(reason, signals) {
  return { status: "unresolved", trafficClass: null, reason, signals };
}

function startsWithAny(candidates, prefix) {
  return candidates.some((c) => c && c.startsWith(prefix));
}

function str(value) {
  return typeof value === "string" ? value.trim() : "";
}
