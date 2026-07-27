import { test } from "node:test";
import assert from "node:assert/strict";

import { createGroundingStore, isReleasable } from "../src/state.js";

function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

test("a direct turn is releasable with no tools", () => {
  const store = createGroundingStore();
  const entry = store.begin({ runId: "r1", sessionKey: "s1", kind: null, reason: "arithmetic" });
  assert.equal(isReleasable(entry), true);
  assert.equal(entry.toolCalls, 0);
});

test("a web turn is not releasable until web_search succeeds", () => {
  const store = createGroundingStore();
  store.begin({ runId: "r1", sessionKey: "s1", kind: "web", reason: "named-external-fact" });
  assert.equal(isReleasable(store.get({ runId: "r1" })), false);

  store.recordTool({ runId: "r1", toolName: "web_fetch", ok: true });
  assert.equal(isReleasable(store.get({ runId: "r1" })), false, "web_fetch does not satisfy web");

  store.recordTool({ runId: "r1", toolName: "web_search", ok: true });
  assert.equal(isReleasable(store.get({ runId: "r1" })), true);
});

test("a failed grounding tool never satisfies the requirement", () => {
  const store = createGroundingStore();
  store.begin({ runId: "r1", sessionKey: "s1", kind: "web", reason: "current-information" });
  store.recordTool({ runId: "r1", toolName: "web_search", ok: false });
  const entry = store.get({ runId: "r1" });
  assert.equal(entry.toolCalls, 1);
  assert.equal(entry.toolFailures, 1);
  assert.equal(isReleasable(entry), false);
});

test("memory grounding accepts memory_search or wiki_search", () => {
  for (const tool of ["memory_search", "wiki_search"]) {
    const store = createGroundingStore();
    store.begin({ runId: "r", sessionKey: "s", kind: "memory", reason: "personal-or-project" });
    store.recordTool({ runId: "r", toolName: tool, ok: true });
    assert.equal(isReleasable(store.get({ runId: "r" })), true, tool);
  }
});

test("concurrent runs in one session stay isolated", () => {
  const store = createGroundingStore();
  store.begin({ runId: "rA", sessionKey: "s1", kind: "web", reason: "x" });
  store.begin({ runId: "rB", sessionKey: "s1", kind: "web", reason: "x" });
  store.recordTool({ runId: "rA", toolName: "web_search", ok: true });

  assert.equal(isReleasable(store.get({ runId: "rA" })), true);
  assert.equal(isReleasable(store.get({ runId: "rB" })), false);
});

test("session fallback resolves to the session's live turn", () => {
  const store = createGroundingStore();
  store.begin({ runId: "r1", sessionKey: "s1", kind: "web", reason: "x" });
  // A delivery hook with no run id must still find the turn.
  assert.equal(store.get({ sessionKey: "s1" })?.runId, "r1");
});

test("an unknown run id never inherits the live run's state", () => {
  const store = createGroundingStore();
  store.begin({ runId: "r1", sessionKey: "s1", kind: "web", reason: "x" });
  // Make the live run genuinely verified, so a fallback would hand out a
  // releasable entry rather than merely an unverified one.
  store.recordTool({ runId: "r1", toolName: "web_search", ok: true });
  assert.equal(isReleasable(store.get({ runId: "r1" })), true, "live run is verified");

  // A run id this store never classified must resolve to nothing, even though
  // the same session has a verified turn sitting right there.
  const other = store.get({ runId: "r2-unknown", sessionKey: "s1" });
  assert.equal(other, null, "unknown run must not resolve to the session's turn");
  assert.equal(isReleasable(other), false);
});

test("a fail-closed latch cannot leak to another run in the same session", () => {
  const store = createGroundingStore();
  store.begin({ runId: "rA", sessionKey: "s1", kind: "web", reason: "x" });
  store.markFailClosed({ runId: "rA" });
  // A different, unknown run in the same session must not pick up the latch.
  assert.equal(store.get({ runId: "rB", sessionKey: "s1" }), null);
});

test("recordTool credits only the run it names", () => {
  const store = createGroundingStore();
  store.begin({ runId: "rA", sessionKey: "s1", kind: "web", reason: "x" });
  store.begin({ runId: "rB", sessionKey: "s1", kind: "web", reason: "x" });

  // A tool result carrying an unknown run id belongs to neither tracked run.
  store.recordTool({ runId: "r-unknown", sessionKey: "s1", toolName: "web_search", ok: true });
  assert.equal(isReleasable(store.get({ runId: "rA" })), false, "rA must not be credited");
  assert.equal(isReleasable(store.get({ runId: "rB" })), false, "rB must not be credited");
  assert.equal(store.get({ runId: "rA" }).toolCalls, 0);
  assert.equal(store.get({ runId: "rB" }).toolCalls, 0);

  // The named run, and only that run, is credited.
  store.recordTool({ runId: "rA", sessionKey: "s1", toolName: "web_search", ok: true });
  assert.equal(isReleasable(store.get({ runId: "rA" })), true);
  assert.equal(isReleasable(store.get({ runId: "rB" })), false);
  assert.equal(store.get({ runId: "rB" }).toolCalls, 0);
});

test("the turn nonce is carried on the entry", () => {
  const store = createGroundingStore();
  store.begin({ runId: "r1", sessionKey: "s1", kind: "web", reason: "x", turnNonce: "a1b2c3d4" });
  assert.equal(store.get({ runId: "r1" }).turnNonce, "a1b2c3d4");
  // Native channels have no marker.
  store.begin({ runId: "r2", sessionKey: "s2", kind: "web", reason: "x" });
  assert.equal(store.get({ runId: "r2" }).turnNonce, null);
});

test("state expires and stays bounded", () => {
  const clock = fakeClock();
  const store = createGroundingStore({ ttlMs: 1000, maxEntries: 3, now: clock.now });
  store.begin({ runId: "r1", sessionKey: "s1", kind: "web", reason: "x" });
  clock.advance(1500);
  store.begin({ runId: "r2", sessionKey: "s2", kind: "web", reason: "x" });
  assert.equal(store.get({ runId: "r1" }), null, "expired entry is gone");

  for (let i = 0; i < 10; i += 1) {
    store.begin({ runId: `x${i}`, sessionKey: `sx${i}`, kind: null, reason: "x" });
  }
  assert.ok(store.size <= 3, `size ${store.size} should stay bounded`);
});

test("fail-closed latches and release clears state", () => {
  const store = createGroundingStore();
  store.begin({ runId: "r1", sessionKey: "s1", kind: "web", reason: "x" });
  store.recordTool({ runId: "r1", toolName: "web_search", ok: true });
  store.markFailClosed({ runId: "r1" });
  assert.equal(isReleasable(store.get({ runId: "r1" })), false, "latched fail-closed wins");

  store.release({ runId: "r1", sessionKey: "s1" });
  assert.equal(store.get({ runId: "r1" }), null);
  assert.equal(store.get({ sessionKey: "s1" }), null);
});

test("missing evidence is never releasable", () => {
  assert.equal(isReleasable(null), false);
  assert.equal(isReleasable(undefined), false);
});

test("revisions are counted", () => {
  const store = createGroundingStore();
  store.begin({ runId: "r1", sessionKey: "s1", kind: "web", reason: "x" });
  store.noteRevision({ runId: "r1" });
  assert.equal(store.get({ runId: "r1" }).revisions, 1);
});
