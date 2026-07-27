// Terminal observation: what a lane actually saw, versus what the plugin did.
//
// The first post-cutover record could not distinguish three things: text a host
// lane really saw, text merely resolved internally at agent_end, and text the
// plugin changed. `emissionObserved` was true only when the plugin substituted
// something, so it read false for every ordinary turn — which is nearly all of
// them, and exactly the population the false-positive rate is computed over.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createPlugin } from "../src/index.js";
import { selectTerminalObservation } from "../src/delivery.js";

import "./_vocabulary.mjs";

const FACTS_CONFIG = {
  factsEnabled: true,
  factsAgents: ["main", "chat"],
  vaultPath: "/tmp/vault",
  factsCliPath: "/tmp/vault_fact_commit.py",
};

function contexts(o = {}) {
  return {
    runId: "run-1", sessionKey: "agent:chat:main", sessionId: "sess-1",
    agentId: "chat", senderIsOwner: true, pluginConfig: FACTS_CONFIG, ...o,
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

const ORDINARY = {
  prompt: "[user-message:abc123]\nGood one.\n[/user-message:abc123]",
  messages: [{ role: "assistant", content: [{ type: "text", text: "…so the backup restored itself." }] }],
};
const REPLY = "Appreciated.";
const FINALIZE = { runId: "run-1", sessionId: "sess-1", stopHookActive: false, lastAssistantMessage: REPLY };
const draft = (text = REPLY) => ({ role: "assistant", content: [{ type: "text", text }] });

async function ordinaryTurn(p, ctx) {
  await p.handlers.before_prompt_build(ORDINARY, ctx);
  await p.handlers.before_agent_finalize(FINALIZE, ctx);
}

// ---------------------------------------------------------------------------
// 1. pass + deliver:false
// ---------------------------------------------------------------------------

test("pass on deliver:false is observed through the transcript", async () => {
  const p = plugin();
  const ctx = contexts();
  await ordinaryTurn(p, ctx);

  const written = p.handlers.before_message_write(
    { message: draft(), sessionKey: ctx.sessionKey, agentId: ctx.agentId }, ctx,
  );
  assert.equal(written, undefined, "an ordinary reply is not rewritten");

  await p.handlers.agent_end({ runId: "run-1", sessionId: "sess-1" }, ctx);
  const r = p.__turns[0];
  assert.equal(r.emissionObserved, true, "the transcript lane saw it");
  assert.equal(r.emittedLane, "transcript");
  assert.equal(r.externalDeliveryObserved, false, "nothing went outbound");
  assert.equal(r.deliveryAction, "pass");
  assert.equal(r.textMutatedByPlugin, false);
  assert.equal(r.final, REPLY, "final is the transcript text");
});

// ---------------------------------------------------------------------------
// 2. pass + normal delivery
// ---------------------------------------------------------------------------

test("pass on a delivered turn is observed outbound", async () => {
  const p = plugin();
  const ctx = contexts();
  await ordinaryTurn(p, ctx);

  p.handlers.before_message_write({ message: draft(), sessionKey: ctx.sessionKey, agentId: ctx.agentId }, ctx);
  assert.equal(p.handlers.reply_payload_sending({ payload: { text: REPLY } }, ctx), undefined);
  assert.equal(p.handlers.message_sending({ content: REPLY }, ctx), undefined);

  await p.handlers.agent_end({ runId: "run-1", sessionId: "sess-1" }, ctx);
  const r = p.__turns[0];
  assert.equal(r.emissionObserved, true);
  assert.equal(r.externalDeliveryObserved, true);
  assert.equal(r.textMutatedByPlugin, false);
  assert.equal(r.emittedLane, "message", "the outbound lane is the most authoritative");
  assert.equal(r.terminalTextMismatch, false);
});

// ---------------------------------------------------------------------------
// 3. the plugin changed the text
// ---------------------------------------------------------------------------

test("a mutated turn is marked as mutated and final is the lane's text", async () => {
  const p = plugin();
  const ctx = contexts();
  await p.handlers.before_prompt_build(
    { prompt: "[user-message:abc123]\nIt's an TC20.\n[/user-message:abc123]",
      messages: [{ role: "assistant", content: [{ type: "text", text: "the car is an TC10." }] }] }, ctx,
  );
  p.handlers.after_tool_call(
    { toolName: "wiki_search", params: { query: "the car" }, result: { content: [{ type: "text", text: "TC10." }] } }, ctx,
  );
  const entry = p.__store.get({ runId: "run-1" });
  entry.factCalls = 1;
  entry.factOutcome = { ok: false, code: "concurrent-write" };
  entry.factProposal = { operation: "correct", subject: "CAR", property: "chassis code", newValue: "TC20", previousValue: "TC10" };

  await p.handlers.before_agent_finalize({ ...FINALIZE, lastAssistantMessage: "Correct. TC20, not TC10." }, ctx);
  const shipped = p.handlers.message_sending({ content: "Correct. TC20, not TC10." }, ctx).content;

  await p.handlers.agent_end({ runId: "run-1", sessionId: "sess-1" }, ctx);
  const r = p.__turns[0];
  assert.equal(r.textMutatedByPlugin, true);
  assert.equal(r.deliveryAction, "annotate");
  assert.equal(r.final, shipped, "final is what the lane emitted, not the draft");
  assert.match(r.final, /failed/i);
});

// ---------------------------------------------------------------------------
// 4. several lanes, one record, identical text
// ---------------------------------------------------------------------------

test("every lane observes byte-identical text and one record is written", async () => {
  const p = plugin();
  const ctx = contexts();
  await ordinaryTurn(p, ctx);

  p.handlers.before_message_write({ message: draft(), sessionKey: ctx.sessionKey, agentId: ctx.agentId }, ctx);
  p.handlers.reply_payload_sending({ payload: { text: REPLY } }, ctx);
  p.handlers.reply_payload_sending({ payload: { text: REPLY } }, ctx);   // multi-chunk
  p.handlers.message_sending({ content: REPLY }, ctx);

  await p.handlers.agent_end({ runId: "run-1", sessionId: "sess-1" }, ctx);
  assert.equal(p.__turns.length, 1, "exactly one terminal record");
  const r = p.__turns[0];
  assert.equal(r.terminalTextMismatch, false);
  assert.deepEqual(r.observedLanes, ["transcript", "payload", "message"]);
});

test("a text mismatch between lanes is recorded, not silently resolved", () => {
  // Centralised delivery promises identical text everywhere. If that promise
  // ever breaks, the record has to say so rather than picking a winner.
  const sel = selectTerminalObservation(
    [
      { lane: "transcript", text: "one", external: false },
      { lane: "message", text: "two", external: true },
    ],
    { action: "pass" },
  );
  assert.equal(sel.terminalTextMismatch, true);
  assert.equal(sel.emittedLane, "message");
});

// ---------------------------------------------------------------------------
// 5. no lane at all
// ---------------------------------------------------------------------------

test("agent_end with no terminal lane does not claim the text shipped", async () => {
  const p = plugin();
  const ctx = contexts();
  await ordinaryTurn(p, ctx);
  await p.handlers.agent_end({ runId: "run-1", sessionId: "sess-1" }, ctx);

  const r = p.__turns[0];
  assert.equal(r.emissionObserved, false);
  assert.equal(r.emittedLane, null);
  assert.equal(r.externalDeliveryObserved, false);
  assert.deepEqual(r.observedLanes, []);
  assert.ok(r.final, "the resolved fallback is still recorded");
});

test("a byte-identical substitution is not a mutation", () => {
  // The plugin selects "replace" when the model emits the fail-closed sentence
  // itself, and substitutes the same string. Counting that as a mutation
  // inflates the rate with turns where nothing changed.
  const same = selectTerminalObservation(
    [{ lane: "transcript", text: "I couldnt confirm that. I wont guess.", external: false }],
    { action: "replace", originalDraft: "I couldnt confirm that. I wont guess." },
  );
  assert.equal(same.deliveryAction, "replace");
  assert.equal(same.textMutatedByPlugin, false);

  const changed = selectTerminalObservation(
    [{ lane: "message", text: "Correct. TC20. The vault update failed.", external: true }],
    { action: "annotate", originalDraft: "Correct. TC20." },
  );
  assert.equal(changed.textMutatedByPlugin, true);
});

test("the fallback is explicitly unobserved", () => {
  const sel = selectTerminalObservation([], { action: "pass", fallbackText: "x" });
  assert.equal(sel.emissionObserved, false);
  assert.equal(sel.final, "x");
});
