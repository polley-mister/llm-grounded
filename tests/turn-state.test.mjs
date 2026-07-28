// One turn, one entry, however the host names it at each hook.
//
// The host does not describe a turn the same way twice. `before_prompt_build`
// gets a run id, a session key and a session id; the delivery hooks get no run
// id; the agent-tool-result middleware gets nothing and reaches its turn only
// through a tool call id bound earlier. Every consumer used to derive its own
// key from whatever it had, and two derivations were in play at once — the
// store's `run:<id>` / `session:<key>`, and the telemetry maps' plain
// `runId ?? sessionKey`. A hook holding only a session key therefore wrote
// where the reader was not looking.
//
// These tests hand each hook a deliberately different subset of the identity
// and assert they all reach the same entry, and that the turn record contains
// what each of them contributed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createPlugin } from "../src/index.js";

import "./_vocabulary.mjs";

const dir = () => mkdtemp(path.join(tmpdir(), "turn-state-"));

const SEARCH = { results: [{ snippet: "Listed at $4,000 today." }] };
const TURN = { prompt: "[user-message:a]\nwhat is the price\n[/user-message:a]", messages: [] };

/** Full identity, as only `before_prompt_build` receives it. */
const FULL = {
  runId: "run-1",
  sessionKey: "mc-chat-9",
  sessionId: "mc-chat-9-abcdef",
  agentId: "tars-chat",
  senderIsOwner: true,
};

function config(captureDir, over = {}) {
  return {
    enabledAgents: ["main", "chat", "tars-chat"],
    evidenceCaptureEnabled: true,
    evidenceCaptureDir: captureDir,
    evidenceCaptureTrafficClasses: ["human", "synthetic_test"],
    telemetryDir: "/tmp/unused-telemetry",
    trafficClasses: { bySessionPrefix: { "mc-chat": "human" }, byAgent: { main: "heartbeat" }, default: "system" },
    ...over,
  };
}

function plugin(cfg) {
  const turns = [];
  const p = createPlugin({
    now: () => 1000,
    writeTurn: async (_d, r) => { turns.push(r); return null; },
    pruneTurns: async () => 0,
  });
  let mw = null;
  // Some handlers are registered wrapped — before_agent_finalize is wrapped to
  // record the draft on every exit path — so the test drives what the host
  // drives, not the bare handler underneath it.
  const registered = {};
  p.register({
    on: (name, fn) => { registered[name] = fn; },
    registerTool: () => {},
    registerAgentToolResultMiddleware: (h) => { mw = h; },
    config: { plugins: { entries: { "llm-grounded": { enabled: true, config: cfg } } } },
  });
  p.__turns = turns;
  p.__mw = mw;
  p.__on = registered;
  return p;
}

const files = async (d) => {
  try { return (await readdir(d)).filter((f) => f.endsWith(".json")); } catch { return []; }
};

const ctxOf = (over) => ({ ...FULL, ...over, pluginConfig: undefined });

// ---------------------------------------------------------------------------
// Resolution from a partial identity
// ---------------------------------------------------------------------------

test("a hook with only a session key reaches the turn opened with a run id", async () => {
  const d = await dir();
  const cfg = config(d);
  const p = plugin(cfg);

  await p.handlers.before_prompt_build(TURN, { ...FULL, pluginConfig: cfg });

  // Delivery hooks get no run id at all.
  const sessionOnly = { sessionKey: "mc-chat-9", agentId: "tars-chat", pluginConfig: cfg };
  await p.handlers.before_agent_finalize({ lastAssistantMessage: "About $4,000." }, sessionOnly);

  const viaRun = p.__store.get({ runId: "run-1" });
  const viaSessionKey = p.__store.get({ sessionKey: "mc-chat-9" });
  assert.ok(viaRun, "the turn exists");
  assert.equal(viaSessionKey, viaRun, "the same object, not an equal one");
  await rm(d, { recursive: true, force: true });
});

