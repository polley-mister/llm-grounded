// Shadow claim extraction: it measures, and it may do nothing else.
//
// This is the only thing in the package that adds a model call to a production
// turn. Most of what follows is negative: the turn is already delivered when it
// runs, so the tests that matter most are the ones asserting it cannot reach
// backwards — no revision, no retrieval, no refusal, no block, no support
// label, and no way to fail a turn that has already succeeded.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createPlugin } from "../src/index.js";
import { runShadowExtraction } from "../src/claim-shadow.js";

import "./_vocabulary.mjs";

const dir = () => mkdtemp(path.join(tmpdir(), "claim-shadow-"));

const TURN = { prompt: "[user-message:a]\nwhat is the price\n[/user-message:a]", messages: [] };
const CTX = { runId: "run-1", sessionKey: "mc-chat-9", sessionId: "mc-chat-9-abc", agentId: "tars-chat" };

/** A model that returns one well-formed extraction. */
function extractor(claims) {
  return {
    calls: [],
    async complete(req) {
      this.calls.push(req);
      return {
        text: JSON.stringify({ claims }),
        provider: "test",
        model: "test-flash",
        finishReason: "stop",
        usage: { inputTokens: 100, outputTokens: 40 },
      };
    },
  };
}

/** One claim in the frozen v2 contract, as the extractor validates it. */
const CLAIM = {
  id: "c1",
  surfaceText: "The price is $4,000.",
  proposition: "The price of the item is $4,000.",
  claimType: "current_external",
  modality: "asserted",
  factual: true,
  material: true,
  verificationTarget: true,
  requiredEvidence: ["web"],
  confidence: 0.9,
};

function config(claimDir, over = {}) {
  return {
    enabledAgents: ["main", "chat", "tars-chat"],
    telemetryDir: "/tmp/unused-telemetry",
    claimExtractionEnabled: true,
    claimExtractionDir: claimDir,
    claimExtractionTrafficClasses: ["human", "synthetic_test"],
    trafficClasses: { bySessionPrefix: { "mc-chat": "human" }, byAgent: { main: "heartbeat" }, default: "system" },
    ...over,
  };
}

function plugin(cfg, llm, extraDeps = {}) {
  const turns = [];
  const p = createPlugin({
    now: () => 1000,
    writeTurn: async (_d, r) => { turns.push(r); return null; },
    pruneTurns: async () => 0,
    claimLlm: llm,
    ...extraDeps,
  });
  const registered = {};
  p.register({
    on: (name, fn) => { registered[name] = fn; },
    registerTool: () => {},
    registerAgentToolResultMiddleware: () => {},
    config: { plugins: { entries: { "llm-grounded": { enabled: true, config: cfg } } } },
  });
  p.__turns = turns;
  p.__on = registered;
  return p;
}

const files = async (d) => {
  try { return (await readdir(d)).filter((f) => f.startsWith("cx_")); } catch { return []; }
};
const load = async (d, f) => JSON.parse(await readFile(path.join(d, f), "utf8"));

/** Drive a whole turn to agent_end. */
async function runTurn(p, cfg, over = {}) {
  const ctx = { ...CTX, ...over, pluginConfig: cfg };
  await p.handlers.before_prompt_build(TURN, ctx);
  await p.__on.before_agent_finalize({ lastAssistantMessage: "The price is $4,000." }, ctx);
  await p.handlers.agent_end({ runId: ctx.runId }, ctx);
  return ctx;
}

// ---------------------------------------------------------------------------
// It runs, and what it produces stays in its own store
// ---------------------------------------------------------------------------

test("an eligible turn is extracted from, after it has already been delivered", async () => {
  const d = await dir();
  const cfg = config(d);
  const llm = extractor([CLAIM]);
  const p = plugin(cfg, llm);

  await runTurn(p, cfg);

  const stored = await files(d);
  assert.equal(stored.length, 1, "one extraction record");
  const rec = await load(d, stored[0]);
  assert.equal(rec.status, "extracted");
  assert.equal(rec.claimCount, 1);
  assert.equal(rec.materialClaimCount, 1);
  assert.equal(rec.trafficClass, "human");

  const turn = p.__turns[0];
  assert.equal(turn.claimExtractionId, rec.extractionId, "the turn references it by id");
  assert.equal(turn.claimExtractionStatus, "extracted");
  assert.equal(turn.claimCount, 1);
  await rm(d, { recursive: true, force: true });
});

