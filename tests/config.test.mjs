// Configuration parsing, and the vocabulary that installations supply.
//
// Two properties are pinned here that had no test at all:
//
//   * an unknown key is rejected, not dropped. A silently-ignored typo is the
//     worst failure mode a config parser has, because the system starts
//     healthy-looking and behaves as though the operator never wrote the line.
//   * a personal term does not fire on ordinary English. The vocabulary
//     inherited from the private plugin was a *token* set, and porting it
//     verbatim would route "in that case" and "version control" to memory.

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseConfig, DEFAULTS } from "../src/config.js";
import { configurePersonalTerms, configureAgentNames, describeFeatures } from "../src/classify.js";

// ---------------------------------------------------------------------------
// Unknown keys
// ---------------------------------------------------------------------------

test("a misspelled key is rejected rather than dropped", () => {
  for (const [typo, cfg] of [
    ["telemtryDir", { telemtryDir: "/tmp/x" }],
    ["telemetryDirectory", { telemetryDirectory: "/tmp/x" }],
    ["trafficClass", { trafficClass: { byAgent: {} } }],
    ["traffic_classes", { traffic_classes: {} }],
    ["personalTerm", { personalTerm: ["x"] }],
  ]) {
    const r = parseConfig(cfg);
    assert.equal(r.success, false, `${typo} was accepted`);
    assert.match(r.error.issues[0].message, new RegExp(typo));
  }
});

test("the correctly spelled keys still parse", () => {
  const r = parseConfig({
    telemetryDir: "/tmp/x",
    trafficClasses: { byAgent: { main: "heartbeat" } },
    personalTerms: ["kestrel"],
  });
  assert.equal(r.success, true, r.error?.issues?.[0]?.message);
  assert.equal(r.data.telemetryDir, "/tmp/x");
});

test("an unknown field inside trafficClasses is rejected too", () => {
  // Nested objects are where a typo hides best: the outer key is right, so a
  // shallow check would pass it.
  const r = parseConfig({ trafficClasses: { bySession: { "mc-chat": "human" } } });
  assert.equal(r.success, false);
  assert.match(r.error.issues[0].message, /bySession/);
});

test("an invalid traffic class is rejected, not coerced", () => {
  const r = parseConfig({ trafficClasses: { byAgent: { main: "Human Traffic" } } });
  assert.equal(r.success, false);
  assert.match(r.error.issues[0].message, /must be one of/);
});

test("absent config yields defaults", () => {
  const r = parseConfig(undefined);
  assert.equal(r.success, true);
  assert.equal(r.data.telemetryDir, DEFAULTS.telemetryDir);
});

// ---------------------------------------------------------------------------
// Vocabulary: phrases, not tokens
// ---------------------------------------------------------------------------

/** Whether the classifier read this turn as touching the operator's own world. */
function personal(message) {
  return describeFeatures(message).personalTerms === true;
}

test("ordinary English is not mistaken for installation vocabulary", () => {
  // The private plugin's list held "case", "control", "mission" and
  // "endurance" as separate tokens. Ported verbatim, each of these turns would
  // route to memory and land in the disagreement set as noise.
  configurePersonalTerms([
    "sam", "rivera", "kestrel", "partsbom", "openclaw", "northgate", "msu",
    // "endurance" is deliberately absent. It was in the inherited token set,
    // but as a standalone word it fires on "endurance training" and "endurance
    // race". If it names something here, it has to be configured as a phrase.
    "opnsense", "mikrotik", "truenas", "proxmox", "335ix", "e90",
    "mission control", "market research", "vault tools", "recursivemas",
  ]);
  configureAgentNames(["atlas", "kipp", "mercer", "case"]);

  for (const turn of [
    "in that case, let's wait",
    "version control is being difficult",
    "that's mission critical",
    "endurance training is going well",
  ]) {
    assert.equal(personal(turn), false, `false personal signal on: ${turn}`);
  }
});

test("the real vocabulary still matches", () => {
  for (const turn of [
    "how is mission control doing",
    "what is the kestrel's chassis code",
    "check the proxmox node",
    "what did sam say about it",
  ]) {
    assert.equal(personal(turn), true, `missed personal signal on: ${turn}`);
  }
});

test("an agent name is stripped as address, not read as a subject", () => {
  // "case" is both an agent name and an ordinary English word. It belongs in
  // agentNames, where it is only removed as a comma-terminated vocative.
  configurePersonalTerms([]);
  configureAgentNames(["atlas", "case"]);
  assert.equal(personal("case, what is the status"), false);
  assert.equal(personal("in any case we should wait"), false);
});

test("an empty vocabulary is safe", () => {
  configurePersonalTerms([]);
  configureAgentNames([]);
  assert.equal(personal("how is mission control doing"), false);
});
