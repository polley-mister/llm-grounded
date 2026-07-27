import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import plugin, { PLUGIN_ID } from "../src/index.js";
import { CONFIG_JSON_SCHEMA } from "../src/config.js";
import { FACT_TOOL_NAME } from "../src/facts-tool.js";

import "./_vocabulary.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(path.join(root, "openclaw.plugin.json"), "utf8"));
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

/** the console's mirror of the shared classification vectors. */
// A downstream consumer may mirror these vectors so the two gates cannot
// drift. Set MIRRORED_VECTORS to that copy to assert byte-for-byte parity.
const MC_VECTORS = process.env.MIRRORED_VECTORS ?? "";

test("manifest identity matches the runtime plugin", () => {
  assert.equal(manifest.id, PLUGIN_ID);
  assert.equal(manifest.id, plugin.id);
  assert.equal(manifest.name, plugin.name);
  assert.equal(manifest.description, plugin.description);
  assert.equal(manifest.version, pkg.version);
});

test("manifest carries an inline config schema identical to the runtime schema", () => {
  assert.equal(typeof manifest.configSchema, "object");
  assert.deepEqual(manifest.configSchema, CONFIG_JSON_SCHEMA);
  assert.equal(manifest.configSchema.additionalProperties, false);
});

test("the manifest declares startup activation and exactly the one tool it owns", () => {
  assert.equal(manifest.activation.onStartup, true);
  assert.deepEqual(manifest.activation.onCapabilities, ["hook"]);
  // Runtime `api.registerTool` registrations must match `contracts.tools`, or
  // OpenClaw cannot resolve tool ownership without loading plugin code.
  assert.deepEqual(manifest.contracts.tools, [FACT_TOOL_NAME]);
  // Optional, so the tool is not exposed until an operator allowlists it —
  // and so OpenClaw does not load this runtime just to find out.
  assert.equal(manifest.toolMetadata[FACT_TOOL_NAME].optional, true);
  // Registration is refused outright unless the manifest declares the runtime.
  assert.deepEqual(manifest.contracts.agentToolResultMiddleware, ["openclaw"]);
});

test("package metadata points OpenClaw at the runtime entry", () => {
  assert.equal(pkg.type, "module");
  assert.deepEqual(pkg.openclaw.extensions, ["./src/index.js"]);
  assert.ok(pkg.openclaw.compat.pluginApi);
});

test("register wires exactly the contract hooks, the one tool, and the middleware", () => {
  const seen = [];
  const tools = [];
  const middlewares = [];
  plugin.register({
    on: (name, _handler, opts) => seen.push({ name, priority: opts?.priority }),
    registerTool: (tool, opts) => tools.push({ tool, opts }),
    registerAgentToolResultMiddleware: (handler, opts) => middlewares.push({ handler, opts }),
  });
  assert.deepEqual(
    seen.map((s) => s.name),
    [
      "before_prompt_build",
      "before_tool_call",
      "after_tool_call",
      "before_agent_finalize",
      "before_message_write",
      "agent_end",
      "reply_payload_sending",
      "message_sending",
    ],
  );
  const delivery = seen.filter((s) => s.name.endsWith("_sending"));
  for (const d of delivery) {
    assert.ok(d.priority < 0, `${d.name} must run after ordinary hooks so it cannot be bypassed`);
  }
  assert.equal(tools.length, 1);
  assert.equal(tools[0].opts.name, FACT_TOOL_NAME);
  assert.equal(tools[0].opts.optional, true);
  assert.equal(typeof tools[0].tool, "function", "the tool is a per-run factory, not a static tool");

  // Retrieval precedence runs on the async pre-model middleware seam, not on
  // tool_result_persist: that hook is transcript persistence and its runner
  // discards a Promise outright.
  assert.equal(middlewares.length, 1);
  assert.deepEqual(middlewares[0].opts.runtimes, ["openclaw"]);
  assert.equal(seen.some((h) => h.name === "tool_result_persist"), false);
});

test("the console mirrors the classification vectors byte for byte", async (t) => {
  try {
    await access(MC_VECTORS);
  } catch {
    t.skip("the console checkout not present");
    return;
  }
  const mine = await readFile(path.join(root, "tests", "vectors", "grounding-cases.json"), "utf8");
  const theirs = await readFile(MC_VECTORS, "utf8");
  assert.equal(
    theirs,
    mine,
    "the plugin gate and the the console gate must be tested against identical vectors",
  );
});
