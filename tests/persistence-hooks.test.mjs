// Integration: the persistence note and session overlay across every terminal
// delivery lane.
//
// The unit tests in delivery.test.mjs prove the decision is right. These prove
// the four lanes render that one decision and cannot diverge from each other —
// which is the failure mode that motivated centralising it, and the one no
// amount of per-lane testing would have caught.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createPlugin } from "../src/index.js";
import { FACT_FAIL_CLOSED_TEXT, FAIL_CLOSED_TEXT } from "../src/contract.js";
import { createSessionOverlay } from "../src/session-overlay.js";
import { overlayText } from "../src/facts-overlay.js";

import "./_vocabulary.mjs";

const FACTS_CONFIG = {
  factsEnabled: true,
  factsAgents: ["main", "chat"],
  vaultPath: "/tmp/vault",
  factsCliPath: "/tmp/vault_fact_commit.py",
};

function contexts(overrides = {}) {
  return {
    runId: "run-1",
    sessionKey: "agent:chat:main",
    sessionId: "sess-1",
    agentId: "chat",
    senderIsOwner: true,
    pluginConfig: FACTS_CONFIG,
    ...overrides,
  };
}

/** Captured telemetry records, so "exactly one" is assertable. */
function plugin({ sessionOverlay } = {}) {
  const turns = [];
  const p = createPlugin({
    now: () => 1000,
    writeEvidence: async () => null,
    pruneEvidence: async () => 0,
    writeTurn: async (_dir, record) => { turns.push(record); return null; },
    pruneTurns: async () => 0,
    sessionOverlay,
  });
  p.__turns = turns;
  return p;
}

const CORRECTION_TURN = {
  prompt: "[user-message:abc123]\nIt's an M2.\n[/user-message:abc123]",
  messages: [
    { role: "user", content: "What is the car?" },
    { role: "assistant", content: [{ type: "text", text: "the car is your 330i — an F30 chassis." }] },
  ],
};

const FINALIZE = {
  runId: "run-1",
  sessionId: "sess-1",
  stopHookActive: false,
  lastAssistantMessage: "Correct. An M2, not an F30.",
};

const PROPOSAL = {
  factKey: "operator.vehicle.car.chassis",
  subject: "CAR",
  property: "chassis code",
  operation: "correct",
  newValue: "M2",
  previousValue: "F30",
};

/** Clear the grounding gate so the fact path is what is under test. */
function ground(p, ctx) {
  p.handlers.after_tool_call(
    { toolName: "wiki_search", params: { query: "the car" }, result: { content: [{ type: "text", text: "the car — F30." }] } },
    ctx,
  );
}

async function settle(p, ctx, { outcome, calls = 1, proposal = PROPOSAL } = {}) {
  await p.handlers.before_prompt_build(CORRECTION_TURN, ctx);
  ground(p, ctx);
  const entry = p.__store.get({ runId: ctx.runId });
  entry.factCalls = calls;
  entry.factProposal = proposal;
  if (outcome !== undefined) entry.factOutcome = outcome;
  return entry;
}

const FAILED = { ok: false, code: "concurrent-write" };
const COMMITTED = { ok: true, code: "committed", factKey: PROPOSAL.factKey, revision: 2 };

// ---------------------------------------------------------------------------
// 1, 12 — the two outcomes
// ---------------------------------------------------------------------------

test("a successful commit preserves the answer and says nothing about storage", async () => {
  const p = plugin();
  const ctx = contexts();
  await settle(p, ctx, { outcome: COMMITTED });

  assert.equal(await p.handlers.before_agent_finalize(FINALIZE, ctx), undefined);
  assert.equal(p.handlers.message_sending({}, ctx), undefined, "nothing is substituted");
  assert.equal(p.handlers.reply_payload_sending({ payload: { text: "ok" } }, ctx), undefined);
});

test("a failed commit preserves the answer and appends the note", async () => {
  const p = plugin();
  const ctx = contexts();
  await settle(p, ctx, { outcome: FAILED });
  await p.handlers.before_agent_finalize(FINALIZE, ctx);

  const delivered = p.handlers.message_sending({}, ctx);
  assert.match(delivered.content, /An M2, not an F30/, "the answer survives");
  assert.match(delivered.content, /failed/i, "the failure is disclosed");
  assert.notEqual(delivered.content, FACT_FAIL_CLOSED_TEXT);
});

test("a first-time fact statement behaves the same as a correction", async () => {
  const p = plugin();
  const ctx = contexts();
  const entry = await settle(p, ctx, {
    outcome: FAILED,
    proposal: { ...PROPOSAL, operation: "set", previousValue: "" },
  });
  entry.factKind = "state";
  await p.handlers.before_agent_finalize(FINALIZE, ctx);

  const delivered = p.handlers.message_sending({}, ctx);
  assert.match(delivered.content, /An M2, not an F30/);
  assert.match(delivered.content, /have not stored/i);
  assert.notEqual(delivered.content, FACT_FAIL_CLOSED_TEXT);
});

