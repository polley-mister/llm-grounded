import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CORRECTION_RULE,
  FAIL_CLOSED_TEXT,
  isFailClosedText,
  requirementText,
  revisionInstruction,
} from "../src/contract.js";
import { buildEvidence, evidenceFileName, EVIDENCE_VERSION } from "../src/evidence.js";
import { parseConfig, appliesToAgent, DEFAULTS } from "../src/config.js";

import "./_vocabulary.mjs";

test("the fail-closed line is exactly the accepted wording", () => {
  assert.equal(
    FAIL_CLOSED_TEXT,
    "I couldn't confirm that. I won't guess.",
  );
  assert.equal(isFailClosedText(`  ${FAIL_CLOSED_TEXT}  `), true);
  assert.equal(isFailClosedText("I couldn't verify that cleanly."), false);
});

test("the correction rule discards dependent claims", () => {
  assert.match(CORRECTION_RULE, /discard the rejected claim/);
  assert.match(CORRECTION_RULE, /depended on it/);
  assert.match(CORRECTION_RULE, /Re-verify/);
});

test("requirement text names the right tool and stays short", () => {
  assert.match(requirementText("web"), /web_search/);
  assert.match(requirementText("memory"), /memory_search or wiki_search/);
  assert.match(requirementText("web"), /State only facts the usable result supports/);
  assert.match(requirementText("web"), /Do not add recalled background/);
  assert.equal(requirementText(null), "");
  // Every grounded turn pays for this text; keep it well under a paragraph.
  assert.ok(requirementText("web").length < 320, "web requirement stays compact");
  assert.ok(requirementText("memory").length < 320, "memory requirement stays compact");
});

test("revision instruction is bounded and repeats the fail-closed line", () => {
  assert.match(revisionInstruction("web"), /web_search/);
  assert.match(revisionInstruction("memory"), /memory_search or wiki_search/);
  assert.match(revisionInstruction("web"), /State only facts the usable result supports/);
  assert.ok(revisionInstruction("web").includes(FAIL_CLOSED_TEXT));
});

test("evidence records are secret-free and shaped as documented", () => {
  const record = buildEvidence(
    {
      kind: "web",
      correction: false,
      verified: true,
      toolCalls: 2,
      toolFailures: 0,
      satisfiedBy: ["web_search"],
      revisions: 0,
      failClosed: false,
      runId: "run-1",
      sessionKey: "mc-chat-main-1",
    },
    { sessionId: "mc-chat-main-1", agentId: "chat", thinkingLevel: "high", now: 0 },
  );
  assert.equal(record.version, EVIDENCE_VERSION);
  assert.equal(record.grounding, "web");
  assert.equal(record.groundingVerified, true);
  assert.equal(record.thinkingLevel, "high");
  assert.deepEqual(Object.keys(record).sort(), [
    "agentId", "correction", "fact", "failClosed", "grounding", "groundingVerified",
    "revisions", "runId", "satisfiedBy", "sessionId", "thinkingLevel",
    "toolCalls", "toolFailures", "turnNonce", "updatedAt", "version",
  ]);
});

test("the fact block records codes and counts, never fact content", () => {
  const record = buildEvidence(
    {
      kind: null,
      factEligible: true,
      factKind: "correct",
      factReason: "contextual-correction",
      factCalls: 1,
      caseAudits: 1,
      factRevisions: 0,
      factOutcome: {
        ok: true,
        code: "committed",
        factKey: "operator.vehicle.car.chassis",
        revision: 2,
        needsRematerialization: false,
        // Deliberately present on the in-memory outcome and deliberately
        // absent from the record: the evidence artifact is read by Mission
        // Control, and personal fact values do not belong in it.
        message: "revision 2 committed",
        attribution: { provider: "deepseek", model: "deepseek-v4-pro", agentId: "case" },
      },
      satisfiedBy: [],
    },
    { sessionId: "s", now: 0 },
  );
  assert.deepEqual(Object.keys(record.fact.outcome).sort(), [
    "caseAgentId", "caseModel", "code", "factKey", "needsRematerialization", "ok", "revision",
  ]);
  assert.equal(record.fact.outcome.caseModel, "deepseek-v4-pro");
  const serialized = JSON.stringify(record);
  assert.doesNotMatch(serialized, /TC20|revision 2 committed/, "no fact values or prose");
});

test("the per-turn nonce reaches the evidence record", () => {
  const record = buildEvidence(
    { kind: "web", verified: true, turnNonce: "a1b2c3d4", runId: "r1", satisfiedBy: [] },
    { sessionId: "mc-chat-main-1", now: 0 },
  );
  assert.equal(record.turnNonce, "a1b2c3d4");
  // A native-channel turn has no marker, so the console can never accept it.
  assert.equal(buildEvidence({ kind: "web", verified: true }, { sessionId: "s" }).turnNonce, null);
});

test("missing state produces unverified evidence", () => {
  const record = buildEvidence(null, { sessionId: "s" });
  assert.equal(record.groundingVerified, false);
  assert.equal(record.grounding, null);
});

test("evidence filenames cannot escape the evidence directory", () => {
  assert.equal(evidenceFileName("../../etc/passwd"), "etc-passwd.json");
  assert.equal(evidenceFileName("mc-chat-main-20260724-1"), "mc-chat-main-20260724-1.json");
  assert.equal(evidenceFileName(""), "");
  assert.equal(evidenceFileName("/"), "");
});

test("config parsing is strict and defaults are sane", () => {
  assert.deepEqual(parseConfig(undefined).data, DEFAULTS);
  assert.equal(parseConfig({ nope: 1 }).success, false);
  assert.equal(parseConfig({ maxRevisions: 5 }).success, false);
  assert.equal(parseConfig({ stateTtlSeconds: 10 }).success, false);
  assert.equal(parseConfig({ maxRevisions: 1 }).data.maxRevisions, 1);
  assert.equal(DEFAULTS.maxRevisions, 1, "one bounded revision, per the package");
});

test("empty enabledAgents means every agent", () => {
  assert.equal(appliesToAgent({ enabledAgents: [] }, "anything"), true);
  assert.equal(appliesToAgent({ enabledAgents: ["main"] }, "Atlas"), false);
  assert.equal(appliesToAgent(DEFAULTS, "chat"), true);
});
