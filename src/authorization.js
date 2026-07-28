// Three authorization boundaries, and the order they may only tighten in.
//
// The vault write is guarded three times, and for a while that read as one
// decision made three times over — the same two predicates, called from three
// places, against three different context objects. It is not. They protect
// different things:
//
//   exposure     may this caller see that the tool exists?
//   invocation   may this call proceed at all?
//   mutation     may this call reach the vault?
//
// Separate boundaries are correct here. Exposure has to be strict on its own,
// not merely backed up by execution: a tool the model can see in a shared
// conversation is a tool it will try to use there, and the refusal arrives as a
// visible failure rather than the tool simply not existing. And exposure is
// decided against the factory's context while invocation is decided against the
// tool's own execute context, which is a different object — so re-checking is
// not redundancy, it is the second boundary reading its own inputs.
//
// What was wrong was the naming. `isFactOperatorAuthorized` reads like the
// answer to "is this authorized", so three call sites of it read like three
// copies of one decision, and the natural next step is to "consolidate" them
// and quietly widen the narrowest.
//
// The invariant that makes the arrangement safe:
//
//   A later boundary may be stricter than an earlier one. It may never be more
//   permissive.
//
// Each predicate below therefore begins by requiring the previous one, so the
// nesting is structural rather than a property to be maintained by hand:
//
//   mayMutateFacts  ⊆  mayInvokeFactTools  ⊆  mayExposeFactTools
//
// A missing or unrecognised context denies at every boundary. Permission is
// never inherited from an earlier stage's verdict — each boundary re-derives
// it from the context it was given, and a context that carries no identity is
// refused rather than treated as "already checked upstream".

import { factsApplyToAgent } from "./config.js";

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
export function isDirectOwnerSession(sessionKey, ctx, cfg) {
  const key = typeof sessionKey === "string" ? sessionKey.trim() : "";
  if (!key) return { ok: false, reason: "no session key on this turn" };
  if (key.includes(":group:") || key.includes(":channel:")) {
    return { ok: false, reason: "group and channel sessions may not write vault facts" };
  }
  if (/^agent:[^:]+:explicit:[^:]+$/.test(key)) {
    return { ok: true, reason: "canonical explicit operator session" };
  }
  if (ctx?.oneShotCliRun === true) return { ok: true, reason: "one-shot cli run" };
  const prefixes = cfg?.directSessionPrefixes ?? [];
  if (prefixes.some((prefix) => key.startsWith(prefix))) {
    return { ok: true, reason: "explicit operator session" };
  }
  if (/^agent:[^:]+:main(?::|$)/.test(key)) return { ok: true, reason: "direct main session" };
  if (/:direct:[^:]+$/.test(key)) return { ok: true, reason: "direct peer session" };
  return { ok: false, reason: "session is not a recognized direct owner conversation" };
}

/**
 * OpenClaw reserves `senderIsOwner` for an allowlisted channel sender or a
 * Gateway client with operator.admin. the console deliberately connects
 * with narrower operator read/write scopes, so its authenticated loopback
 * calls arrive as `senderIsOwner: false`. Runtime-owned explicit sessions,
 * configured operator prefixes, and one-shot CLI runs remain trusted direct
 * control-plane contexts.
 */
export function isFactOperatorAuthorized(ctx, direct) {
  if (ctx?.senderIsOwner === true) return true;
  // The authenticated OpenClaw Control UI runs through the built-in `webchat`
  // transport. It deliberately uses the canonical per-agent `:main` session
  // rather than an `:explicit:` session, and its operator token normally has
  // read/write scope rather than operator.admin. The session shape is already
  // structurally direct (group/channel keys were rejected above), while
  // `messageProvider` is runtime-owned metadata rather than model input.
  // Treat this one narrow combination as the operator's direct console; do not
  // extend the exception to native channels or arbitrary `:main` sessions.
  if (direct?.ok === true && direct.reason === "direct main session" && ctx?.messageProvider === "webchat") {
    return true;
  }
  return direct?.ok === true && [
    "canonical explicit operator session",
    "explicit operator session",
    "one-shot cli run",
  ].includes(direct.reason);
}

/** @typedef {{ok: boolean, code: string|null, reason: string, direct: object|null}} AuthDecision */

const allow = (direct, reason) => ({ ok: true, code: null, reason, direct });
const deny = (code, reason) => ({ ok: false, code, reason, direct: null });

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
export function mayExposeFactTools(cfg, ctx) {
  if (!factsApplyToAgent(cfg, ctx?.agentId)) {
    return deny("agent-not-allowed", "this agent may not write vault facts");
  }
  const direct = isDirectOwnerSession(ctx?.sessionKey, ctx, cfg);
  // Owner authentication is not enough on its own: it stays true when the
  // operator speaks in a group or a channel.
  if (!direct.ok) return deny("not-direct-session", direct.reason);
  if (!isFactOperatorAuthorized(ctx, direct)) {
    return deny("not-owner", "only an owner-authenticated direct turn may write vault facts");
  }
  return allow(direct, direct.reason);
}

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
export function mayInvokeFactTools(cfg, ctx) {
  return mayExposeFactTools(cfg, ctx);
}

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
export function mayMutateFacts(cfg, ctx, state = {}) {
  const invoke = mayInvokeFactTools(cfg, ctx);
  if (!invoke.ok) return invoke;
  // Two different absences, kept apart. A call that was never bound is one
  // this plugin never saw issued; a bound call whose turn is gone is one that
  // outlived its own state. The first is a wiring fault, the second a timing
  // one, and a single code for both would send a reader to the wrong place.
  if (!state.boundKey) {
    return deny("unbound-call", "this tool call is not bound to a classified turn");
  }
  if (!state.boundTurn) {
    return deny("no-turn-state", "no turn state for this run");
  }
  return allow(invoke.direct, invoke.reason);
}

/**
 * The boundaries in order, for tests that assert the invariant directly rather
 * than by inspection.
 */
export const FACT_AUTHORIZATION_BOUNDARIES = Object.freeze([
  "mayExposeFactTools",
  "mayInvokeFactTools",
  "mayMutateFacts",
]);