// ---------------------------------------------------------------------------
// 3, 14 — the lanes cannot diverge
// ---------------------------------------------------------------------------

test("every lane renders byte-identical terminal text", async () => {
  const p = plugin();
  const ctx = contexts();
  await settle(p, ctx, { outcome: FAILED });
  await p.handlers.before_agent_finalize(FINALIZE, ctx);

  const draft = { role: "assistant", content: [{ type: "text", text: FINALIZE.lastAssistantMessage }] };
  const transcript = p.handlers.before_message_write(
    { message: draft, sessionKey: ctx.sessionKey, agentId: ctx.agentId }, ctx,
  );
  const payload = p.handlers.reply_payload_sending({ payload: { text: "x" } }, ctx);
  const message = p.handlers.message_sending({}, ctx);

  assert.equal(transcript.message.content[0].text, payload.payload.text);
  assert.equal(payload.payload.text, message.content);
});

test("running every lane in sequence produces exactly one note", async () => {
  // The real shape of a turn: the transcript is written, then the payload is
  // normalised, then the message is sent. Each renders one precomputed string,
  // so the note cannot accumulate.
  const p = plugin();
  const ctx = contexts();
  await settle(p, ctx, { outcome: FAILED });
  await p.handlers.before_agent_finalize(FINALIZE, ctx);

  const draft = { role: "assistant", content: [{ type: "text", text: FINALIZE.lastAssistantMessage }] };
  const texts = [
    p.handlers.before_message_write({ message: draft, sessionKey: ctx.sessionKey, agentId: ctx.agentId }, ctx)
      .message.content[0].text,
    p.handlers.reply_payload_sending({ payload: { text: "x" } }, ctx).payload.text,
    p.handlers.message_sending({}, ctx).content,
  ];
  for (const text of texts) {
    const occurrences = text.split(/vault update failed|durable record update failed/).length - 1;
    assert.equal(occurrences, 1, `note appears ${occurrences} times in: ${text}`);
  }
});

// ---------------------------------------------------------------------------
// 4 — deliver:false
// ---------------------------------------------------------------------------

test("deliver:false gets the note through the transcript", async () => {
  // There is no payload hook on this transport, so before_message_write is the
  // terminal lane and must carry exactly what ships.
  const p = plugin();
  const ctx = contexts();
  await settle(p, ctx, { outcome: FAILED });

  const draft = {
    role: "assistant",
    content: [{ type: "thinking", thinking: "internal" }, { type: "text", text: FINALIZE.lastAssistantMessage }],
  };
  const written = p.handlers.before_message_write(
    { message: draft, sessionKey: ctx.sessionKey, agentId: ctx.agentId }, ctx,
  );
  assert.equal(written.block, undefined);
  assert.equal(written.message.content.length, 1, "reasoning traces are dropped");
  assert.match(written.message.content[0].text, /An M2, not an F30/);
  assert.match(written.message.content[0].text, /failed/i);
});

// ---------------------------------------------------------------------------
// 5, 6, 13 — a draft that claims the write succeeded
// ---------------------------------------------------------------------------

const CLAIMING = { ...FINALIZE, lastAssistantMessage: "Got it, I've saved that: an M2." };

test("a contradictory draft gets one bounded repair, not a rewrite", async () => {
  const p = plugin();
  const ctx = contexts();
  await settle(p, ctx, { outcome: FAILED });

  const result = await p.handlers.before_agent_finalize(CLAIMING, ctx);
  assert.equal(result.action, "revise");
  assert.match(result.retry.idempotencyKey, /^llm-grounded-persistence:/);
  assert.match(result.reason, /was not/i);
  assert.equal(p.__store.get({ runId: "run-1" }).persistenceClaimRevisions, 1);
  // Nothing is delivered yet, and nothing has been string-replaced.
  assert.equal(p.handlers.message_sending({}, ctx), undefined);
});

test("a still-contradictory draft is rebuilt from structured data", async () => {
  const p = plugin();
  const ctx = contexts();
  await settle(p, ctx, { outcome: FAILED });

  await p.handlers.before_agent_finalize(CLAIMING, ctx);
  const second = await p.handlers.before_agent_finalize(CLAIMING, ctx);
  assert.equal(second, undefined, "the budget is spent; no second repair");

  const delivered = p.handlers.message_sending({}, ctx);
  assert.match(delivered.content, /^Correct\. M2, not F30\./, "rebuilt from the proposal");
  assert.doesNotMatch(delivered.content, /saved/i, "neither contradictory draft ships");
  assert.equal(delivered.metadata.llmGrounded.responsePolicy, "truthful_persistence_fallback");
});

