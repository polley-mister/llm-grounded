// Runtime configuration resolution.
//
// The deployed 0.2.0 build read no configuration in the middleware context,
// fell back to package defaults — in which every optional feature is off — and
// returned silently. Evidence capture was inert in production while telemetry
// reported `not_applicable`, which is indistinguishable from "capture ran and
// found nothing". These tests exist so that cannot recur silently.
//
// The registration shapes here are deliberately production-shaped: the module
// tests passed throughout the outage because they handed the plugin its config
// directly, which the runtime does not.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createPlugin } from "../src/index.js";

import "./_vocabulary.mjs";

const dir = () => mkdtemp(path.join(tmpdir(), "cfg-res-"));

function captureConfig(captureDir, over = {}) {
  return {
    evidenceCaptureEnabled: true,
    evidenceCaptureDir: captureDir,
    evidenceCaptureTrafficClasses: ["human", "synthetic_test"],
    trafficClasses: { bySessionPrefix: { "smoke-": "synthetic_test" }, byAgent: {}, default: "system" },
    ...over,
  };
}

/** Register the way OpenClaw does: the whole runtime config on `api.config`. */
function registerProductionShaped(p, pluginConfig, logger) {
  let mw = null;
  p.register({
    on: () => {},
    registerTool: () => {},
    registerAgentToolResultMiddleware: (h) => { mw = h; },
    config: pluginConfig === undefined
      ? undefined
      : { plugins: { entries: { "llm-grounded": { enabled: true, config: pluginConfig } } } },
    logger,
  });
  return mw;
}

function plugin(logger) {
  return createPlugin({
    now: () => 1000,
    writeEvidence: async () => null,
    pruneEvidence: async () => 0,
    writeTurn: async () => null,
    pruneTurns: async () => 0,
    logger,
  });
}

function recorder() {
  const lines = { info: [], warn: [], error: [], debug: [] };
  return {
    lines,
    info: (m) => lines.info.push(String(m)),
    warn: (m) => lines.warn.push(String(m)),
    error: (m) => lines.error.push(String(m)),
    debug: (m) => lines.debug.push(String(m)),
  };
}

const SEARCH = { results: [{ title: "T", url: "https://x.example", snippet: "Listed at $4,000 today." }] };
const CTX = { runId: "run-1", sessionKey: "smoke-1", sessionId: "smoke-1", agentId: "chat" };
const files = async (d) => (await readdir(d).catch(() => [])).filter((f) => f.endsWith(".json"));

// ---------------------------------------------------------------------------
// The exact deployed failure
// ---------------------------------------------------------------------------

