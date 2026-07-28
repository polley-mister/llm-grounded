// One turn, one traffic identity.
//
// The defect this file exists to prevent: `resolveTrafficClass` was called at
// two seams with two different inputs, and the answers disagreed. Telemetry saw
// full host identity and recorded "human"; the agent-tool-result middleware saw
// none, fell to the configured default, and recorded
// `traffic_class_excluded:system`. Evidence capture was therefore configured,
// enabled, reported healthy, and inert on every production turn from 0.2.0 to
// 0.2.4.
//
// The tests are shaped like the host rather than like a convenient fixture:
// identity-rich initialization followed by identity-poor middleware. The
// previous suite passed an identity-rich context to the middleware too, which
// is a sequence that never occurs in production, and that is the only reason
// this was green for four releases.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createPlugin } from "../src/index.js";

import "./_vocabulary.mjs";

const dir = () => mkdtemp(path.join(tmpdir(), "traffic-id-"));

const SEARCH = { results: [{ snippet: "Listed at $4,000 today." }] };
const TURN = { prompt: "[user-message:a]\nwhat is the price\n[/user-message:a]", messages: [] };

function config(captureDir, over = {}) {
  return {
    // The production list. Without it the default is ["main", "chat"] and every
    // hook declines the turn before any of this is reached.
    enabledAgents: ["main", "chat", "tars-chat"],
    evidenceCaptureEnabled: true,
    evidenceCaptureDir: captureDir,
    evidenceCaptureTrafficClasses: ["human", "synthetic_test"],
    telemetryDir: "/tmp/unused-telemetry",
    trafficClasses: {
      bySessionPrefix: { "mc-chat": "human", "ops-triage": "scheduled_automation", "sys-": "system" },
      byAgent: { "tars-chat": "human", main: "heartbeat" },
      default: "system",
    },
    ...over,
  };
}

function recorder() {
  const lines = { info: [], warn: [], error: [], debug: [] };
  const push = (k) => (m) => lines[k].push(String(m));
  return { lines, info: push("info"), warn: push("warn"), error: push("error"), debug: push("debug") };
}

/** Registered the way OpenClaw registers it: config only via the runtime entry. */
function plugin(cfg, log = recorder()) {
  const turns = [];
  const p = createPlugin({
    now: () => 1000,
    writeTurn: async (_d, r) => { turns.push(r); return null; },
    pruneTurns: async () => 0,
  });
  let mw = null;
  p.register({
    on: () => {},
    registerTool: () => {},
    registerAgentToolResultMiddleware: (h) => { mw = h; },
    logger: log,
    config: { plugins: { entries: { "llm-grounded": { enabled: true, config: cfg } } } },
  });
  p.__turns = turns;
  p.__log = log;
  p.__mw = mw;
  return p;
}

/**
 * The middleware as production delivers it: no run id, no session, no agent.
 *
 * Measured, not assumed — the 0.2.3 diagnostics reported hasSessionKey=false,
 * hasRunId=false, agentId=none on this seam.
 */
const BARE = {};

const files = async (d) => {
  try { return (await readdir(d)).filter((f) => f.endsWith(".json")); } catch { return []; }
};

// ---------------------------------------------------------------------------
// The production lifecycle, end to end
// ---------------------------------------------------------------------------

test("identity-rich prompt build, identity-poor middleware, one class throughout", async () => {
  const d = await dir();
  const cfg = config(d);
  const p = plugin(cfg);
  const ctx = { runId: "run-1", sessionKey: "smoke-evidence-1", sessionId: "smoke-evidence-1", agentId: "tars-chat" };

  await p.handlers.before_prompt_build(TURN, { ...ctx, pluginConfig: cfg });

  const entry = p.__store.get({ runId: "run-1" });
  assert.equal(entry.traffic.status, "resolved");
  assert.equal(entry.traffic.trafficClass, "synthetic_test");

  // The hook that carries a tool call id and a run id together.
  p.handlers.before_tool_call({ toolName: "web_search", toolCallId: "call-1", params: { query: "price" } }, { ...ctx, pluginConfig: cfg });
  await p.__mw({ toolName: "web_search", toolCallId: "call-1", params: { query: "price" }, result: SEARCH }, BARE);

  assert.equal((await files(d)).length, 1, "capture ran on a turn the middleware could not have classified");

  await p.handlers.before_agent_finalize({ runId: "run-1", sessionId: "smoke-evidence-1", lastAssistantMessage: "About $4,000." }, { ...ctx, pluginConfig: cfg });
  await p.handlers.agent_end({ runId: "run-1", sessionId: "smoke-evidence-1" }, { ...ctx, pluginConfig: cfg });

  assert.equal(p.__turns.length, 1);
  const rec = p.__turns[0];
  assert.equal(rec.trafficClass, "synthetic_test");
  assert.equal(rec.trafficResolutionStatus, "resolved");
  assert.equal(rec.trafficClassSource, "builtin-prefix:smoke-");
  assert.equal(rec.trafficClassResolvedAt, "before_prompt_build");
  assert.equal(rec.trafficIdentityMismatch, false);
  assert.equal(rec.evidenceCaptureStatus, "complete");
  await rm(d, { recursive: true, force: true });
});

