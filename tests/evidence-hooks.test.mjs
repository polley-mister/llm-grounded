// Evidence capture in the production hook path.
//
// The invariant under test: capture observes the effective tool result without
// changing the tool result, the answer, or the turn's authority.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createPlugin } from "../src/index.js";

import "./_vocabulary.mjs";

const dir = () => mkdtemp(path.join(tmpdir(), "ev-hooks-"));

// See tests/evidence-capture.test.mjs: a mode-based unwritable directory is not
// unwritable for root.
const AS_ROOT = process.getuid?.() === 0;
const SKIP_AS_ROOT = AS_ROOT ? "root bypasses directory permissions" : false;


function config(over = {}) {
  return {
    evidenceCaptureEnabled: true,
    evidenceCaptureTrafficClasses: ["human", "synthetic_test"],
    trafficClasses: { bySessionPrefix: { "mc-chat": "human" }, byAgent: { main: "heartbeat" }, default: "system" },
    ...over,
  };
}

function contexts(over = {}) {
  return {
    runId: "run-1", sessionKey: "mc-chat-1", sessionId: "mc-chat-1",
    agentId: "chat", senderIsOwner: true, ...over,
  };
}

function plugin(cfg, deps = {}) {
  const turns = [];
  const p = createPlugin({
    now: () => 1000,
    writeEvidence: async () => null,
    pruneEvidence: async () => 0,
    writeTurn: async (_d, r) => { turns.push(r); return null; },
    pruneTurns: async () => 0,
    ...deps,
  });
  p.__turns = turns;
  p.__ctx = (o = {}) => ({ ...contexts(o), pluginConfig: cfg });
  return p;
}

const TURN = { prompt: "[user-message:a]\nwhat is the price\n[/user-message:a]", messages: [] };

/**
 * Open the turn the way the host does.
 *
 * `before_prompt_build` is the only hook that sees session and agent identity,
 * and it is where the turn's traffic class is decided. Driving the middleware
 * without it tests a sequence that never occurs: in production the turn always
 * exists first, and the middleware always arrives with nothing.
 */
async function startTurn(p, ctx) {
  await p.handlers.before_prompt_build(TURN, ctx);
  return ctx;
}

/** Register the plugin and return the tool-result middleware it installed. */
function middleware(p, cfg) {
  let fn = null;
  p.register({
    on: () => {},
    registerTool: () => {},
    registerAgentToolResultMiddleware: (handler) => { fn = handler; },
    config: { plugins: { entries: { "llm-grounded": { config: cfg } } } },
  });
  return fn;
}

const SEARCH = {
  results: [
    { title: "Retailer A", url: "https://a.example", snippet: "Listed at $4,000 today." },
    { title: "Retailer B", url: "https://b.example", snippet: "In stock at $4,050." },
  ],
};

async function files(d) {
  try { return (await readdir(d)).filter((f) => f.endsWith(".json")); } catch { return []; }
}
const load = async (d, f) => JSON.parse(await readFile(path.join(d, f), "utf8"));

// ---------------------------------------------------------------------------
// 1, 12, 13 — capture happens, result is untouched, support is not implied
// ---------------------------------------------------------------------------

test("a successful search is captured and the result is returned unchanged", async () => {
  const d = await dir();
  const cfg = config({ evidenceCaptureDir: d });
  const p = plugin(cfg);
  const mw = middleware(p, cfg);

  const ctx = await startTurn(p, p.__ctx());

  const before = structuredClone(SEARCH);
  const out = await mw({ toolName: "web_search", toolCallId: "call-1", params: { query: "price" }, result: SEARCH }, ctx);

  assert.equal(out, undefined, "capture must not rewrite a tool result");
  assert.deepEqual(SEARCH, before, "the result object is not mutated in place");

  const stored = await files(d);
  assert.equal(stored.length, 2, "one record per search hit");
  const rec = await load(d, stored[0]);
  assert.equal(rec.claimSupported, null, "capture asserts nothing about support");
  assert.equal(rec.evidenceView, "effective_tool_result");
  await rm(d, { recursive: true, force: true });
});

