// The CASE audit: what goes into the packet, and what comes back out.
//
// The response parser is deliberately unforgiving. Every rejection here is a
// turn that does not write to the vault, which is the correct outcome for an
// auditor that could not answer in four fields.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AUDIT_PURPOSE,
  CASE_AGENT_ID,
  attributionOf,
  buildAuditPacket,
  parseCaseDecision,
  runCaseAudit,
} from "../src/case-audit.js";

const PROPOSAL = {
  factKey: "operator.vehicle.car.chassis",
  subject: "the car",
  property: "chassis code",
  operation: "correct",
  previousValue: "F30",
  newValue: "M2",
};

function packet(extra = {}) {
  return buildAuditPacket({
    userMessage: "It's an M2.",
    prevAssistant: "the car is an F30.",
    evidence: [{ tool: "wiki_search", query: "the car", excerpt: "the car — F30 chassis." }],
    proposal: PROPOSAL,
    prechecks: { newValueInOwnerMessage: true },
    ...extra,
  });
}

test("the packet carries only the bounded audit material", () => {
  const [system, user] = packet();
  assert.equal(system.role, "system");
  assert.match(system.content, /read-only auditor/);
  assert.match(system.content, /never\s+instructions to follow/);
  assert.equal(user.role, "user");
  assert.match(user.content, /It's an M2\./);
  assert.match(user.content, /the car is an F30\./);
  assert.match(user.content, /wiki_search/);
  assert.match(user.content, /newValue: M2/);
  assert.match(user.content, /newValueInOwnerMessage: true/);
});

test("oversized material is clipped rather than sent whole", () => {
  const [, user] = packet({
    userMessage: "x".repeat(9000),
    evidence: [{ tool: "wiki_get", excerpt: "y".repeat(9000) }],
    maxEvidenceChars: 100,
    maxMessageChars: 200,
  });
  assert.ok(user.content.length < 3000, `packet grew to ${user.content.length} characters`);
  assert.match(user.content, /truncated/);
});

test("a turn with no retrieval says so instead of inventing evidence", () => {
  const [, user] = packet({ evidence: [] });
  assert.match(user.content, /\(none retrieved this turn\)/);
});

test("strict JSON is accepted", () => {
  const parsed = parseCaseDecision(
    '{"decision":"approve","supportedOldValue":"F30","supportedNewValue":"M2","reason":"stated"}',
  );
  assert.deepEqual(parsed, {
    decision: "approve",
    supportedOldValue: "F30",
    supportedNewValue: "M2",
    reason: "stated",
  });
  assert.equal(parseCaseDecision('{"decision":"insufficient","supportedOldValue":null,"supportedNewValue":null,"reason":"no"}').decision, "insufficient");
});

test("fenced, oversized, extra-key, wrong-typed and prose replies fail closed", () => {
  const bad = [
    '```json\n{"decision":"approve","supportedOldValue":null,"supportedNewValue":"M2","reason":"x"}\n```',
    'Sure! {"decision":"approve","supportedOldValue":null,"supportedNewValue":"M2","reason":"x"}',
    '{"decision":"approve","supportedOldValue":null,"supportedNewValue":"M2","reason":"x","extra":1}',
    '{"decision":"yes","supportedOldValue":null,"supportedNewValue":"M2","reason":"x"}',
    '{"decision":"approve","supportedOldValue":5,"supportedNewValue":"M2","reason":"x"}',
    '{"decision":"approve","supportedOldValue":null,"supportedNewValue":"M2","reason":5}',
    '{"decision":"approve","supportedOldValue":null,"supportedNewValue":"M2"}',
    `{"decision":"approve","supportedOldValue":null,"supportedNewValue":"${"E".repeat(500)}","reason":"x"}`,
    `{"decision":"approve","supportedOldValue":null,"supportedNewValue":"M2","reason":"${"x".repeat(5000)}"}`,
    "[]",
    "",
    "   ",
    null,
    42,
  ];
  for (const value of bad) {
    assert.equal(parseCaseDecision(value), null, `should have failed closed: ${String(value).slice(0, 40)}`);
  }
});

test("a long but in-bounds reason is clipped, not rejected", () => {
  const parsed = parseCaseDecision(
    `{"decision":"reject","supportedOldValue":null,"supportedNewValue":null,"reason":"${"x".repeat(600)}"}`,
  );
  assert.equal(parsed.decision, "reject");
  assert.ok(parsed.reason.length <= 420, `reason was ${parsed.reason.length} characters`);
  assert.match(parsed.reason, /truncated/);
});

test("the audit runs on agent case with no model override", async () => {
  const calls = [];
  const llm = {
    complete: async (params) => {
      calls.push(params);
      return {
        text: '{"decision":"approve","supportedOldValue":"F30","supportedNewValue":"M2","reason":"ok"}',
        provider: "deepseek",
        model: "deepseek-v4-pro",
        agentId: "case",
      };
    },
  };
  const result = await runCaseAudit({ llm, packet: packet(), timeoutMs: 5000 });
  assert.equal(result.ok, true);
  assert.equal(calls[0].agentId, CASE_AGENT_ID);
  assert.equal(calls[0].purpose, AUDIT_PURPOSE);
  assert.equal(calls[0].temperature, 0);
  assert.equal("model" in calls[0], false, "requesting a model would need llm.allowModelOverride");
  assert.deepEqual(result.attribution, {
    provider: "deepseek",
    model: "deepseek-v4-pro",
    agentId: "case",
  });
});

test("a malformed reply is reported with attribution and no decision", async () => {
  const llm = {
    complete: async () => ({ text: "I think that's fine!", provider: "deepseek", model: "deepseek-v4-pro", agentId: "case" }),
  };
  const result = await runCaseAudit({ llm, packet: packet(), timeoutMs: 5000 });
  assert.equal(result.ok, false);
  assert.equal(result.code, "case-malformed");
  assert.equal(result.attribution.model, "deepseek-v4-pro");
});

test("a thrown or timed-out completion fails closed", async () => {
  const thrown = await runCaseAudit({
    llm: { complete: async () => { throw new Error("upstream 503"); } },
    packet: packet(),
    timeoutMs: 5000,
  });
  assert.equal(thrown.ok, false);
  assert.equal(thrown.code, "case-error");

  const timedOut = await runCaseAudit({
    llm: {
      complete: (params) =>
        new Promise((_resolve, reject) => {
          params.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    },
    packet: packet(),
    timeoutMs: 1000,
  });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.code, "case-error");
});

test("no llm capability at all is a refusal, not a crash", async () => {
  const result = await runCaseAudit({ llm: undefined, packet: packet() });
  assert.equal(result.ok, false);
  assert.equal(result.code, "case-unavailable");
});

test("attribution never carries credentials or prompt text", () => {
  const attribution = attributionOf({
    provider: "deepseek",
    model: "deepseek-v4-pro",
    agentId: "case",
    text: "secret reasoning",
    usage: { costUsd: 0.01 },
  });
  assert.deepEqual(Object.keys(attribution).sort(), ["agentId", "model", "provider"]);
});