test("human at prompt build, empty middleware context: the human policy applies", async () => {
  const d = await dir();
  const cfg = config(d);
  const p = plugin(cfg);
  const ctx = { runId: "run-1", sessionKey: "mc-chat-9", sessionId: "mc-chat-9", agentId: "tars-chat", pluginConfig: cfg };

  await p.handlers.before_prompt_build(TURN, ctx);
  p.handlers.before_tool_call({ toolName: "web_search", toolCallId: "c1" }, ctx);
  await p.__mw({ toolName: "web_search", toolCallId: "c1", result: SEARCH }, BARE);

  assert.equal(p.__store.get({ runId: "run-1" }).traffic.trafficClass, "human");
  assert.equal((await files(d)).length, 1);
  await rm(d, { recursive: true, force: true });
});

test("heartbeat at prompt build, empty middleware context: excluded as heartbeat", async () => {
  const d = await dir();
  const cfg = config(d);
  const p = plugin(cfg);
  const ctx = { runId: "run-1", sessionKey: "0f5212de-uuid", sessionId: "0f5212de-uuid", agentId: "main", pluginConfig: cfg };

  await p.handlers.before_prompt_build(TURN, ctx);
  p.handlers.before_tool_call({ toolName: "web_search", toolCallId: "c1" }, ctx);
  await p.__mw({ toolName: "web_search", toolCallId: "c1", result: SEARCH }, BARE);

  assert.deepEqual(await files(d), []);
  // Excluded for what it is. The old code excluded it as "system", which is the
  // same outcome reached for the wrong reason — and reached for every other
  // class too.
  assert.equal(
    p.__store.get({ runId: "run-1" }).evidenceCaptureSkipReason,
    "traffic_class_excluded:heartbeat",
  );
  await rm(d, { recursive: true, force: true });
});

