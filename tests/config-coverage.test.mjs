// Every key the schema advertises must survive being configured.
//
// Written after 0.3.0 took the plugin down in production. The validator's
// branch for three new integer keys referenced an identifier that does not
// exist in that scope — `field` where the switch binds `key` — so the first
// config that actually set one of them threw ReferenceError during `register`,
// and the gateway came up with the plugin missing entirely.
//
// Every other test passed. The whole suite configures a handful of keys by
// hand, and none of them was one of the three. A schema that advertises a key
// no test has ever set is a promise nobody has checked, and there were, at the
// time this was written, several.
//
// So this walks the published schema and configures every property in it, with
// a value derived from the schema itself. A key added to the schema without a
// working validation branch fails here, by construction, without anyone
// remembering to write a test for it.

import { test } from "node:test";
import assert from "node:assert/strict";

import { CONFIG_JSON_SCHEMA, DEFAULTS, parseConfig } from "../src/config.js";
import { createPlugin } from "../src/index.js";

/** A value the schema should accept, derived from the schema's own constraints. */
function sampleFor(name, spec) {
  if (spec.enum) return spec.enum[0];
  switch (spec.type) {
    case "boolean":
      return true;
    case "integer": {
      const min = Number.isFinite(spec.minimum) ? spec.minimum : 1;
      const max = Number.isFinite(spec.maximum) ? spec.maximum : min + 1;
      // Mid-range where possible, so a bound is not accidentally the only
      // value ever tried.
      return Math.min(max, Math.max(min, Math.floor((min + max) / 2)));
    }
    case "string":
      // Paths, ids and labels alike: a non-empty string that satisfies
      // minLength and reads as obviously synthetic.
      // Distinct per key: several directory settings are required to differ
      // from one another, and a sampler that hands them all the same value
      // fails those checks for a reason that has nothing to do with the key
      // under test.
      return name.toLowerCase().includes("dir") || name.toLowerCase().includes("path")
        ? `/tmp/llm-grounded-schema-check/${name}`
        : "schema-check";
    case "array": {
      const items = spec.items ?? {};
      if (items.enum) return [items.enum[0]];
      return ["schema-check"];
    }
    case "object": {
      // Only trafficClasses today. Build it from its own declared shape rather
      // than hard-coding, so a second object key is covered too.
      const out = {};
      for (const [field, sub] of Object.entries(spec.properties ?? {})) {
        if (sub.enum) out[field] = sub.enum[0];
        else if (sub.type === "object") out[field] = {};
      }
      return out;
    }
    default:
      return null;
  }
}

const PROPERTIES = Object.entries(CONFIG_JSON_SCHEMA.properties);

test("the schema advertises at least the keys this test expects to walk", () => {
  // A guard on the guard: if the schema were ever emptied or renamed, the loop
  // below would pass by doing nothing.
  assert.ok(PROPERTIES.length > 30, `only ${PROPERTIES.length} properties found`);
});

test("every advertised key can be set, one at a time", () => {
  for (const [name, spec] of PROPERTIES) {
    const value = sampleFor(name, spec);
    if (value === null) continue;
    const parsed = parseConfig({ [name]: value });
    assert.equal(
      parsed.success,
      true,
      `${name} is in the published schema but parseConfig rejected ${JSON.stringify(value)}: ${JSON.stringify(parsed.error)}`,
    );
    assert.notEqual(
      parsed.data?.[name],
      undefined,
      `${name} parsed but was not carried onto the config`,
    );
  }
});

test("every advertised key can be set at once", () => {
  // One at a time would miss a branch that clobbers a sibling — the shape of
  // the bug that started this file was a branch writing to the wrong name.
  const all = {};
  for (const [name, spec] of PROPERTIES) {
    const value = sampleFor(name, spec);
    if (value !== null) all[name] = value;
  }
  const parsed = parseConfig(all);
  assert.equal(parsed.success, true, `full config rejected: ${JSON.stringify(parsed.error)}`);
  for (const name of Object.keys(all)) {
    assert.notEqual(parsed.data?.[name], undefined, `${name} was dropped when set alongside the others`);
  }
});

