// What a turn record says happened to evidence capture.
//
// The production case this exists for:
//
//   evidenceCaptureStatus     complete
//   evidenceCapturedCount     4
//   evidenceCaptureSkipReason tool_not_allowlisted
//
// Three true statements that together read as a failure. The turn called one
// tool with no adapter and another that captured four excerpts; the singular
// field held the first skip of any kind, while its name reads as "why did
// evidence capture not happen". Nothing was wrong with the turn, and a corpus
// filtered on that field would have said otherwise.
//
// The distinction that fixes it: a *skip* is something that was never eligible,
// a *loss* is something eligible that was dropped. Only a loss degrades a turn.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createPlugin } from "../src/index.js";
import { buildTurnRecord } from "../src/telemetry.js";

import "./_vocabulary.mjs";

const dir = () => mkdtemp(path.join(tmpdir(), "ev-status-"));

const SEARCH = { results: [
  { title: "A", url: "https://a.example", snippet: "Listed at $4,000 today." },
  { title: "B", url: "https://b.example", snippet: "In stock at $4,050." },
  { title: "C", url: "https://c.example", snippet: "Refurbished at $3,800." },
  { title: "D", url: "https://d.example", snippet: "Open box at $3,900." },
] };
const TURN = { prompt: "[user-message:a]\nwhat is the price\n[/user-message:a]", messages: [] };
const CTX = { runId: "run-1", sessionKey: "mc-chat-9", sessionId: "mc-chat-9-abc", agentId: "tars-chat" };

function config(captureDir, over = {}) {
  return {
    enabledAgents: ["main", "chat", "tars-chat"],
    evidenceCaptureEnabled: true,
    evidenceCaptureDir: captureDir,
    evidenceCaptureTrafficClasses: ["human", "synthetic_test"],
    telemetryDir: "/tmp/unused-telemetry",
    trafficClasses: { bySessionPrefix: { "mc-chat": "human" }, byAgent: {}, default: "system" },
    ...over,
  };
}