test("a rebuilt prompt does not reclassify the turn", async () => {
  // before_prompt_build fires again whenever the harness rebuilds the prompt,
  // including for this plugin's own revision pass. The nonce guard already
  // stops the grounding verdict moving; traffic rides on the same guard.
  const d = await dir();
  const cfg = config(d);
  const p = plugin(cfg);
  const ctx = { runId: "run-1", sessionKey: "smoke-1", sessionId: "smoke-1", agentId: "tars-chat", pluginConfig: cfg };

  await p.handlers.before_prompt_build(TURN, ctx);
  const first = p.__store.get({ runId: "run-1" }).traffic;

  // Same turn, same nonce, and an agent id that would classify as heartbeat.
  await p.handlers.before_prompt_build(TURN, { ...ctx, agentId: "main" });
  const second = p.__store.get({ runId: "run-1" }).traffic;

  assert.equal(second, first, "the same frozen decision, not an equal copy");
  assert.equal(second.trafficClass, "synthetic_test");
  await rm(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Unresolved is a state, not a class
// ---------------------------------------------------------------------------

test("no usable identity at prompt build resolves to nothing, never to the default", async () => {
  const d = await dir();
  // enabledAgents empty means every agent, which is the only configuration in
  // which a turn carrying no agent id reaches the hooks at all.
  const cfg = config(d, { enabledAgents: [] });
  const p = plugin(cfg);
  // A run with no session and no agent. `trafficClasses.default` is "system",
  // and before this change that is what the turn would have been called.
  const ctx = { runId: "run-1", pluginConfig: cfg };

  await p.handlers.before_prompt_build(TURN, ctx);

  const traffic = p.__store.get({ runId: "run-1" }).traffic;
  assert.equal(traffic.status, "unresolved");
  assert.equal(traffic.trafficClass, null);
  assert.equal(traffic.reason, "identity_unavailable");

  p.handlers.before_tool_call({ toolName: "web_search", toolCallId: "c1" }, ctx);
  await p.__mw({ toolName: "web_search", toolCallId: "c1", result: SEARCH }, BARE);

  assert.deepEqual(await files(d), []);
  const entry = p.__store.get({ runId: "run-1" });
  assert.equal(entry.evidenceCaptureSkipReason, "traffic_class_unresolved");
  assert.notEqual(entry.evidenceCaptureSkipReason, "traffic_class_excluded:system");

  await p.handlers.agent_end({ runId: "run-1" }, ctx);
  const rec = p.__turns[0];
  assert.equal(rec.trafficClass, null);
  assert.equal(rec.trafficResolutionStatus, "unresolved");
  assert.equal(rec.trafficClassSource, "identity_unavailable");
  // Not "declined to capture" — could not.
  assert.equal(rec.evidenceCaptureStatus, "unavailable");
  await rm(d, { recursive: true, force: true });
});

test("a turn matching an explicit system rule is still system", async () => {
  // Removing the fallback must not remove the class. `system` is a real answer
  // when an operator wrote a rule that says so.
  const d = await dir();
  const cfg = config(d);
  const p = plugin(cfg);
  const ctx = { runId: "run-1", sessionKey: "sys-cron-4", sessionId: "sys-cron-4", agentId: "tars-chat", pluginConfig: cfg };

  await p.handlers.before_prompt_build(TURN, ctx);

  const traffic = p.__store.get({ runId: "run-1" }).traffic;
  assert.equal(traffic.status, "resolved");
  assert.equal(traffic.trafficClass, "system");
  assert.equal(traffic.reason, "session-prefix:sys-");
  await rm(d, { recursive: true, force: true });
});

test("the middleware warns, once, when it meets a turn that was never opened", async () => {
  // No before_prompt_build, so there is no entry and nothing to annotate. The
  // warning is the whole record: no class is guessed, no turn is invented, and
  // the tool result is returned untouched.
  const d = await dir();
  const cfg = config(d);
  const p = plugin(cfg);

  const before = structuredClone(SEARCH);
  const out = await p.__mw({ toolName: "web_search", toolCallId: "never-bound", result: SEARCH }, BARE);

  assert.equal(out, undefined, "the tool result is untouched");
  assert.deepEqual(SEARCH, before);
  assert.deepEqual(await files(d), []);

  const warned = p.__log.lines.warn.filter((l) => /traffic_class_unresolved/.test(l));
  assert.equal(warned.length, 1, "said once, at warn");
  assert.doesNotMatch(warned[0], /system/, "no class is guessed on the way out");
  // Not merely "no entry for this run" — no turn state was brought into
  // existence at all by a middleware call that had nothing to attach to.
  assert.equal(p.__store, null, "no turn is synthesized");
  assert.equal(p.__turns.length, 0, "no telemetry record is fabricated");
  await rm(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// A later hook may disagree. It may not decide.
// ---------------------------------------------------------------------------

test("partial later identity is missing information, not disagreement", async () => {
  const d = await dir();
  const cfg = config(d);
  const p = plugin(cfg);
  const ctx = { runId: "run-1", sessionKey: "mc-chat-9", sessionId: "mc-chat-9", agentId: "tars-chat", pluginConfig: cfg };

  await p.handlers.before_prompt_build(TURN, ctx);
  // agent_end carrying only the agent, and the same one.
  await p.handlers.agent_end({ runId: "run-1" }, { runId: "run-1", agentId: "tars-chat", pluginConfig: cfg });

  const rec = p.__turns[0];
  assert.equal(rec.trafficIdentityMismatch, false);
  assert.equal(rec.trafficClass, "human");
  await rm(d, { recursive: true, force: true });
});

test("a genuinely different later identity is reported, and changes nothing", async () => {
  const d = await dir();
  const cfg = config(d);
  const p = plugin(cfg);
  const ctx = { runId: "run-1", sessionKey: "smoke-a", sessionId: "smoke-a", agentId: "tars-chat", pluginConfig: cfg };

  await p.handlers.before_prompt_build(TURN, ctx);
  // A session that would classify as human if anything here were still
  // classifying. Nothing here is still classifying.
  await p.handlers.agent_end(
    { runId: "run-1", sessionId: "mc-chat-b" },
    { runId: "run-1", sessionKey: "mc-chat-b", sessionId: "mc-chat-b", agentId: "tars-chat", pluginConfig: cfg },
  );

  const rec = p.__turns[0];
  assert.equal(rec.trafficIdentityMismatch, true, "the disagreement is recorded");
  assert.equal(rec.trafficClass, "synthetic_test", "and the first decision stands");
  assert.equal(rec.trafficClassSource, "builtin-prefix:smoke-");
  assert.equal(p.__store.get({ runId: "run-1" }).traffic.trafficClass, "synthetic_test");
  await rm(d, { recursive: true, force: true });
});

test("the stored decision and the identity behind it are both frozen", async () => {
  // Freezing only the outer object would leave the identity editable, and the
  // mismatch check reads the identity.
  const d = await dir();
  const cfg = config(d);
  const p = plugin(cfg);
  const ctx = { runId: "run-1", sessionKey: "smoke-1", sessionId: "smoke-1", agentId: "tars-chat", pluginConfig: cfg };

  await p.handlers.before_prompt_build(TURN, ctx);
  const traffic = p.__store.get({ runId: "run-1" }).traffic;

  assert.ok(Object.isFrozen(traffic));
  assert.ok(Object.isFrozen(traffic.identity));
  assert.throws(() => { "use strict"; traffic.trafficClass = "human"; }, TypeError);
  assert.throws(() => { "use strict"; traffic.identity.sessionKey = "mc-chat-x"; }, TypeError);
  await rm(d, { recursive: true, force: true });
});