test("a contradictory draft with no captured proposal falls back to the fixed sentence", async () => {
  const p = plugin();
  const ctx = contexts();
  await settle(p, ctx, { outcome: FAILED, calls: 0, proposal: null });

  // The tool was never called, so the first pass is the nudge to call it.
  assert.equal((await p.handlers.before_agent_finalize(CLAIMING, ctx)).action, "revise");
  // Then the bounded persistence repair.
  assert.equal((await p.handlers.before_agent_finalize(CLAIMING, ctx)).action, "revise");
  // Still claiming, budget spent, and no proposal to rebuild from.
  assert.equal(await p.handlers.before_agent_finalize(CLAIMING, ctx), undefined);
  assert.equal(p.handlers.message_sending({}, ctx).content, FACT_FAIL_CLOSED_TEXT);
});

// ---------------------------------------------------------------------------
// 7, 8 — corrections that are not user-owned facts
// ---------------------------------------------------------------------------

test("an ambiguous correction is not annotated and not failed closed", async () => {
  const p = plugin();
  const ctx = contexts();
  await p.handlers.before_prompt_build(
    { prompt: "[user-message:abc123]\nThat's wrong.\n[/user-message:abc123]", messages: CORRECTION_TURN.messages },
    ctx,
  );
  ground(p, ctx);
  const ask = { ...FINALIZE, lastAssistantMessage: "Which part did I get wrong?" };
  // Whatever bounded passes the fact path wants, the turn must never end up
  // annotated with a vault failure: nothing was owed to the vault.
  for (let i = 0; i < 3; i += 1) await p.handlers.before_agent_finalize(ask, ctx);
  const delivered = p.handlers.message_sending({}, ctx);
  const text = delivered?.content ?? ask.lastAssistantMessage;
  assert.doesNotMatch(text, /vault|durable record/i, "no persistence note");
  assert.notEqual(text, FAIL_CLOSED_TEXT, "never a grounding refusal");
});

test("an external-world correction writes nothing and is not annotated", async () => {
  const p = plugin();
  const ctx = contexts();
  await p.handlers.before_prompt_build(
    { prompt: "[user-message:abc123]\nNo, Tenet was released in 2020.\n[/user-message:abc123]", messages: [] },
    ctx,
  );
  ground(p, ctx);
  const reply = { ...FINALIZE, lastAssistantMessage: "You're right, 2020." };
  for (let i = 0; i < 3; i += 1) await p.handlers.before_agent_finalize(reply, ctx);
  const delivered = p.handlers.message_sending({}, ctx);
  const text = delivered?.content ?? reply.lastAssistantMessage;
  // A claim about a film release is not a durable fact about the operator's own
  // world. Nothing was owed to the vault, so nothing failed.
  assert.doesNotMatch(text, /vault|durable record/i);
  assert.equal(
    p.__store.get({ runId: "run-1" }).correctionScope,
    "external_world",
    "the scope is what suppresses the note",
  );
});

// ---------------------------------------------------------------------------
// 9, 15, 16 — the session overlay
// ---------------------------------------------------------------------------

test("a failed commit leaves the correction active for the next turn", async () => {
  // The durable record may stay stale. The conversation may not.
  const overlay = createSessionOverlay();
  overlay.hold({
    sessionKey: "agent:chat:main",
    factKey: PROPOSAL.factKey,
    subject: PROPOSAL.subject,
    property: PROPOSAL.property,
    currentValue: "M2",
    supersededValues: ["F30"],
  });

  const out = overlayText(
    { facts: overlay.snapshot("agent:chat:main").facts },
    "Your stored F30 has the older interior.",
  );
  assert.equal(out.changed, true);
  assert.match(out.text, /M2/);
  assert.match(out.text, /superseded/);
});

test("the stronger wording is used once the overlay is holding the value", async () => {
  const overlay = createSessionOverlay();
  overlay.hold({ sessionKey: "agent:chat:main", factKey: PROPOSAL.factKey, currentValue: "M2" });

  const p = plugin({ sessionOverlay: overlay });
  const ctx = contexts();
  await settle(p, ctx, { outcome: FAILED });
  await p.handlers.before_agent_finalize(FINALIZE, ctx);

  const delivered = p.handlers.message_sending({}, ctx);
  assert.match(delivered.content, /remains active for this conversation only/);
  assert.equal(delivered.metadata.llmGrounded.sessionOverlayApplied, true);
});