test("a hook with only a session id reaches it too", async () => {
  const d = await dir();
  const cfg = config(d);
  const p = plugin(cfg);
  await p.handlers.before_prompt_build(TURN, { ...FULL, pluginConfig: cfg });

  assert.equal(
    p.__store.get({ sessionId: "mc-chat-9-abcdef" }),
    p.__store.get({ runId: "run-1" }),
  );
  await rm(d, { recursive: true, force: true });
});

test("a tool call bound with a run id is reachable from a middleware with nothing", async () => {
  const d = await dir();
  const cfg = config(d);
  const p = plugin(cfg);
  await p.handlers.before_prompt_build(TURN, { ...FULL, pluginConfig: cfg });
  p.handlers.before_tool_call({ toolName: "web_search", toolCallId: "call-1" }, { ...FULL, pluginConfig: cfg });

  await p.__mw({ toolName: "web_search", toolCallId: "call-1", result: SEARCH }, {});

  assert.equal((await files(d)).length, 1);
  assert.equal(p.__store.get({ runId: "run-1" }).evidenceCapturedCount, 1);
  await rm(d, { recursive: true, force: true });
});

test("an unknown run id still resolves to nothing rather than to the session's turn", async () => {
  // Concurrency invariant, preserved through the move: falling back here could
  // hand one run's fail-closed latch to another run in the same session.
  const d = await dir();
  const cfg = config(d);
  const p = plugin(cfg);
  await p.handlers.before_prompt_build(TURN, { ...FULL, pluginConfig: cfg });

  assert.equal(p.__store.get({ runId: "run-unknown", sessionKey: "mc-chat-9" }), null);
  await rm(d, { recursive: true, force: true });
});

