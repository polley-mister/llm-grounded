// The fail-closed sentence is not a control channel.
//
// Observed in production: a turn that owed no evidence produced
// "I couldn't confirm that. I won't guess." verbatim. The phrase was absent
// from its system prompt and from every tool result — the model simply wrote
// it. The plugin compared the draft against its own fixed string, concluded the
// turn had failed closed, and recorded a grounding failure that never happened.
//
// A fixed string is a fragile signal, and the metric it corrupted is the one
// this package exists to produce. The comparison now only applies where the
// turn actually owed evidence.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createPlugin } from "../src/index.js";
import { FAIL_CLOSED_TEXT } from "../src/contract.js";

import "./_vocabulary.mjs";

function contexts(o = {}) {
  return {
    runId: "run-1", sessionKey: "agent:chat:main", sessionId: "sess-1",
    agentId: "chat", senderIsOwner: true, pluginConfig: {}, ...o,
  };
}

function plugin() {
  const turns = [];
  const p = createPlugin({
    now: () => 1000,
    writeEvidence: async () => null,
    pruneEvidence: async () => 0,
    writeTurn: async (_d, r) => { turns.push(r); return null; },
    pruneTurns: async () => 0,
  });
  p.__turns = turns;
  return p;
}

const CONVERSATIONAL = {
  prompt: "[user-message:abc123]\nWhat colour is my test widget?\n[/user-message:abc123]",
  messages: [],
};

test("a coincidental match on a turn that owed nothing is not a failure", async () => {
  const p = plugin();
  const ctx = contexts();
  await p.handlers.before_prompt_build(CONVERSATIONAL, ctx);

  const entry = p.__store.get({ runId: "run-1" });
  assert.equal(entry.kind, null, "advisory routing owes nothing here");

  const event = { runId: "run-1", sessionId: "sess-1", stopHookActive: false,
                  lastAssistantMessage: FAIL_CLOSED_TEXT };
  assert.equal(await p.handlers.before_agent_finalize(event, ctx), undefined);

  const decision = p.__store.get({ runId: "run-1" }).delivery;
  assert.equal(decision.action, "pass", "the model's words are not a control signal");
  assert.notEqual(decision.responsePolicy, "grounding_fail_closed");

  await p.handlers.agent_end({ runId: "run-1", sessionId: "sess-1" }, ctx);
  assert.equal(p.__turns[0].gates.failedClosed, false, "no grounding failure is recorded");
});

test("the same sentence on a turn that did owe evidence is still a failure", async () => {
  // The requirement text asks the model to emit this line itself, so where an
  // obligation exists the comparison is exactly right and must keep working.
  const p = plugin();
  const ctx = contexts();
  await p.handlers.before_prompt_build(
    { prompt: "[user-message:abc123]\nSearch the web for the tide times.\n[/user-message:abc123]", messages: [] },
    ctx,
  );
  const entry = p.__store.get({ runId: "run-1" });
  assert.equal(entry.kind, "web", "an explicit request creates an obligation");

  const event = { runId: "run-1", sessionId: "sess-1", stopHookActive: false,
                  lastAssistantMessage: FAIL_CLOSED_TEXT };
  const result = await p.handlers.before_agent_finalize(event, ctx);
  assert.equal(result, undefined, "the model already complied; do not ask again");

  await p.handlers.agent_end({ runId: "run-1", sessionId: "sess-1" }, ctx);
  assert.equal(p.__turns[0].gates.failedClosed, true);
});

test("an unmet obligation still fails closed without the model's help", async () => {
  const p = plugin();
  const ctx = contexts();
  await p.handlers.before_prompt_build(
    { prompt: "[user-message:abc123]\nSearch the web for the tide times.\n[/user-message:abc123]", messages: [] },
    ctx,
  );
  const event = { runId: "run-1", sessionId: "sess-1", stopHookActive: false,
                  lastAssistantMessage: "High tide is around 4pm." };
  assert.equal((await p.handlers.before_agent_finalize(event, ctx)).action, "revise");
  assert.equal(await p.handlers.before_agent_finalize(event, ctx), undefined);

  const decision = p.__store.get({ runId: "run-1" }).delivery;
  assert.equal(decision.action, "replace");
  assert.equal(decision.text, FAIL_CLOSED_TEXT);
});