function plugin(cfg, deps = {}) {
  const turns = [];
  const p = createPlugin({
    now: () => 1000,
    writeTurn: async (_d, r) => { turns.push(r); return null; },
    pruneTurns: async () => 0,
    ...deps,
  });
  let mw = null;
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

// ---------------------------------------------------------------------------
// The production case, exactly
// ---------------------------------------------------------------------------

test("REGRESSION: a skipped tool does not make a fully captured turn look failed", async () => {
  const d = await dir();
  const cfg = config(d);
  const p = plugin(cfg);
  const ctx = { ...CTX, pluginConfig: cfg };

  await p.handlers.before_prompt_build(TURN, ctx);
  // A tool with no adapter, seen first.
  await p.__mw({ toolName: "read", toolCallId: "c0", result: { content: [{ type: "text", text: "a file" }] } }, ctx);
  // Then a search that captures everything it produced.
  await p.__mw({ toolName: "web_search", toolCallId: "c1", params: { query: "price" }, result: SEARCH }, ctx);
  await p.handlers.agent_end({ runId: "run-1" }, ctx);

  assert.equal((await files(d)).length, 4);
  const rec = p.__turns[0];

  assert.equal(rec.evidenceCaptureStatus, "complete");
  assert.equal(rec.evidenceCapturedCount, 4);
  assert.equal(rec.evidenceCaptureLostCount, 0);
  assert.equal(rec.evidenceCaptureFailedCount, 0);
  // The headline is silent, because nothing failed to happen.
  assert.equal(rec.evidenceCaptureSkipReason, null);
  // And the skip is still on the record, where it cannot be mistaken for one.
  assert.equal(rec.evidenceCaptureSkipReasons.tool_not_allowlisted, 1);
  await rm(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The status rules
// ---------------------------------------------------------------------------

test("a loss makes a turn partial; a skip does not", () => {
  const skipped = buildTurnRecord({
    evidenceCaptureAttempted: true,
    evidenceCapturedCount: 4,
    evidenceCaptureSkippedCount: 2,
    evidenceCaptureLostCount: 0,
    evidenceCaptureFailedCount: 0,
  });
  assert.equal(skipped.evidenceCaptureStatus, "complete", "ineligible items are not a degradation");

  const lost = buildTurnRecord({
    evidenceCaptureAttempted: true,
    evidenceCapturedCount: 4,
    evidenceCaptureSkippedCount: 0,
    evidenceCaptureLostCount: 1,
    evidenceCaptureFailedCount: 0,
  });
  assert.equal(lost.evidenceCaptureStatus, "partial", "a dropped eligible excerpt is");

  const failedWrite = buildTurnRecord({
    evidenceCaptureAttempted: true,
    evidenceCapturedCount: 4,
    evidenceCaptureFailedCount: 1,
  });
  assert.equal(failedWrite.evidenceCaptureStatus, "partial");
});

test("nothing captured and something lost is failed", () => {
  const rec = buildTurnRecord({
    evidenceCaptureAttempted: true,
    evidenceCapturedCount: 0,
    evidenceCaptureFailedCount: 2,
    evidenceCaptureSkipReason: "write_failed",
  });
  assert.equal(rec.evidenceCaptureStatus, "failed");
  assert.equal(rec.evidenceCaptureSkipReason, "write_failed", "nothing captured, so the reason is the headline");
});

test("nothing captured and nothing lost is not_applicable, not failed", () => {
  // Attempted, but the results held nothing capturable. Reporting that as
  // failed would count healthy turns as faults.
  const rec = buildTurnRecord({
    evidenceCaptureAttempted: true,
    evidenceCapturedCount: 0,
    evidenceCaptureSkippedCount: 3,
    evidenceCaptureLostCount: 0,
    evidenceCaptureFailedCount: 0,
    evidenceCaptureSkipReason: "no_evidence_items",
  });
  assert.equal(rec.evidenceCaptureStatus, "not_applicable");
  assert.equal(rec.evidenceCaptureSkipReason, "no_evidence_items");
});

test("a fault is still unavailable, and outranks the counts", () => {
  assert.equal(
    buildTurnRecord({ runtimeConfigResolved: false, evidenceCaptureAttempted: true, evidenceCapturedCount: 2 })
      .evidenceCaptureStatus,
    "unavailable",
  );
  assert.equal(
    buildTurnRecord({ evidenceCaptureSkipReason: "traffic_class_unresolved" }).evidenceCaptureStatus,
    "unavailable",
  );
});

test("an empty record reports no capture rather than a fault", () => {
  const rec = buildTurnRecord({});
  assert.equal(rec.evidenceCaptureStatus, "not_applicable");
  assert.equal(rec.evidenceCaptureSkipReason, null);
  assert.deepEqual(rec.evidenceCaptureSkipReasons, {});
  assert.equal(rec.evidenceCaptureLostCount, 0);
});

// ---------------------------------------------------------------------------
// Caps are reported, not silent
// ---------------------------------------------------------------------------

test("the per-call cap reports what it dropped", async () => {
  // Four usable hits under a cap of two. The two that were written are not the
  // whole story, and a turn that says `complete` would be claiming they are.
  const d = await dir();
  const cfg = config(d, { evidenceCaptureMaxItemsPerCall: 2 });
  const p = plugin(cfg);
  const ctx = { ...CTX, pluginConfig: cfg };

  await p.handlers.before_prompt_build(TURN, ctx);
  await p.__mw({ toolName: "web_search", toolCallId: "c1", result: SEARCH }, ctx);
  await p.handlers.agent_end({ runId: "run-1" }, ctx);

  assert.equal((await files(d)).length, 2, "the cap still holds");
  const rec = p.__turns[0];
  assert.equal(rec.evidenceCapturedCount, 2);
  assert.equal(rec.evidenceCaptureLostCount, 2, "and says so, exactly");
  assert.equal(rec.evidenceCaptureSkipReasons.call_limit, 2);
  assert.equal(rec.evidenceCaptureStatus, "partial");
  await rm(d, { recursive: true, force: true });
});

test("the per-turn cap reports what it dropped", async () => {
  const d = await dir();
  const cfg = config(d, { evidenceCaptureMaxItemsPerTurn: 3 });
  const p = plugin(cfg);
  const ctx = { ...CTX, pluginConfig: cfg };

  await p.handlers.before_prompt_build(TURN, ctx);
  await p.__mw({ toolName: "web_search", toolCallId: "c1", result: SEARCH }, ctx);
  await p.handlers.agent_end({ runId: "run-1" }, ctx);

  const rec = p.__turns[0];
  assert.equal(rec.evidenceCapturedCount, 3);
  assert.equal(rec.evidenceCaptureLostCount, 1);
  assert.equal(rec.evidenceCaptureSkipReasons.item_limit, 1);
  assert.equal(rec.evidenceCaptureStatus, "partial");
  await rm(d, { recursive: true, force: true });
});

test("a storage failure is a loss, and reads as one", async () => {
  const d = await dir();
  const cfg = config(d);
  const p = plugin(cfg, {
    evidenceCaptureFs: {
      mkdir: async () => undefined,
      writeFile: async () => { const e = new Error("permission denied"); e.code = "EACCES"; throw e; },
      rename: async () => undefined,
    },
  });
  const ctx = { ...CTX, pluginConfig: cfg };

  await p.handlers.before_prompt_build(TURN, ctx);
  await p.__mw({ toolName: "web_search", toolCallId: "c1", result: SEARCH }, ctx);
  await p.handlers.agent_end({ runId: "run-1" }, ctx);

  const rec = p.__turns[0];
  assert.equal(rec.evidenceCaptureStatus, "failed");
  assert.equal(rec.evidenceCapturedCount, 0);
  assert.equal(rec.evidenceCaptureFailedCount, 4);
  assert.equal(rec.evidenceCaptureSkipReasons.write_failed, 4);
  await rm(d, { recursive: true, force: true });
});

test("a turn excluded by traffic class still reports its one reason", async () => {
  const d = await dir();
  const cfg = config(d, { evidenceCaptureTrafficClasses: ["synthetic_test"] });
  const p = plugin(cfg);
  const ctx = { ...CTX, pluginConfig: cfg };

  await p.handlers.before_prompt_build(TURN, ctx);
  await p.__mw({ toolName: "web_search", toolCallId: "c1", result: SEARCH }, ctx);
  await p.handlers.agent_end({ runId: "run-1" }, ctx);

  const rec = p.__turns[0];
  assert.equal(rec.evidenceCaptureStatus, "not_applicable");
  assert.equal(rec.evidenceCaptureSkipReason, "traffic_class_excluded:human");
  assert.equal(rec.evidenceCaptureSkipReasons["traffic_class_excluded:human"], 1);
  await rm(d, { recursive: true, force: true });
});
