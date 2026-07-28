// Observability: the diagnostics must actually reach somewhere.
//
// Two deployments were diagnosed by reading silence. `deps.logger` is undefined
// in production — the default export calls createPlugin() with no dependencies
// — so every `deps.logger?.debug?.()` in the plugin, including the overlay's,
// was a no-op from the day it was written. These tests assert the lines exist
// and that a skip says which gate stopped it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createPlugin } from "../src/index.js";

import "./_vocabulary.mjs";

const dir = () => mkdtemp(path.join(tmpdir(), "obs-"));

function recorder() {
  const lines = { info: [], warn: [], error: [], debug: [] };
  const push = (k) => (m) => lines[k].push(String(m));
  return { lines, info: push("info"), warn: push("warn"), error: push("error"), debug: push("debug") };
}

function config(captureDir, over = {}) {
  return {
    evidenceCaptureEnabled: true,
    evidenceCaptureDir: captureDir,
    evidenceCaptureTrafficClasses: ["human", "synthetic_test"],
    trafficClasses: { bySessionPrefix: { "smoke-": "synthetic_test" }, byAgent: {}, default: "system" },
    ...over,
  };
}

/** Register with the host supplying the logger, as OpenClaw may. */
function register(pluginConfig, logger, { viaApi = true } = {}) {
  const p = createPlugin(viaApi ? {} : { logger });
  let mw = null;
  p.register({
    on: () => {}, registerTool: () => {},
    registerAgentToolResultMiddleware: (h) => { mw = h; },
    config: { plugins: { entries: { "llm-grounded": { enabled: true, config: pluginConfig } } } },
    ...(viaApi ? { logger } : {}),
  });
  return { p, mw };
}

const SEARCH = { results: [{ snippet: "Listed at $4,000 today." }] };
const CTX = { runId: "run-1", sessionKey: "smoke-1", sessionId: "smoke-1", agentId: "chat" };

test("the logger is taken from the host when deps supplies none", async () => {
  // The production shape: createPlugin() with no dependencies, logger offered
  // by the plugin api instead.
  const d = await dir();
  const log = recorder();
  register(config(d), log, { viaApi: true });
  assert.match(log.lines.info.join(" "), /runtime config resolved/);
  await rm(d, { recursive: true, force: true });
});

test("an injected logger still wins", async () => {
  const d = await dir();
  const log = recorder();
  register(config(d), log, { viaApi: false });
  assert.match(log.lines.info.join(" "), /runtime config resolved/);
  await rm(d, { recursive: true, force: true });
});

test("the first middleware invocation is announced once", async () => {
  // The line that answers "is this seam invoked at all" without inference.
  const d = await dir();
  const log = recorder();
  const { mw } = register(config(d), log);
  for (let i = 0; i < 3; i += 1) {
    await mw({ toolName: "web_search", toolCallId: `c${i}`, result: SEARCH }, CTX);
  }
  const announced = log.lines.info.filter((l) => /middleware invoked \(first call\)/.test(l));
  assert.equal(announced.length, 1, "once per process, not per call");
  assert.match(announced[0], /tool=web_search/);
  assert.match(announced[0], /hasSessionKey=true/);
  await rm(d, { recursive: true, force: true });
});

test("a successful capture is observable", async () => {
  const d = await dir();
  const log = recorder();
  const { p, mw } = register(config(d), log);
  await p.handlers.before_prompt_build({ prompt: "[user-message:a]\nwhat is the price\n[/user-message:a]", messages: [] }, { ...CTX, pluginConfig: config(d) });
  await mw({ toolName: "web_search", toolCallId: "c1", result: SEARCH }, CTX);
  assert.match(log.lines.debug.join(" "), /evidence captured tool=web_search ids=1/);
  await rm(d, { recursive: true, force: true });
});

test("every skip names the gate that stopped it", async () => {
  const d = await dir();
  const cases = [
    ["capture_disabled", config(d, { evidenceCaptureEnabled: false }), "web_search", CTX],
    ["tool_not_allowlisted", config(d), "exec", CTX],
    ["tool_not_successful", config(d), "web_search", CTX],
    ["traffic_class_excluded", config(d), "web_search", { ...CTX, sessionKey: "x", sessionId: "x" }],
  ];
  // Not in the table: traffic_class_unresolved. It has no turn to record itself
  // on — that is the whole condition — so it is asserted on the warn channel in
  // config_resolution.test.mjs instead.
  for (const [expected, cfg, tool, ctx] of cases) {
    const log = recorder();
    const { p, mw } = register(cfg, log);
    const result = expected === "tool_not_successful"
      ? { isError: true, content: [{ type: "text", text: "boom" }] }
      : SEARCH;
    await p.handlers.before_prompt_build(
      { prompt: "[user-message:a]\nx\n[/user-message:a]", messages: [] },
      { ...ctx, pluginConfig: cfg },
    );
    await mw({ toolName: tool, toolCallId: "c1", result }, ctx);

    assert.match(log.lines.debug.join(" "), new RegExp(`reason=${expected}`), expected);
    const entry = p.__store.get({ runId: "run-1" });
    assert.match(entry.evidenceCaptureSkipReason ?? "", new RegExp(`^${expected}`), `${expected} recorded on the turn`);
  }
  await rm(d, { recursive: true, force: true });
});

test("the first skip reason is kept, not the last", async () => {
  // The earliest gate is the actionable one; a later, more generic reason
  // would bury it.
  const d = await dir();
  const log = recorder();
  const { p, mw } = register(config(d), log);
  await p.handlers.before_prompt_build(
    { prompt: "[user-message:a]\nx\n[/user-message:a]", messages: [] }, { ...CTX, pluginConfig: config(d) },
  );
  await mw({ toolName: "exec", toolCallId: "c1", result: SEARCH }, CTX);
  await mw({ toolName: "read", toolCallId: "c2", result: SEARCH }, CTX);
  assert.equal(p.__store.get({ runId: "run-1" }).evidenceCaptureSkipReason, "tool_not_allowlisted");
  await rm(d, { recursive: true, force: true });
});