test("every advertised key has a default, so an unset key is never undefined", () => {
  for (const [name] of PROPERTIES) {
    assert.notEqual(DEFAULTS[name], undefined, `${name} is advertised but has no default`);
  }
});

test("the claim-extraction keys specifically round-trip", () => {
  // Named explicitly as well as covered by the walk above, because these are
  // the three that were broken and a regression should say so by name.
  const parsed = parseConfig({
    claimExtractionEnabled: true,
    claimExtractionDir: "/tmp/claims",
    claimExtractionRetentionDays: 7,
    claimExtractionTimeoutMs: 15000,
    claimExtractionMaxTokens: 8000,
    claimExtractionAgentId: "kipp",
    claimExtractionTrafficClasses: ["human"],
  });
  assert.equal(parsed.success, true, JSON.stringify(parsed.error));
  assert.equal(parsed.data.claimExtractionRetentionDays, 7);
  assert.equal(parsed.data.claimExtractionTimeoutMs, 15000);
  assert.equal(parsed.data.claimExtractionMaxTokens, 8000);
  assert.equal(parsed.data.claimExtractionAgentId, "kipp");
});

test("the three record stores may not share a directory", () => {
  // Different record shapes and different retentions. Sharing a path makes them
  // one pile, and the shortest retention quietly governs the lot.
  for (const bad of [
    { claimExtractionDir: DEFAULTS.evidenceDir },
    { claimExtractionDir: DEFAULTS.evidenceCaptureDir },
    { claimExtractionDir: DEFAULTS.telemetryDir },
    { evidenceCaptureDir: DEFAULTS.evidenceDir },
  ]) {
    const parsed = parseConfig(bad);
    assert.equal(parsed.success, false, `${JSON.stringify(bad)} should be refused`);
  }
});

test("a bad value for a claim-extraction key is refused, not thrown on", () => {
  for (const bad of [
    { claimExtractionRetentionDays: 0 },
    { claimExtractionRetentionDays: "seven" },
    { claimExtractionTimeoutMs: -1 },
    { claimExtractionMaxTokens: 1.5 },
    { claimExtractionAgentId: 7 },
    { claimExtractionTrafficClasses: ["not-a-class"] },
    { claimExtractionEnabled: "yes" },
    { claimExtractionDir: "" },
  ]) {
    const parsed = parseConfig(bad);
    assert.equal(parsed.success, false, `${JSON.stringify(bad)} should be refused`);
    assert.ok(String(parsed.error ?? "").length > 0, "a refusal must say why");
  }
});

test("the plugin registers against a config that sets every advertised key", () => {
  // parseConfig coverage is necessary and was not sufficient: the 0.3.0 outage
  // surfaced during `register`, where a throw leaves the gateway running with
  // the plugin simply absent — no grounding, no voice contract, no capture, and
  // one line in a log nobody was tailing. This drives the same entry point the
  // host does.
  const config = {};
  for (const [name, spec] of PROPERTIES) {
    const value = sampleFor(name, spec);
    if (value !== null) config[name] = value;
  }

  const p = createPlugin({});
  const errors = [];
  assert.doesNotThrow(() => {
    p.register({
      on: () => {},
      registerTool: () => {},
      registerAgentToolResultMiddleware: () => {},
      logger: { info: () => {}, warn: () => {}, error: (m) => errors.push(String(m)), debug: () => {} },
      config: { plugins: { entries: { "llm-grounded": { enabled: true, config } } } },
    });
  });

  assert.equal(typeof p.handlers.before_prompt_build, "function", "the plugin came up with its hooks");
  assert.deepEqual(errors, [], `registration reported: ${errors.join("; ")}`);
});