test("two runs in one session keep their own state, and the session names the newest", async () => {
  const d = await dir();
  const cfg = config(d);
  const p = plugin(cfg);

  await p.handlers.before_prompt_build(TURN, { ...FULL, runId: "run-1", pluginConfig: cfg });
  await p.handlers.before_prompt_build(
    { prompt: "[user-message:b]\nand the delivery date\n[/user-message:b]", messages: [] },
    { ...FULL, runId: "run-2", pluginConfig: cfg },
  );

  const first = p.__store.get({ runId: "run-1" });
  const second = p.__store.get({ runId: "run-2" });
  assert.ok(first && second);
  assert.notEqual(first, second, "two runs are two turns");
  assert.equal(p.__store.get({ sessionKey: "mc-chat-9" }), second, "the session names the current one");
  await rm(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// What each hook contributes lands on the one record
// ---------------------------------------------------------------------------

test("contributions from hooks with different identities all reach one turn record", async () => {
  const d = await dir();
  const cfg = config(d);
  const p = plugin(cfg);

  // 1. Full identity.
  await p.handlers.before_prompt_build(TURN, { ...FULL, pluginConfig: cfg });
  // 2. Run id and session key, no session id.
  p.handlers.before_tool_call({ toolName: "web_search", toolCallId: "c1" }, { runId: "run-1", sessionKey: "mc-chat-9", agentId: "tars-chat", pluginConfig: cfg });
  p.handlers.after_tool_call({ toolName: "web_search", toolCallId: "c1", result: SEARCH }, { runId: "run-1", agentId: "tars-chat", pluginConfig: cfg });
  // 3. A refused call seen with only a session key.
  p.handlers.before_tool_call(
    { toolName: "web_search", params: { query: "what is Sam Rivera's home address" }, toolCallId: "c2" },
    { sessionKey: "mc-chat-9", agentId: "tars-chat", pluginConfig: cfg },
  );
  // 4. Nothing but a bound tool call.
  await p.__mw({ toolName: "web_search", toolCallId: "c1", result: SEARCH }, {});
  // 5. Session key only.
  await p.__on.before_agent_finalize({ lastAssistantMessage: "About $4,000." }, { sessionKey: "mc-chat-9", agentId: "tars-chat", pluginConfig: cfg });
  // 6. Session id only.
  await p.handlers.agent_end({ sessionId: "mc-chat-9-abcdef" }, { sessionId: "mc-chat-9-abcdef", agentId: "tars-chat", pluginConfig: cfg });

  assert.equal(p.__turns.length, 1, "exactly one record");
  const rec = p.__turns[0];

  assert.equal(rec.turnId, "run-1", "the correlation key is unchanged");
  assert.ok(rec.internalTurnId, "and the internal id travels alongside");
  assert.deepEqual(rec.tools.map((t) => t.name), ["web_search"], "the tool call was recorded");
  assert.deepEqual(rec.blockedTools.map((b) => b.tool), ["web_search"], "the refusal was recorded");
  assert.equal(rec.toolBlocked, true);
  assert.ok(rec.draftCount >= 1, "the draft was recorded");
  assert.match(rec.draft, /About .4,000/);
  assert.equal(rec.policyMode, "advisory", "the policy was recorded");
  assert.ok(rec.evidenceIds.length >= 1, "the evidence was recorded");
  assert.equal(rec.trafficClass, "human");
  assert.ok(rec.latencyMs !== null, "the latency clock started at prompt build");
  await rm(d, { recursive: true, force: true });
});

test("an evidence record and its turn record file under the same correlation key", async () => {
  const d = await dir();
  const cfg = config(d);
  const p = plugin(cfg);

  await p.handlers.before_prompt_build(TURN, { ...FULL, pluginConfig: cfg });
  p.handlers.before_tool_call({ toolName: "web_search", toolCallId: "c1" }, { ...FULL, pluginConfig: cfg });
  await p.__mw({ toolName: "web_search", toolCallId: "c1", result: SEARCH }, {});
  await p.handlers.agent_end({ sessionKey: "mc-chat-9" }, { sessionKey: "mc-chat-9", agentId: "tars-chat", pluginConfig: cfg });

  const stored = await files(d);
  const evidence = JSON.parse(await (await import("node:fs/promises")).readFile(path.join(d, stored[0]), "utf8"));
  assert.equal(evidence.turnId, p.__turns[0].turnId, "capture and telemetry name the same turn");
  await rm(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Nothing outlives the turn
// ---------------------------------------------------------------------------

test("releasing a turn drops its aliases as well as its state", async () => {
  const d = await dir();
  const cfg = config(d);
  const p = plugin(cfg);
  await p.handlers.before_prompt_build(TURN, { ...FULL, pluginConfig: cfg });

  p.__store.release({ runId: "run-1" });
  for (const partial of [{ runId: "run-1" }, { sessionKey: "mc-chat-9" }, { sessionId: "mc-chat-9-abcdef" }]) {
    assert.equal(p.__store.get(partial), null, JSON.stringify(partial));
  }
  await rm(d, { recursive: true, force: true });
});

test("telemetry state is bounded by the turn that holds it", async () => {
  // It used to live in Maps with no bound of their own, deleted only on the
  // agent_end path. A turn that never reached agent_end leaked its drafts,
  // tools and matched features for the life of the process.
  const d = await dir();
  const cfg = config(d, { maxTrackedTurns: 10 });
  const p = plugin(cfg);

  for (let i = 0; i < 40; i += 1) {
    await p.handlers.before_prompt_build(TURN, { ...FULL, runId: `run-${i}`, sessionKey: `mc-chat-${i}`, sessionId: `sid-${i}`, pluginConfig: cfg });
    await p.handlers.before_agent_finalize({ lastAssistantMessage: `draft ${i}` }, { runId: `run-${i}`, agentId: "tars-chat", pluginConfig: cfg });
  }

  assert.ok(p.__store.size <= 10, `store bounded, saw ${p.__store.size}`);
  assert.equal(p.__store.get({ runId: "run-0" }), null, "the oldest turn is gone");
  assert.equal(p.__store.get({ sessionKey: "mc-chat-0" }), null, "and so is the way back to it");
  await rm(d, { recursive: true, force: true });
});