test("REGRESSION: production-shaped registration captures evidence", async () => {
  // Registered the way OpenClaw registers it, config only via the canonical
  // runtime entry, no pluginConfig on the tool-result context. This is the
  // shape that silently did nothing in 0.2.0.
  const d = await dir();
  const log = recorder();
  const p = plugin(log);
  const mw = registerProductionShaped(p, captureConfig(d), log);

  const out = await mw({ toolName: "web_search", toolCallId: "c1", params: { query: "price" }, result: SEARCH }, CTX);

  assert.equal(out, undefined, "the tool result is not rewritten");
  assert.equal((await files(d)).length, 1, "evidence was captured");
  await rm(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Unresolved is visible, and is not "disabled"
// ---------------------------------------------------------------------------

test("unresolved configuration is reported, not silently treated as disabled", async () => {
  const log = recorder();
  const p = plugin(log);
  const mw = registerProductionShaped(p, undefined, log);

  const before = structuredClone(SEARCH);
  const out = await mw({ toolName: "web_search", toolCallId: "c1", result: SEARCH }, CTX);

  assert.equal(out, undefined, "the turn is untouched");
  assert.deepEqual(SEARCH, before);
  const said = log.lines.error.join(" ");
  assert.match(said, /runtime config unavailable/);
  assert.match(said, /plugin_config_unavailable/);
});

test("the unresolved diagnostic is emitted once per process, not per call", async () => {
  // A per-call error would bury the signal it exists to provide.
  const log = recorder();
  const p = plugin(log);
  const mw = registerProductionShaped(p, undefined, log);
  for (let i = 0; i < 5; i += 1) {
    await mw({ toolName: "web_search", toolCallId: `c${i}`, result: SEARCH }, CTX);
  }
  const unavailable = log.lines.error.filter((l) => /runtime config unavailable/.test(l));
  assert.equal(unavailable.length, 1, `expected one diagnostic, saw ${unavailable.length}`);
});

test("malformed configuration stays a parse failure and does not become disabled", async () => {
  const log = recorder();
  const p = plugin(log);
  registerProductionShaped(p, { evidenceCaptureTrafficClasses: ["not-a-class"] }, log);
  const said = log.lines.error.join(" ");
  assert.match(said, /runtime config unavailable/);
  assert.match(said, /plugin_config_invalid/);
});

test("an unresolved turn records the condition rather than not_applicable", async () => {
  const log = recorder();
  const p = plugin(log);
  const mw = registerProductionShaped(p, undefined, log);
  await p.handlers.before_prompt_build(
    { prompt: "[user-message:a]\nwhat is the price\n[/user-message:a]", messages: [] },
    { ...CTX, pluginConfig: {} },
  );
  await mw({ toolName: "web_search", toolCallId: "c1", result: SEARCH }, CTX);

  const entry = p.__store.get({ runId: "run-1" });
  assert.equal(entry.runtimeConfigResolved, false);
  assert.equal(entry.overlayConfigResolved, false);
  assert.equal(entry.evidenceCaptureSkipReason, "config_unresolved");
});

// ---------------------------------------------------------------------------
// Explicit disable remains a quiet, valid state
// ---------------------------------------------------------------------------

test("explicitly disabled capture is quiet and is not an error", async () => {
  const d = await dir();
  const log = recorder();
  const p = plugin(log);
  const mw = registerProductionShaped(p, captureConfig(d, { evidenceCaptureEnabled: false }), log);
  await mw({ toolName: "web_search", toolCallId: "c1", result: SEARCH }, CTX);

  assert.deepEqual(await files(d), []);
  assert.equal(log.lines.error.length, 0, "an explicit choice is not a fault");
  await rm(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Startup observability
// ---------------------------------------------------------------------------

test("startup reports the resolved configuration and its source", async () => {
  // Absent this line, the previous failure was invisible for an hour.
  const d = await dir();
  const log = recorder();
  const p = plugin(log);
  registerProductionShaped(p, captureConfig(d), log);

  const said = log.lines.info.join(" ");
  assert.match(said, /runtime config resolved/);
  assert.match(said, /source=openclaw-plugin-entry/);
  assert.match(said, /evidenceCaptureEnabled=true/);
  assert.match(said, new RegExp(`evidenceCaptureDir=${d}`));
  await rm(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Both middlewares share one snapshot
// ---------------------------------------------------------------------------

test("overlay and capture degrade together under unresolved config", async () => {
  // Leaving one middleware working while the other is silently off is how the
  // defect survived a deployment.
  const log = recorder();
  const p = plugin(log);
  const mw = registerProductionShaped(p, undefined, log);
  await p.handlers.before_prompt_build(
    { prompt: "[user-message:a]\nx\n[/user-message:a]", messages: [] },
    { ...CTX, pluginConfig: {} },
  );
  await mw({ toolName: "wiki_search", toolCallId: "c1", result: { content: [{ type: "text", text: "stale" }] } }, CTX);

  const entry = p.__store.get({ runId: "run-1" });
  assert.equal(entry.overlayConfigResolved, false);
  assert.equal(entry.runtimeConfigResolved, false);
  assert.equal(entry.overlayApplied, false);
});

test("direct and production-shaped registration resolve equivalent configuration", async () => {
  const d = await dir();
  const cfg = captureConfig(d);

  const direct = plugin(recorder());
  let directMw = null;
  direct.register({
    on: () => {}, registerTool: () => {},
    registerAgentToolResultMiddleware: (h) => { directMw = h; },
    config: { plugins: { entries: { "llm-grounded": { enabled: true, config: cfg } } } },
  });
  await directMw({ toolName: "web_search", toolCallId: "c1", result: SEARCH }, CTX);
  const viaDirect = (await files(d)).length;

  const d2 = await dir();
  const prod = plugin(recorder());
  const prodMw = registerProductionShaped(prod, captureConfig(d2));
  await prodMw({ toolName: "web_search", toolCallId: "c1", result: SEARCH }, CTX);
  const viaProd = (await files(d2)).length;

  assert.equal(viaDirect, viaProd, "both paths must capture the same way");
  assert.ok(viaProd > 0);
  await rm(d, { recursive: true, force: true });
  await rm(d2, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Turn identity on the middleware seam
// ---------------------------------------------------------------------------

test("REGRESSION: the middleware receives no turn identity and still captures", async () => {
  // Measured in production, not assumed: the tool-result context arrives with
  // hasSessionKey=false, hasRunId=false, agentId=none. Traffic classification
  // therefore fell to the default class, which is not allowlisted, and the
  // budget key was null — so capture skipped every call for want of identity.
  //
  // before_tool_call is the one hook that sees a tool call id together with a
  // run id, which is why the fact transaction already binds there. Capture now
  // uses the same binding.
  const d = await dir();
  const log = recorder();
  const p = plugin(log);
  const cfg = captureConfig(d);
  const mw = registerProductionShaped(p, cfg, log);

  const ctx = { runId: "run-1", sessionKey: "smoke-1", sessionId: "smoke-1", agentId: "chat", pluginConfig: cfg };
  await p.handlers.before_prompt_build(
    { prompt: "[user-message:a]\nwhat is the price\n[/user-message:a]", messages: [] }, ctx,
  );
  // The hook that carries identity.
  p.handlers.before_tool_call({ toolName: "web_search", toolCallId: "call-1", params: { query: "price" } }, ctx);

  // The middleware, exactly as production delivers it: no identity at all.
  const bare = {};
  const out = await mw(
    { toolName: "web_search", toolCallId: "call-1", params: { query: "price" }, result: SEARCH },
    bare,
  );

  assert.equal(out, undefined, "the tool result is untouched");
  assert.equal((await files(d)).length, 1, "capture resolved the turn from the binding");

  const entry = p.__store.get({ runId: "run-1" });
  assert.equal(entry.evidenceCapturedCount, 1);
  assert.equal(entry.evidenceIds.length, 1);
  await rm(d, { recursive: true, force: true });
});

test("an unbound tool call still skips, and says why", async () => {
  // No binding and no context is genuinely unattributable. It must skip
  // visibly rather than capture under a guessed identity.
  const d = await dir();
  const log = recorder();
  const p = plugin(log);
  const mw = registerProductionShaped(p, captureConfig(d), log);
  await mw({ toolName: "web_search", toolCallId: "never-bound", result: SEARCH }, {});
  assert.deepEqual(await files(d), []);
  assert.match(log.lines.debug.join(" "), /reason=(no_turn_identity|traffic_class_excluded)/);
  await rm(d, { recursive: true, force: true });
});

test("the binding is peeked, not consumed", async () => {
  // resolveToolCall is single-use so a replayed id cannot reach a live turn
  // twice; the fact transaction depends on that. Capture must not spend it.
  const d = await dir();
  const p = plugin(recorder());
  const cfg = captureConfig(d);
  const mw = registerProductionShaped(p, cfg, recorder());
  const ctx = { runId: "run-1", sessionKey: "smoke-1", sessionId: "smoke-1", agentId: "chat", pluginConfig: cfg };

  await p.handlers.before_prompt_build(
    { prompt: "[user-message:a]\nx\n[/user-message:a]", messages: [] }, ctx,
  );
  p.handlers.before_tool_call({ toolName: "web_search", toolCallId: "call-1" }, ctx);

  await mw({ toolName: "web_search", toolCallId: "call-1", result: SEARCH }, {});
  // Still resolvable afterwards, for the path that legitimately consumes it.
  assert.ok(p.__store.resolveToolCall("call-1"), "capture must not consume the binding");
  await rm(d, { recursive: true, force: true });
});
