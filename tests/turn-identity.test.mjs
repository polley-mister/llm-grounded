// Alias resolution: one turn found from whatever the host happened to say.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createTurnIndex } from "../src/turn-identity.js";

const FULL = { runId: "run-1", sessionKey: "mc-chat-9", sessionId: "mc-chat-9-abc" };

test("a turn is found from any single field the host supplies", () => {
  const ix = createTurnIndex();
  const id = ix.register(FULL);

  assert.equal(ix.resolve({ runId: "run-1" }), id);
  assert.equal(ix.resolve({ sessionKey: "mc-chat-9" }), id);
  assert.equal(ix.resolve({ sessionId: "mc-chat-9-abc" }), id);
  assert.equal(ix.resolve(FULL), id);
});

test("the internal id is not derived from host metadata", () => {
  // If it were, something would eventually reconstruct it instead of resolving
  // it, and the second derivation is the whole defect being removed here.
  const ix = createTurnIndex();
  const id = ix.register(FULL);
  for (const value of Object.values(FULL)) {
    assert.ok(!id.includes(value), `${id} leaks ${value}`);
  }
});

test("ids are unique across indexes, not merely within one", () => {
  // The counter alone restarts with the gateway, which put `t1` on two
  // unrelated turns from two different days in the first corpus that joined on
  // internalTurnId. Two indexes stand in for two processes here.
  const a = createTurnIndex();
  const b = createTurnIndex();
  const first = a.register({ runId: "run-1" });
  const second = b.register({ runId: "run-1" });
  assert.notEqual(first, second, "two processes must not name different turns the same");
});

test("the id carries no host metadata even with a process prefix", () => {
  const ix = createTurnIndex();
  const id = ix.register({ runId: "run-1", sessionKey: "mc-chat-9", sessionId: "sid-1" });
  for (const value of ["run-1", "mc-chat-9", "sid-1"]) {
    assert.ok(!id.includes(value), `${id} leaks ${value}`);
  }
});

test("registering the same turn twice does not mint a second id", () => {
  // before_prompt_build fires again on every prompt rebuild.
  const ix = createTurnIndex();
  const first = ix.register(FULL);
  const second = ix.register(FULL);
  assert.equal(second, first);
});

test("a rebuild carrying less identity still resolves to the same turn", () => {
  const ix = createTurnIndex();
  const id = ix.register(FULL);
  assert.equal(ix.register({ runId: "run-1" }), id);
  assert.equal(ix.resolve({ sessionKey: "mc-chat-9" }), id, "the fuller identity is not lost");
});

test("a partial registration is completed later, not duplicated", () => {
  // A hook may learn the session id only after the run id is known.
  const ix = createTurnIndex();
  const id = ix.register({ runId: "run-1" });
  assert.equal(ix.resolve({ sessionId: "late-session" }), null);
  ix.adopt(id, { sessionId: "late-session" });
  assert.equal(ix.resolve({ sessionId: "late-session" }), id);
});

test("an unknown run id resolves to nothing, and never to the session's last turn", () => {
  // The invariant a previous store version violated: falling back to the
  // session here could hand one run's fail-closed latch to a different
  // concurrent run in the same session.
  const ix = createTurnIndex();
  ix.register(FULL);
  assert.equal(ix.resolve({ runId: "run-2", sessionKey: "mc-chat-9" }), null);
});

test("a new turn in the same session takes the session aliases", () => {
  const ix = createTurnIndex();
  const first = ix.register({ runId: "run-1", sessionKey: "mc-chat-9" });
  const second = ix.register({ runId: "run-2", sessionKey: "mc-chat-9" });

  assert.notEqual(second, first);
  assert.equal(ix.resolve({ sessionKey: "mc-chat-9" }), second, "the session names the current turn");
  assert.equal(ix.resolve({ runId: "run-1" }), first, "the run still names its own turn");
});

test("a run alias is never taken from the turn that owns it", () => {
  const ix = createTurnIndex();
  const first = ix.register({ runId: "run-1", sessionKey: "a" });
  ix.register({ runId: "run-2", sessionKey: "b" });
  assert.equal(ix.resolve({ runId: "run-1" }), first);
});

test("namespaces keep a run id from colliding with an identical session id", () => {
  const ix = createTurnIndex();
  const byRun = ix.register({ runId: "shared-value" });
  const bySession = ix.register({ sessionId: "shared-value" });
  assert.notEqual(bySession, byRun);
  assert.equal(ix.resolve({ runId: "shared-value" }), byRun);
  assert.equal(ix.resolve({ sessionId: "shared-value" }), bySession);
});

test("empty and non-string metadata resolve to nothing rather than to a turn", () => {
  const ix = createTurnIndex();
  ix.register(FULL);
  for (const partial of [{}, { runId: "" }, { sessionKey: null }, { sessionId: undefined }, { runId: 7 }]) {
    assert.equal(ix.resolve(partial), null, JSON.stringify(partial));
  }
});

test("forgetting a turn leaves no aliases behind", () => {
  const ix = createTurnIndex();
  const id = ix.register(FULL);
  assert.equal(ix.size, 3);
  ix.forget(id);
  assert.equal(ix.size, 0);
  assert.equal(ix.resolve(FULL), null);
});

test("forgetting a turn does not strip an alias another turn has taken", () => {
  // Otherwise evicting an old turn would silently unname the live one.
  const ix = createTurnIndex();
  const first = ix.register({ runId: "run-1", sessionKey: "mc-chat-9" });
  const second = ix.register({ runId: "run-2", sessionKey: "mc-chat-9" });
  ix.forget(first);
  assert.equal(ix.resolve({ sessionKey: "mc-chat-9" }), second);
  assert.equal(ix.resolve({ runId: "run-1" }), null);
});
