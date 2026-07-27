// Retrieval precedence. Writing the record was never enough on its own: a
// stale synthesis paragraph reads exactly as authoritative to the model.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createOverlayReader,
  findConflicts,
  overlayText,
  overlayToolResult,
} from "../src/facts-overlay.js";
import { createPlugin } from "../src/index.js";

const CAR = {
  version: 1,
  facts: {
    "operator.vehicle.car.chassis": {
      subject: "the car",
      property: "chassis code",
      currentValue: "TC20",
      supersededValues: ["TC10"],
      revision: 2,
      page: "facts/operator-vehicle-car-chassis.md",
      needsRematerialization: true,
    },
  },
};

const STALE_PROSE =
  "the car — Vehicle Records\n\nVehicle records for the operator's BMW 330i, an TC10 chassis with the N54.";

test("stale prose is detected and the authoritative value leads", () => {
  const result = overlayText(CAR, STALE_PROSE);
  assert.equal(result.changed, true);
  assert.equal(result.conflicts.length, 1);
  // The block leads, so the fact is the first thing read rather than a footnote
  // after the paragraph that contradicts it.
  assert.ok(result.text.startsWith("[authoritative fact records"));
  assert.match(result.text, /chassis code: TC20 \(revision 2/);
  assert.match(result.text, /"TC10" is superseded and must not be used/);
  // Nothing retrieved is dropped.
  assert.ok(result.text.includes(STALE_PROSE));
});

test("prose that already agrees is left completely alone", () => {
  const agreeing = "the car is the operator's 330i, an TC20 chassis.";
  assert.equal(overlayText(CAR, agreeing).changed, false);
  assert.equal(overlayText(CAR, "Unrelated page about OPNsense.").changed, false);
  assert.equal(overlayText(CAR, "").changed, false);
});

test("a superseded value must be stated, not merely a substring", () => {
  // "E9" and "90" are substrings of nothing relevant here; the token matcher is
  // what keeps this from firing on every page that contains a number.
  assert.deepEqual(findConflicts(CAR, "The E9 was a different car entirely."), []);
  assert.deepEqual(findConflicts(CAR, "90 degrees."), []);
  assert.equal(findConflicts(CAR, "an TC10 chassis").length, 1);
});

test("an empty or malformed overlay changes nothing", () => {
  for (const overlay of [null, undefined, {}, { facts: null }, { facts: {} }]) {
    assert.equal(overlayText(overlay, STALE_PROSE).changed, false);
  }
});

test("a tool result is rewritten on its first text part, leaving the rest alone", () => {
  const applied = overlayToolResult(CAR, {
    content: [{ type: "text", text: STALE_PROSE }, { type: "text", text: "second part" }],
    details: { hits: 2 },
  });
  assert.ok(applied.result.content[0].text.startsWith("[authoritative fact records"));
  assert.equal(applied.result.content[1].text, "second part", "later parts are untouched");
  assert.deepEqual(applied.result.details, { hits: 2 }, "details are untouched");

  assert.equal(overlayToolResult(CAR, { content: [{ type: "text", text: "already TC20" }] }), null);
  assert.equal(overlayToolResult(CAR, { content: "not an array" }), null);
  assert.equal(overlayToolResult(CAR, null), null);
});

test("the reader caches, survives a missing overlay, and can be invalidated", async () => {
  let reads = 0;
  let payload = JSON.stringify(CAR);
  let clock = 0;
  const reader = createOverlayReader({
    vaultPath: "/tmp/vault",
    cacheMs: 1000,
    now: () => clock,
    read: async () => {
      reads += 1;
      if (payload === null) {
        const err = new Error("missing");
        err.code = "ENOENT";
        throw err;
      }
      return payload;
    },
  });

  assert.equal((await reader.load()).facts["operator.vehicle.car.chassis"].currentValue, "TC20");
  await reader.load();
  assert.equal(reads, 1, "a second read inside the cache window is served from cache");

  // A commit must be visible to the very next retrieval in the same turn.
  reader.invalidate();
  await reader.load();
  assert.equal(reads, 2);

  payload = null;
  reader.invalidate();
  assert.deepEqual((await reader.load()).facts, {}, "a missing overlay degrades, it does not throw");

  payload = "{ not json";
  reader.invalidate();
  assert.deepEqual((await reader.load()).facts, {});
});

/**
 * Register the plugin exactly as OpenClaw does and return the middleware it
 * actually registered — not the helper, not a handler reached by hand. This is
 * what proves the seam is wired, which the previous `tool_result_persist`
 * registration failed to be: that hook is transcript persistence and its runner
 * discards an async handler's Promise outright.
 */
function registeredMiddleware(cfg, { overlayReader } = {}) {
  const registrations = [];
  const p = createPlugin({
    now: () => 1000,
    writeEvidence: async () => null,
    pruneEvidence: async () => 0,
    overlayReader: overlayReader ?? { load: async () => CAR, invalidate() {} },
  });
  p.register({
    on: () => {},
    registerTool: () => {},
    registerAgentToolResultMiddleware: (handler, opts) => registrations.push({ handler, opts }),
    config: { plugins: { entries: { "llm-grounded": { config: cfg } } } },
  });
  assert.equal(registrations.length, 1, "exactly one middleware must be registered");
  return { ...registrations[0], plugin: p };
}

const MW_CFG = {
  factsEnabled: true,
  factsAgents: ["main", "chat"],
  vaultPath: "/tmp/vault",
  factsCliPath: "/tmp/x.py",
};

test("the registered middleware targets the openclaw runtime", () => {
  const { opts } = registeredMiddleware(MW_CFG);
  assert.deepEqual(opts.runtimes, ["openclaw"]);
});

test("the registered middleware overlays retrievals for covered agents only", async () => {
  const { handler } = registeredMiddleware(MW_CFG);
  const result = () => ({ content: [{ type: "text", text: STALE_PROSE }], details: {} });

  for (const toolName of ["wiki_search", "wiki_get"]) {
    const out = await handler({ toolName, toolCallId: "c1", args: {}, result: result() },
      { runtime: "openclaw", agentId: "chat" });
    assert.ok(out.result.content[0].text.startsWith("[authoritative fact records"), toolName);
  }

  // Not a retrieval tool.
  assert.equal(
    await handler({ toolName: "web_search", toolCallId: "c1", args: {}, result: result() },
      { runtime: "openclaw", agentId: "chat" }),
    undefined,
  );
  // Not an agent this contract covers.
  assert.equal(
    await handler({ toolName: "wiki_search", toolCallId: "c1", args: {}, result: result() },
      { runtime: "openclaw", agentId: "Atlas" }),
    undefined,
  );
});

test("OpenClaw 2026.7.1's runtime-only middleware context uses a trusted call-id binding", async () => {
  const { handler, plugin } = registeredMiddleware(MW_CFG);
  const hookCtx = {
    runId: "run-1",
    sessionKey: "agent:chat:explicit:test",
    agentId: "chat",
    pluginConfig: MW_CFG,
    toolCallId: "bound-1",
  };
  plugin.handlers.before_tool_call({ toolName: "wiki_get" }, hookCtx);
  const event = {
    toolName: "wiki_get",
    toolCallId: "bound-1",
    args: {},
    result: { content: [{ type: "text", text: STALE_PROSE }], details: {} },
  };
  const out = await handler(event, { runtime: "openclaw" });
  assert.match(out.result.content[0].text, /authoritative fact records/);
  assert.equal(
    await handler(event, { runtime: "openclaw" }),
    undefined,
    "the trusted call-id capability is consumed exactly once",
  );
});

test("the middleware closes when config cannot be resolved", async () => {
  const { handler } = registeredMiddleware({});
  // Defaults leave factsEnabled false, so an unresolvable config hides the
  // overlay rather than exposing it.
  assert.equal(
    await handler(
      { toolName: "wiki_search", toolCallId: "c1", args: {}, result: { content: [{ type: "text", text: STALE_PROSE }] } },
      { runtime: "openclaw", agentId: "chat" },
    ),
    undefined,
  );
});

test("the car acceptance case: TC20 beats stale TC10 prose before the model sees it", async () => {
  const { handler } = registeredMiddleware({ ...MW_CFG, factsAgents: ["chat"] });
  // Exactly the retrieval the live vault would return today: the synthesis
  // still says TC10, because materialization was ambiguous and correctly left
  // the prose alone.
  const event = {
    toolName: "wiki_search",
    toolCallId: "call-1",
    args: { query: "the car chassis" },
    result: {
      content: [
        {
          type: "text",
          text: "syntheses/2011-bmw-330i-vehicle-record.md\n\nThe car is a 2011 BMW 330i, TC10 chassis, N54 engine.",
        },
      ],
      details: {},
    },
  };
  const out = await handler(event, { runtime: "openclaw", agentId: "chat", sessionKey: "agent:chat:main" });
  const text = out.result.content[0].text;
  assert.ok(text.indexOf("TC20") < text.indexOf("TC10 chassis"), "the record must lead the stale prose");
  assert.match(text, /"TC10" is superseded and must not be used/);
  // The original event object is not mutated in place; the middleware returns a
  // replacement, which is what the runtime forwards to the model.
  assert.equal(event.result.content[0].text.startsWith("syntheses/"), true);
});
