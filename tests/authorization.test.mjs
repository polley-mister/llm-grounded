// Three authorization boundaries, and the direction they may move in.
//
// The three guards on the vault write are not one decision made three times.
// They protect exposure, invocation and mutation, and they read three different
// context objects. What they must never do is get *looser* as a call travels
// inward — a later boundary admitting something an earlier one refused would
// mean the earlier one was decorative.
//
// These tests assert that as a property, over generated contexts, rather than
// by reading the three call sites and agreeing they look similar. That is what
// the earlier arrangement invited, and it is how a "consolidation" would
// quietly widen the narrowest of them.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  FACT_AUTHORIZATION_BOUNDARIES,
  mayExposeFactTools,
  mayInvokeFactTools,
  mayMutateFacts,
} from "../src/authorization.js";
import { createFactTool } from "../src/facts-tool.js";
import { createGroundingStore } from "../src/state.js";

const cfg = {
  factsEnabled: true,
  factsAgents: ["chat"],
  directSessionPrefixes: ["mc-chat"],
};

const OWNER = { agentId: "chat", sessionKey: "mc-chat-1", senderIsOwner: true };

/** Every shape of caller worth asking about, allowed and refused alike. */
const CONTEXTS = [
  ["owner, direct, allowed agent", OWNER],
  ["owner in a group", { ...OWNER, sessionKey: "agent:chat:x:group:1" }],
  ["owner in a channel", { ...OWNER, sessionKey: "agent:chat:x:channel:1" }],
  ["wrong agent", { ...OWNER, agentId: "market-research" }],
  ["no agent", { sessionKey: "mc-chat-1", senderIsOwner: true }],
  ["no session key", { agentId: "chat", senderIsOwner: true }],
  ["unrecognised session", { agentId: "chat", sessionKey: "discord:12345", senderIsOwner: true }],
  ["canonical explicit session, not owner-flagged", { agentId: "chat", sessionKey: "agent:chat:explicit:t-1" }],
  ["ordinary main session, not owner-flagged", { agentId: "chat", sessionKey: "agent:chat:main" }],
  ["webchat console on main", { agentId: "chat", sessionKey: "agent:chat:main", messageProvider: "webchat" }],
  ["one-shot cli", { agentId: "chat", sessionKey: "cli-run-1", oneShotCliRun: true }],
  ["empty context", {}],
  ["null context", null],
  ["undefined context", undefined],
];

// ---------------------------------------------------------------------------
// The invariant
// ---------------------------------------------------------------------------

test("a later boundary is never more permissive than an earlier one", () => {
  for (const [label, ctx] of CONTEXTS) {
    const expose = mayExposeFactTools(cfg, ctx).ok;
    const invoke = mayInvokeFactTools(cfg, ctx).ok;
    const mutate = mayMutateFacts(cfg, ctx, { boundKey: {}, boundTurn: {} }).ok;

    assert.ok(!invoke || expose, `${label}: invocation admitted what exposure refused`);
    assert.ok(!mutate || invoke, `${label}: mutation admitted what invocation refused`);
  }
});

test("mutation is strictly narrower: everything invocation allows, it may still refuse", () => {
  // The added requirement is a turn to attribute the write to.
  assert.equal(mayInvokeFactTools(cfg, OWNER).ok, true);
  assert.equal(mayMutateFacts(cfg, OWNER, { boundKey: null, boundTurn: null }).ok, false);
  assert.equal(mayMutateFacts(cfg, OWNER, { boundKey: {}, boundTurn: {} }).ok, true);
});

test("the three boundaries are named apart, so a call site says which one it is", () => {
  assert.deepEqual(FACT_AUTHORIZATION_BOUNDARIES, [
    "mayExposeFactTools",
    "mayInvokeFactTools",
    "mayMutateFacts",
  ]);
});

// ---------------------------------------------------------------------------
// Each boundary, on its own terms
// ---------------------------------------------------------------------------

test("exposure denied means the tool does not exist for that caller", () => {
  // Not "exists and refuses". A tool the model can see in a shared conversation
  // is a tool it will try to use there, and the refusal arrives as a visible
  // failure rather than the tool simply not being offered.
  for (const [label, ctx] of CONTEXTS) {
    if (mayExposeFactTools(cfg, ctx).ok) continue;
    assert.equal(mayExposeFactTools(cfg, ctx).ok, false, label);
  }
  assert.equal(mayExposeFactTools(cfg, { ...OWNER, sessionKey: "agent:chat:x:group:1" }).code, "not-direct-session");
  assert.equal(mayExposeFactTools(cfg, { ...OWNER, agentId: "market-research" }).code, "agent-not-allowed");
});

test("exposure allowed but execution denied: the mutation is rejected, not inherited", async () => {
  // The context the factory saw is not the context execute receives. A run
  // whose session changed shape in between must be refused on its own inputs.
  const store = createGroundingStore();
  const exposed = mayExposeFactTools(cfg, OWNER);
  assert.equal(exposed.ok, true, "exposure would have offered the tool");

  const tool = createFactTool({
    cfg,
    store,
    // …and then execute sees a group session.
    ctx: { ...OWNER, sessionKey: "agent:chat:x:group:1" },
    deps: {
      runCaseAudit: async () => { throw new Error("the audit must not be reached"); },
      commitFactTransaction: async () => { throw new Error("the vault must not be reached"); },
    },
  });
  const out = await tool.execute("call-1", { factKey: "a.b.c", subject: "A", property: "b", operation: "create", newValue: "v", targetPage: "p.md" });
  assert.equal(out.details.ok, false);
  assert.equal(out.details.code, "not-direct-session");
});

test("an execution context with no identity denies, and never inherits permission", async () => {
  const store = createGroundingStore();
  const tool = createFactTool({
    cfg,
    store,
    ctx: {},
    deps: {
      runCaseAudit: async () => { throw new Error("the audit must not be reached"); },
      commitFactTransaction: async () => { throw new Error("the vault must not be reached"); },
    },
  });
  const out = await tool.execute("call-1", { factKey: "a.b.c", subject: "A", property: "b", operation: "create", newValue: "v", targetPage: "p.md" });
  assert.equal(out.details.ok, false);
  assert.equal(out.details.code, "agent-not-allowed", "missing identity is refused, not treated as checked upstream");
});

test("an unbound call and a call whose turn is gone are told apart", async () => {
  // A wiring fault and a timing fault. One code for both would send a reader
  // looking in the wrong place.
  const store = createGroundingStore();
  const tool = createFactTool({
    cfg,
    store,
    ctx: OWNER,
    deps: {
      runCaseAudit: async () => { throw new Error("the audit must not be reached"); },
      commitFactTransaction: async () => { throw new Error("the vault must not be reached"); },
    },
  });
  const params = { factKey: "a.b.c", subject: "A", property: "b", operation: "create", newValue: "v", targetPage: "p.md" };

  const never = await tool.execute("never-bound", params);
  assert.equal(never.details.code, "unbound-call");

  // Bound to a run that has no entry: the binding resolves, the turn does not.
  store.begin({ runId: "run-1", sessionKey: "mc-chat-1", kind: null, reason: "x" });
  store.bindToolCall({ toolCallId: "call-2", runId: "run-1", sessionKey: "mc-chat-1" });
  store.release({ runId: "run-1" });
  const stale = await tool.execute("call-2", params);
  assert.equal(stale.details.code, "no-turn-state");
});
