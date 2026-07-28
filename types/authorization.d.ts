/**
 * Session keys that may run a fact transaction.
 *
 * `senderIsOwner` alone is not enough: it stays true when the operator speaks in a
 * group or a channel, and a durable personal fact must not be minted from a
 * shared conversation. OpenClaw collapses direct chats to the agent's canonical
 * main bucket (`agent:<id>:main…`) or a per-peer direct bucket
 * (`…:direct:<peer>`), and keeps group/channel sessions isolated under `:group:`
 * / `:channel:` segments. Explicit keys — a front-end console and one-shot
 * CLI runs — use OpenClaw's canonical `agent:<id>:explicit:<session-id>`
 * shape. The Gateway marks authenticated operator calls as owner requests;
 * recognizing that canonical shape keeps the console direct while the
 * group/channel exclusions above remain structural. Non-canonical explicit
 * keys may still be admitted through the configured prefix allowlist.
 *
 * Known OpenClaw limitation: a tool context exposes `sessionKey`,
 * `messageChannel` and `oneShotCliRun`, but no first-class "this is a DM" flag.
 * Anything that does not positively match one of the direct shapes is refused
 * rather than guessed at, so an unrecognized native channel context fails
 * closed.
 */
export function isDirectOwnerSession(sessionKey: any, ctx: any, cfg: any): {
    ok: boolean;
    reason: string;
};
/**
 * OpenClaw reserves `senderIsOwner` for an allowlisted channel sender or a
 * Gateway client with operator.admin. the console deliberately connects
 * with narrower operator read/write scopes, so its authenticated loopback
 * calls arrive as `senderIsOwner: false`. Runtime-owned explicit sessions,
 * configured operator prefixes, and one-shot CLI runs remain trusted direct
 * control-plane contexts.
 */
export function isFactOperatorAuthorized(ctx: any, direct: any): boolean;
/**
 * Boundary 1 — exposure. May this caller see that the tool exists?
 *
 * Decided from the tool-factory context, per run. Returning a denial keeps
 * `vault_fact_commit` out of the model's tool list entirely, which is a
 * different and better outcome than offering it and refusing.
 *
 * @param {object} cfg
 * @param {{agentId?: string, sessionKey?: string}} ctx factory context
 * @returns {AuthDecision}
 */
export function mayExposeFactTools(cfg: object, ctx: {
    agentId?: string;
    sessionKey?: string;
}): AuthDecision;
/**
 * Boundary 2 — invocation. May this call proceed at all?
 *
 * The same requirements, re-derived from the tool's own execute context. That
 * context is not the one exposure saw, and the gap between them is the point:
 * a run whose session changed shape between exposure and execution must be
 * refused, not admitted on the strength of an earlier verdict.
 *
 * Deliberately no additional condition of its own today. It is a distinct
 * boundary because it reads distinct inputs, and it exists as a named function
 * so a future condition has an obvious and correct home.
 *
 * @param {object} cfg
 * @param {{agentId?: string, sessionKey?: string}} ctx tool execute context
 * @returns {AuthDecision}
 */
export function mayInvokeFactTools(cfg: object, ctx: {
    agentId?: string;
    sessionKey?: string;
}): AuthDecision;
/**
 * Boundary 3 — mutation. May this call reach the vault?
 *
 * Everything invocation requires, and a turn to attribute the write to. An
 * unbound call is one this plugin never classified, so there is no turn whose
 * evidence, budget or audit the write can be charged against — and a write
 * nobody can attribute is exactly the one that must not happen.
 *
 * @param {object} cfg
 * @param {object} ctx tool execute context
 * @param {{boundKey?: object|null, boundTurn?: object|null}} [state] the binding and the turn it resolved to
 * @returns {AuthDecision}
 */
export function mayMutateFacts(cfg: object, ctx: object, state?: {
    boundKey?: object | null;
    boundTurn?: object | null;
}): AuthDecision;
/**
 * The boundaries in order, for tests that assert the invariant directly rather
 * than by inspection.
 */
export const FACT_AUTHORIZATION_BOUNDARIES: readonly string[];
export type AuthDecision = {
    ok: boolean;
    code: string | null;
    reason: string;
    direct: object | null;
};