test("without an overlay the weaker wording is used", async () => {
  const p = plugin({ sessionOverlay: createSessionOverlay() });
  const ctx = contexts();
  await settle(p, ctx, { outcome: FAILED });
  await p.handlers.before_agent_finalize(FINALIZE, ctx);

  const delivered = p.handlers.message_sending({}, ctx);
  assert.doesNotMatch(delivered.content, /this conversation/);
  assert.match(delivered.content, /have not stored/i);
  assert.equal(delivered.metadata.llmGrounded.sessionOverlayApplied, false);
});

test("one session cannot read another session's held correction", async () => {
  const overlay = createSessionOverlay();
  overlay.hold({ sessionKey: "agent:chat:main", factKey: PROPOSAL.factKey, currentValue: "M2" });
  assert.equal(overlay.active("agent:chat:other"), false);
  assert.deepEqual(overlay.snapshot("agent:chat:other"), { facts: {} });
  // And never under a shared default.
  assert.equal(overlay.active("default"), false);
  assert.equal(overlay.active(""), false);
});

// ---------------------------------------------------------------------------
// 10 — precedence
// ---------------------------------------------------------------------------

test("grounding failure outranks the persistence note", async () => {
  const p = plugin();
  const ctx = contexts();
  await p.handlers.before_prompt_build(CORRECTION_TURN, ctx);
  // A correction alone compels no retrieval under advisory routing, so an
  // obligation is set explicitly here: this test is about precedence between
  // two failures, not about how the grounding one arises.
  const entry = p.__store.get({ runId: "run-1" });
  entry.kind = "web";
  entry.verified = false;
  entry.factCalls = 1;
  entry.factProposal = PROPOSAL;
  entry.factOutcome = FAILED;

  await p.handlers.before_agent_finalize(FINALIZE, ctx);   // spends the grounding revision
  await p.handlers.before_agent_finalize(FINALIZE, ctx);   // latches

  const delivered = p.handlers.message_sending({}, ctx);
  assert.equal(delivered.content, FAIL_CLOSED_TEXT, "grounding wins");
  assert.doesNotMatch(delivered.content, /vault|durable/i, "no note on a withheld answer");
  // ...but the combined case stays visible.
  assert.equal(delivered.metadata.llmGrounded.persistenceOutcome, "failed");
});

// ---------------------------------------------------------------------------
// 11, 17, 18 — terminal telemetry
// ---------------------------------------------------------------------------

test("one terminal record per turn, reporting the lane that emitted it", async () => {
  const p = plugin();
  const ctx = contexts();
  await settle(p, ctx, { outcome: FAILED });
  await p.handlers.before_agent_finalize(FINALIZE, ctx);

  const shipped = p.handlers.message_sending({}, ctx).content;
  p.handlers.reply_payload_sending({ payload: { text: "x" } }, ctx);
  await p.handlers.agent_end({ runId: "run-1", sessionId: "sess-1" }, ctx);

  assert.equal(p.__turns.length, 1, "exactly one terminal record");
  const r = p.__turns[0];
  assert.equal(r.emissionObserved, true);
  assert.equal(r.emittedLane, "message");
  assert.equal(r.final, shipped, "final is the text a lane was seen to emit");
  assert.equal(r.correctionOutcome, "accepted");
  assert.equal(r.persistenceOutcome, "failed");
  assert.equal(r.responsePolicy, "answer_with_persistence_note");
  assert.equal(r.factCommitAttempted, true);
  assert.equal(r.factCommitSucceeded, false);
  assert.equal(r.correctionAppliedToResponse, true);
  assert.equal(r.persistenceFailureNoted, true);
  assert.equal(r.sessionOverlayApplied, false);
  assert.equal(r.persistenceClaimRevisions, 0);
});

test("a run that never delivers is recorded as unobserved rather than lost", async () => {
  const p = plugin();
  const ctx = contexts();
  await settle(p, ctx, { outcome: FAILED });
  await p.handlers.before_agent_finalize(FINALIZE, ctx);
  await p.handlers.agent_end({ runId: "run-1", sessionId: "sess-1" }, ctx);

  assert.equal(p.__turns.length, 1);
  assert.equal(p.__turns[0].emissionObserved, false);
  assert.equal(p.__turns[0].emittedLane, null);
  assert.ok(p.__turns[0].final, "the resolved text is still recorded");
});

test("a successful commit records the committed outcome", async () => {
  const p = plugin();
  const ctx = contexts();
  await settle(p, ctx, { outcome: COMMITTED });
  await p.handlers.before_agent_finalize(FINALIZE, ctx);
  await p.handlers.agent_end({ runId: "run-1", sessionId: "sess-1" }, ctx);

  const r = p.__turns[0];
  assert.equal(r.persistenceOutcome, "committed");
  assert.equal(r.factCommitSucceeded, true);
  assert.equal(r.persistenceFailureNoted, false);
});