test("telemetry references evidence by id and never embeds an excerpt", async () => {
  const d = await dir();
  const cfg = config({ evidenceCaptureDir: d, telemetryDir: "/tmp/unused-telemetry" });
  const p = plugin(cfg);
  const mw = middleware(p, cfg);
  const ctx = p.__ctx();

  await p.handlers.before_prompt_build({ prompt: "[user-message:a]\nwhat is the price\n[/user-message:a]", messages: [] }, ctx);
  await mw({ toolName: "web_search", toolCallId: "c1", params: { query: "price" }, result: SEARCH }, ctx);
  await p.handlers.before_agent_finalize({ runId: "run-1", sessionId: "mc-chat-1", lastAssistantMessage: "About $4,000." }, ctx);
  await p.handlers.agent_end({ runId: "run-1", sessionId: "mc-chat-1" }, ctx);

  assert.equal(p.__turns.length, 1, "exactly one terminal record");
  const rec = p.__turns[0];
  assert.equal(rec.evidenceIds.length, 2);
  assert.equal(rec.evidenceCapturedCount, 2);
  assert.equal(rec.evidenceCaptureStatus, "complete");
  assert.equal(rec.claimSupported, null);
  assert.doesNotMatch(JSON.stringify(rec), /Listed at \$4,000/, "no excerpt in telemetry");
  await rm(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 2, 7 — ineligible calls
// ---------------------------------------------------------------------------

test("failed and unsupported tool calls write nothing", async () => {
  const d = await dir();
  const cfg = config({ evidenceCaptureDir: d });
  const p = plugin(cfg);
  const mw = middleware(p, cfg);

  // Opened as a capturable turn, so what stops these is the tool gate rather
  // than the turn being unidentified — otherwise the assertion would hold even
  // with capture entirely broken.
  const ctx = await startTurn(p, p.__ctx());

  // A truthy object is not proof of success.
  await mw({ toolName: "web_search", toolCallId: "c1", result: { isError: true, content: [{ type: "text", text: "failed" }] } }, ctx);
  await mw({ toolName: "exec", toolCallId: "c2", result: { content: [{ type: "text", text: "secrets" }] } }, ctx);
  await mw({ toolName: "read", toolCallId: "c3", result: { content: [{ type: "text", text: "file body" }] } }, ctx);

  assert.deepEqual(await files(d), []);
  await rm(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 4 — secrets never reach disk
// ---------------------------------------------------------------------------

test("credentials in results and parameters never reach disk", async () => {
  const d = await dir();
  const cfg = config({ evidenceCaptureDir: d });
  const p = plugin(cfg);
  const mw = middleware(p, cfg);

  const ctx = await startTurn(p, p.__ctx());

  await mw({
    toolName: "web_search",
    toolCallId: "c1",
    params: { query: "price", apiKey: "sk-abcdefghijklmnopqrst", cookie: "session=zzz" },
    result: { results: [{ snippet: "Auth uses sk-abcdefghijklmnopqrst and the price is $4,000 as listed." }] },
  }, ctx);

  const stored = await files(d);
  const body = await readFile(path.join(d, stored[0]), "utf8");
  assert.doesNotMatch(body, /sk-abcdefghijklmnopqrst/);
  assert.doesNotMatch(body, /session=zzz/);
  assert.match(body, /redacted/);
  await rm(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 6 — limits
// ---------------------------------------------------------------------------

test("per-call and per-turn limits are enforced", async () => {
  const d = await dir();
  const cfg = config({ evidenceCaptureDir: d, evidenceCaptureMaxItemsPerCall: 2, evidenceCaptureMaxItemsPerTurn: 3 });
  const p = plugin(cfg);
  const mw = middleware(p, cfg);
  const many = { results: Array.from({ length: 6 }, (_, i) => ({ snippet: `result number ${i} with text` })) };

  const ctx = await startTurn(p, p.__ctx());

  await mw({ toolName: "web_search", toolCallId: "c1", result: many }, ctx);
  await mw({ toolName: "web_search", toolCallId: "c2", result: many }, ctx);

  const stored = await files(d);
  assert.equal(stored.length, 3, "per-call cap of 2, per-turn cap of 3");
  await rm(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 10 — traffic classes
// ---------------------------------------------------------------------------

test("human traffic is captured; heartbeat is not", async () => {
  const d = await dir();
  const cfg = config({ evidenceCaptureDir: d });
  const p = plugin(cfg);
  const mw = middleware(p, cfg);

  await mw({ toolName: "web_search", toolCallId: "c1", result: SEARCH }, await startTurn(p, p.__ctx()));
  const afterHuman = (await files(d)).length;
  assert.ok(afterHuman > 0, "human traffic captures");

  // agent main with a bare session id classifies as heartbeat.
  const beat = await startTurn(p,
    p.__ctx({ agentId: "main", sessionKey: "0f5212de-uuid", sessionId: "0f5212de-uuid", runId: "run-2" }));
  await mw({ toolName: "web_search", toolCallId: "c2", result: SEARCH }, beat);
  assert.equal((await files(d)).length, afterHuman, "heartbeat adds nothing");
  // Excluded as heartbeat, on its own merits — not because identity went
  // missing and something answered "system" on its behalf.
  assert.equal(p.__store.get({ runId: "run-2" })?.evidenceCaptureSkipReason, "traffic_class_excluded:heartbeat");
  await rm(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 8 — storage failure
// ---------------------------------------------------------------------------

test("an unwritable store does not alter the result or fail the turn", { skip: SKIP_AS_ROOT }, async () => {
  const d = await dir();
  await chmod(d, 0o500);
  const cfg = config({ evidenceCaptureDir: path.join(d, "nested") });
  const p = plugin(cfg);
  const mw = middleware(p, cfg);

  const ctx = await startTurn(p, p.__ctx());

  const before = structuredClone(SEARCH);
  const out = await mw({ toolName: "web_search", toolCallId: "c1", result: SEARCH }, ctx);
  assert.equal(out, undefined);
  assert.deepEqual(SEARCH, before);

  await chmod(d, 0o700);
  await rm(d, { recursive: true, force: true });
});

test("a storage failure never disturbs the turn", async () => {
  // The same invariant at the level where it matters: capture is an observer,
  // and a bookkeeping problem must not reach the operator. Injected, so it
  // holds regardless of who runs the suite.
  const d = await dir();
  const cfg = config({ evidenceCaptureDir: d });
  const p = plugin(cfg, {
    evidenceCaptureFs: {
      mkdir: async () => undefined,
      writeFile: async () => {
        const error = new Error("permission denied");
        error.code = "EACCES";
        throw error;
      },
      rename: async () => undefined,
    },
  });
  const mw = middleware(p, cfg);
  const ctx = await startTurn(p, p.__ctx());

  const before = structuredClone(SEARCH);
  const out = await mw({ toolName: "web_search", toolCallId: "c1", result: SEARCH }, ctx);

  assert.equal(out, undefined, "the tool result is untouched");
  assert.deepEqual(SEARCH, before);
  assert.deepEqual(await files(d), [], "nothing was stored");

  const entry = p.__store.get({ runId: "run-1" });
  assert.equal(entry.evidenceCaptureAttempted, true, "the attempt is on the record");
  assert.equal(entry.evidenceCapturedCount, 0);
  assert.equal(entry.evidenceCaptureFailedCount, 2, "one failure per evidence item");
  await rm(d, { recursive: true, force: true });
});

test("capture disabled writes nothing at all", async () => {
  const d = await dir();
  const cfg = config({ evidenceCaptureDir: d, evidenceCaptureEnabled: false });
  const p = plugin(cfg);
  const mw = middleware(p, cfg);
  await mw({ toolName: "web_search", toolCallId: "c1", result: SEARCH }, await startTurn(p, p.__ctx()));
  assert.deepEqual(await files(d), []);
  await rm(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 14, 16 — permissions and identity
// ---------------------------------------------------------------------------

test("records are 0600 in a 0700 directory", async () => {
  const d = await dir();
  const cfg = config({ evidenceCaptureDir: path.join(d, "store") });
  const p = plugin(cfg);
  const mw = middleware(p, cfg);
  await mw({ toolName: "web_search", toolCallId: "c1", result: SEARCH }, await startTurn(p, p.__ctx()));

  const store = path.join(d, "store");
  assert.equal((await stat(store)).mode & 0o777, 0o700);
  for (const f of await files(store)) {
    assert.equal((await stat(path.join(store, f))).mode & 0o777, 0o600);
  }
  await rm(d, { recursive: true, force: true });
});

test("identical queries produce distinct evidence ids", async () => {
  // The same query returns different results at different times; merging them
  // under one id would lose that.
  const d = await dir();
  const cfg = config({ evidenceCaptureDir: d, evidenceCaptureMaxItemsPerTurn: 20 });
  const p = plugin(cfg);
  const mw = middleware(p, cfg);
  const one = { results: [{ snippet: "Listed at $4,000 today." }] };

  const ctx = await startTurn(p, p.__ctx());

  await mw({ toolName: "web_search", toolCallId: "c1", params: { query: "price" }, result: one }, ctx);
  await mw({ toolName: "web_search", toolCallId: "c2", params: { query: "price" }, result: one }, ctx);

  const stored = await files(d);
  assert.equal(stored.length, 2);
  const ids = await Promise.all(stored.map(async (f) => (await load(d, f)).evidenceId));
  assert.notEqual(ids[0], ids[1]);
  await rm(d, { recursive: true, force: true });
});