test("claims never appear in telemetry, only a reference to them", async () => {
  // Telemetry is the one store that must stay free of verbatim content.
  const d = await dir();
  const cfg = config(d);
  const p = plugin(cfg, extractor([CLAIM]));
  await runTurn(p, cfg);

  const turn = JSON.stringify(p.__turns[0]);
  // The delivered answer is legitimately in telemetry — that is the record of
  // what shipped. What must not be there is the extraction: the propositions
  // read out of it, and any structure that would let a consumer read claims
  // from a turn record instead of from the store that owns them.
  assert.doesNotMatch(turn, /The price of the item is \$4,000\./, "no proposition in telemetry");
  assert.doesNotMatch(turn, /"claims"/, "no claims array in telemetry");
  assert.doesNotMatch(turn, /"requiredEvidence"/);
  assert.match(turn, /"claimExtractionId":"cx_/);
  await rm(d, { recursive: true, force: true });
});

test("records are 0600 in a 0700 directory", async () => {
  const d = await dir();
  const store = path.join(d, "claims");
  const cfg = config(store);
  const p = plugin(cfg, extractor([CLAIM]));
  await runTurn(p, cfg);

  assert.equal((await stat(store)).mode & 0o777, 0o700);
  for (const f of await files(store)) {
    assert.equal((await stat(path.join(store, f))).mode & 0o777, 0o600);
  }
  await rm(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// It has no authority
// ---------------------------------------------------------------------------

test("extraction never labels support, however many claims it found", async () => {
  const d = await dir();
  const cfg = config(d);
  const p = plugin(cfg, extractor([CLAIM]));
  await runTurn(p, cfg);

  const rec = await load(d, (await files(d))[0]);
  assert.equal(rec.claimSupported, null);
  assert.deepEqual(rec.supportLabels, []);
  assert.equal(p.__turns[0].claimSupported, null);
  await rm(d, { recursive: true, force: true });
});

test("the extraction request carries no tools, no memory, no workspace and no persona", async () => {
  // A claim extractor that can retrieve is no longer measuring the draft, and
  // one that can see the persona is being asked to reason about its own output
  // as a character.
  const d = await dir();
  const cfg = config(d);
  const llm = extractor([CLAIM]);
  const p = plugin(cfg, llm);
  await runTurn(p, cfg);

  assert.equal(llm.calls.length, 1);
  const req = llm.calls[0];
  assert.deepEqual(req.tools, []);
  assert.equal(req.memory, false);
  assert.equal(req.workspaceContext, false);
  assert.equal(req.persona, false);
  assert.equal(req.temperature, 0);
  await rm(d, { recursive: true, force: true });
});

test("a provider outage does not disturb a turn that already shipped", async () => {
  const d = await dir();
  const cfg = config(d);
  const p = plugin(cfg, { async complete() { throw new Error("provider down"); } });

  await runTurn(p, cfg);

  assert.equal(p.__turns.length, 1, "the turn was still recorded");
  assert.equal(p.__turns[0].final, "The price is $4,000.", "and says what shipped");
  assert.equal(p.__turns[0].claimExtractionStatus, "abstained");
  assert.equal(p.__turns[0].claimExtractionAbstentionReason, "provider_error");
  await rm(d, { recursive: true, force: true });
});

test("an unwritable extraction store does not disturb the turn either", async () => {
  // The failure is injected rather than provoked with a directory mode: root
  // can write into an unwritable directory, which is exactly how the evidence
  // writer's failure branch went untested for four releases.
  const cfg = config("/tmp/unused-claim-store");
  const p = plugin(cfg, extractor([CLAIM]), {
    claimExtractionFs: {
      mkdir: async () => undefined,
      writeFile: async () => { const e = new Error("permission denied"); e.code = "EACCES"; throw e; },
    },
  });
  await runTurn(p, cfg);
  assert.equal(p.__turns.length, 1);
  // The extraction happened; only the record did not. Both are reported.
  assert.equal(p.__turns[0].claimExtractionStatus, "extracted");
  assert.equal(p.__turns[0].claimExtractionId, null);
});

test("a model that returns nonsense abstains rather than inventing claims", async () => {
  const d = await dir();
  const cfg = config(d);
  const p = plugin(cfg, { async complete() { return { text: "not json at all", finishReason: "stop" }; } });
  await runTurn(p, cfg);

  assert.equal(p.__turns[0].claimExtractionStatus, "abstained");
  assert.equal(p.__turns[0].claimCount, 0);
  await rm(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Who it runs for
// ---------------------------------------------------------------------------

test("heartbeat traffic is not extracted from", async () => {
  // A model call apiece, every thirty minutes, on traffic the calibration is
  // not about.
  const d = await dir();
  const cfg = config(d);
  const llm = extractor([CLAIM]);
  const p = plugin(cfg, llm);

  await runTurn(p, cfg, { agentId: "main", sessionKey: "0f5212de", sessionId: "0f5212de" });

  assert.equal(llm.calls.length, 0, "no model call at all");
  assert.deepEqual(await files(d), []);
  assert.equal(p.__turns[0].claimExtractionSkipReason, "traffic_class_excluded");
  await rm(d, { recursive: true, force: true });
});

test("a turn whose traffic was never resolved is not extracted from", async () => {
  const d = await dir();
  const cfg = config(d, { enabledAgents: [] });
  const llm = extractor([CLAIM]);
  const p = plugin(cfg, llm);

  const ctx = { runId: "run-1", pluginConfig: cfg };
  await p.handlers.before_prompt_build(TURN, ctx);
  await p.__on.before_agent_finalize({ lastAssistantMessage: "The price is $4,000." }, ctx);
  await p.handlers.agent_end({ runId: "run-1" }, ctx);

  assert.equal(llm.calls.length, 0);
  assert.equal(p.__turns[0].claimExtractionSkipReason, "traffic_class_excluded");
  await rm(d, { recursive: true, force: true });
});

test("disabled means no model call, not a quiet one", async () => {
  const d = await dir();
  const cfg = config(d, { claimExtractionEnabled: false });
  const llm = extractor([CLAIM]);
  const p = plugin(cfg, llm);
  await runTurn(p, cfg);

  assert.equal(llm.calls.length, 0);
  assert.deepEqual(await files(d), []);
  assert.equal(p.__turns[0].claimExtractionSkipReason, "disabled");
  await rm(d, { recursive: true, force: true });
});

test("with no runtime model the turn says so rather than looking clean", async () => {
  const d = await dir();
  const cfg = config(d);
  const p = plugin(cfg, undefined);
  await runTurn(p, cfg);
  assert.equal(p.__turns[0].claimExtractionSkipReason, "no_llm");
  assert.equal(p.__turns[0].claimExtractionStatus, "skipped");
  await rm(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Once per turn
// ---------------------------------------------------------------------------

test("a turn is extracted from once, however many times agent_end fires", async () => {
  const d = await dir();
  const cfg = config(d);
  const llm = extractor([CLAIM]);
  const p = plugin(cfg, llm);
  const ctx = { ...CTX, pluginConfig: cfg };

  await p.handlers.before_prompt_build(TURN, ctx);
  await p.__on.before_agent_finalize({ lastAssistantMessage: "The price is $4,000." }, ctx);
  await p.handlers.agent_end({ runId: "run-1" }, ctx);
  await p.handlers.agent_end({ runId: "run-1" }, ctx);

  assert.equal(llm.calls.length, 1, "one model call, not one per lane");
  assert.equal((await files(d)).length, 1);
  await rm(d, { recursive: true, force: true });
});

test("an empty answer is not sent to the model", async () => {
  const d = await dir();
  const cfg = config(d);
  const llm = extractor([CLAIM]);
  const p = plugin(cfg, llm);
  const ctx = { ...CTX, pluginConfig: cfg };

  await p.handlers.before_prompt_build(TURN, ctx);
  await p.handlers.agent_end({ runId: "run-1" }, ctx);

  assert.equal(llm.calls.length, 0);
  assert.equal(p.__turns[0].claimExtractionSkipReason, "no_final_text");
  await rm(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The unit, directly
// ---------------------------------------------------------------------------

test("runShadowExtraction never throws, whatever it is handed", async () => {
  const cases = [
    {},
    { cfg: null, entry: null },
    { cfg: { claimExtractionEnabled: true }, entry: null, finalText: "x" },
    { cfg: { claimExtractionEnabled: true, claimExtractionTrafficClasses: ["human"] }, entry: { traffic: { status: "resolved", trafficClass: "human" } }, finalText: "x", llm: { complete: null } },
  ];
  for (const input of cases) {
    const out = await runShadowExtraction(input);
    assert.equal(typeof out, "object", JSON.stringify(input));
    assert.ok("ran" in out);
  }
});
