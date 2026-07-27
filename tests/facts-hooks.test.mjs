// Hook wiring for the fact transaction: capture, binding, evidence, exposure,
// and the one bounded finalize nudge.
import { test } from "node:test";
import assert from "node:assert/strict";

import { createPlugin } from "../src/index.js";
import { FACT_TOOL_NAME } from "../src/facts-tool.js";
import { FACT_FAIL_CLOSED_TEXT, FAIL_CLOSED_TEXT } from "../src/contract.js";

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

function plugin() {
  return createPlugin({
    now: () => 1000,
    writeEvidence: async () => null,
    pruneEvidence: async () => 0,
  });
}

const CORRECTION_TURN = {
  prompt: "[user-message:abc123]\nIt's an TC20.\n[/user-message:abc123]",
  messages: [
    { role: "user", content: "What is the car?" },
    { role: "assistant", content: [{ type: "text", text: "the car is your 330i — an TC10 chassis." }] },
  ],
};

test("the turn's exact text, prior answer and fact verdict are captured once", async () => {
  const p = plugin();
  const ctx = contexts();
  await p.handlers.before_prompt_build(CORRECTION_TURN, ctx);
  const entry = p.__store.get({ runId: "run-1" });
  assert.equal(entry.userMessage, "It's an TC20.");
  assert.equal(entry.prevAssistant, "the car is your 330i — an TC10 chassis.");
  assert.equal(entry.factEligible, true);
  assert.equal(entry.factKind, "correct");

  // A rebuilt prompt inside the same run must not reclassify or re-capture.
  await p.handlers.before_prompt_build(
    { prompt: "llm-grounded: Grounding required for this turn: run wiki_search", messages: [] },
    ctx,
  );
  const result = await p.handlers.before_prompt_build(CORRECTION_TURN, ctx);
  assert.match(result.prependSystemContext, /Correction rule/);
  assert.match(result.prependSystemContext, /vault_fact_commit in the same/);
});

test("the fact rule is injected only for agents that have the tool", async () => {
  const p = plugin();
  const withTool = await p.handlers.before_prompt_build(CORRECTION_TURN, contexts());
  assert.match(withTool.prependSystemContext, /vault_fact_commit/);

  const withoutTool = await p.handlers.before_prompt_build(
    CORRECTION_TURN,
    contexts({ runId: "run-2", pluginConfig: { ...FACTS_CONFIG, factsEnabled: false } }),
  );
  assert.doesNotMatch(withoutTool.prependSystemContext, /vault_fact_commit/);
  assert.match(withoutTool.prependSystemContext, /Correction rule/);
});

test("native OpenClaw gets the compact the agent register reminder, while the console keeps its own coda", async () => {
  const p = plugin();
  const native = await p.handlers.before_prompt_build(
    { ...CORRECTION_TURN, prompt: "It's an TC20." },
    contexts(),
  );
  assert.match(native.appendContext, /Reply as the agent, in the voice SOUL\.md defines/);

  const missionControl = await p.handlers.before_prompt_build(CORRECTION_TURN, contexts({ runId: "run-mc" }));
  assert.doesNotMatch(missionControl.appendContext ?? "", /Reply as the agent, in the voice SOUL\.md defines/);
});

test("before_tool_call blocks the fact tool for an agent that must not have it", async () => {
  const p = plugin();
  await p.handlers.before_prompt_build(CORRECTION_TURN, contexts());

  const blocked = p.handlers.before_tool_call(
    { toolName: FACT_TOOL_NAME, toolCallId: "c1" },
    contexts({ agentId: "Atlas" }),
  );
  assert.equal(blocked.block, true);

  const disabled = p.handlers.before_tool_call(
    { toolName: FACT_TOOL_NAME, toolCallId: "c1" },
    contexts({ pluginConfig: { ...FACTS_CONFIG, factsEnabled: false } }),
  );
  assert.equal(disabled.block, true);

  const allowed = p.handlers.before_tool_call(
    { toolName: FACT_TOOL_NAME, toolCallId: "c1" },
    contexts(),
  );
  assert.equal(allowed, undefined);

  const contextOnlyId = p.handlers.before_tool_call(
    { toolName: FACT_TOOL_NAME },
    contexts({ toolCallId: "c2" }),
  );
  assert.equal(contextOnlyId, undefined);
});

test("before_tool_call ignores every other tool", () => {
  const p = plugin();
  assert.equal(p.handlers.before_tool_call({ toolName: "wiki_search" }, contexts()), undefined);
  assert.equal(p.handlers.before_tool_call({ toolName: "write" }, contexts()), undefined);
});

test("an eligible fact turn cannot bypass the transaction through wiki_apply", async () => {
  const p = plugin();
  const ctx = contexts();
  await p.handlers.before_prompt_build(CORRECTION_TURN, ctx);
  const blocked = p.handlers.before_tool_call({ toolName: "wiki_apply" }, ctx);
  assert.equal(blocked.block, true);
  assert.match(blocked.blockReason, /only through vault_fact_commit/);
});

test("registration config governs hooks when runtime omits pluginConfig", async () => {
  const p = plugin();
  p.register({
    pluginConfig: FACTS_CONFIG,
    config: {},
    runtime: { config: { current: () => ({ plugins: { entries: {} } }) } },
    on: () => {},
    registerTool: () => {},
  });
  const ctx = contexts({ pluginConfig: undefined });
  await p.handlers.before_prompt_build(CORRECTION_TURN, ctx);
  const allowed = p.handlers.before_tool_call(
    { toolName: FACT_TOOL_NAME },
    { ...ctx, toolCallId: "registration-config-call" },
  );
  assert.equal(allowed, undefined);
});

test("only successful wiki retrievals become bound evidence", async () => {
  const p = plugin();
  await p.handlers.before_prompt_build(CORRECTION_TURN, contexts());
  const ctx = contexts();

  p.handlers.after_tool_call(
    { toolName: "wiki_search", params: { query: "the car" }, result: { content: [{ type: "text", text: "the car — TC10 chassis." }] } },
    ctx,
  );
  p.handlers.after_tool_call(
    { toolName: "wiki_get", error: "not found", result: { isError: true } },
    ctx,
  );
  p.handlers.after_tool_call(
    { toolName: "web_search", result: { content: [{ type: "text", text: "unrelated" }] } },
    ctx,
  );

  const evidence = p.__store.get({ runId: "run-1" }).wikiEvidence;
  assert.equal(evidence.length, 1, "only the successful wiki retrieval is evidence");
  assert.equal(evidence[0].tool, "wiki_search");
  assert.match(evidence[0].excerpt, /TC10 chassis/);
});

test("evidence excerpts are bounded", async () => {
  const p = plugin();
  const ctx = contexts({ pluginConfig: { ...FACTS_CONFIG, maxEvidenceItems: 1, maxEvidenceChars: 200 } });
  await p.handlers.before_prompt_build(CORRECTION_TURN, ctx);
  for (let i = 0; i < 5; i++) {
    p.handlers.after_tool_call(
      { toolName: "wiki_search", params: { query: "q" }, result: { content: [{ type: "text", text: "z".repeat(5000) }] } },
      ctx,
    );
  }
  const evidence = p.__store.get({ runId: "run-1" }).wikiEvidence;
  assert.equal(evidence.length, 1, "maxEvidenceItems caps how many are retained");
  assert.ok(evidence[0].excerpt.length <= 201, `excerpt was ${evidence[0].excerpt.length} characters`);
});

test("an unambiguous uncaptured fact turn gets one transaction nudge, then ships annotated", async () => {
  const p = plugin();
  const ctx = contexts();
  await p.handlers.before_prompt_build(CORRECTION_TURN, ctx);
  // Satisfy the grounding gate first: it owns delivery and always runs ahead
  // of the fact nudge. The prior answer is personal, so this correction routes
  // to the memory tier and wiki_search is what clears it.
  p.handlers.after_tool_call(
    { toolName: "wiki_search", params: { query: "the car" }, result: { content: [{ type: "text", text: "the car — TC10." }] } },
    ctx,
  );
  const event = { runId: "run-1", sessionId: "sess-1", stopHookActive: false, lastAssistantMessage: "It's an TC20, noted." };

  const first = await p.handlers.before_agent_finalize(event, ctx);
  assert.equal(first.action, "revise");
  assert.match(first.retry.instruction, /vault_fact_commit/);
  assert.match(first.retry.idempotencyKey, /^llm-grounded-fact:/);

  // The nudge is not repeated. With the budget spent the answer ships, carrying
  // the disclosure that nothing was written.
  const second = await p.handlers.before_agent_finalize(event, ctx);
  assert.equal(second, undefined, "the transaction nudge is not repeated");
  const delivered = p.handlers.message_sending({}, ctx);
  assert.match(delivered.content, /It.s an TC20/);
  assert.match(delivered.content, /have not stored/i);
});

test("an ordinary turn is never nudged", async () => {
  const p = plugin();
  const ctx = contexts();
  await p.handlers.before_prompt_build(
    { prompt: "[user-message:aaa111]\n2 + 2\n[/user-message:aaa111]", messages: [] },
    ctx,
  );
  const result = await p.handlers.before_agent_finalize(
    { runId: "run-1", sessionId: "sess-1", stopHookActive: false, lastAssistantMessage: "4." },
    ctx,
  );
  assert.equal(result, undefined);
});

test("no nudge for an agent without the tool, however eligible the turn", async () => {
  const p = plugin();
  const ctx = contexts({ pluginConfig: { ...FACTS_CONFIG, factsEnabled: false } });
  await p.handlers.before_prompt_build(CORRECTION_TURN, ctx);
  p.handlers.after_tool_call(
    { toolName: "wiki_search", params: { query: "the car" }, result: { content: [{ type: "text", text: "the car — TC10." }] } },
    ctx,
  );
  const result = await p.handlers.before_agent_finalize(
    { runId: "run-1", sessionId: "sess-1", stopHookActive: false, lastAssistantMessage: "ok" },
    ctx,
  );
  assert.equal(result, undefined);
});

test("the correction persistence gate binds without compelling retrieval", async () => {
  const p = plugin();
  const ctx = contexts();
  // Phase 1A. The invariant is "a correction must be resolved before a durable
  // fact is written" — NOT "every correction must run memory_search". the operator is
  // the authoritative source for which car they own, so their assertion is the
  // evidence; a lookup would only locate the record being superseded.
  //
  // So this turn binds the persistence path and nothing else: the fact nudge
  // fires, no retrieval is demanded, and no grounding tier is created.
  await p.handlers.before_prompt_build(CORRECTION_TURN, ctx);
  const result = await p.handlers.before_agent_finalize(
    { runId: "run-1", sessionId: "sess-1", stopHookActive: false, lastAssistantMessage: "Got it." },
    ctx,
  );
  assert.equal(result.action, "revise");
  assert.match(result.reason, /vault_fact_commit/, "the persistence gate is what binds");
  assert.doesNotMatch(
    result.reason,
    /web_search|memory_search/,
    "a correction must not compel retrieval merely to answer",
  );
  assert.equal(
    p.__store.get({ runId: "run-1" })?.kind,
    null,
    "correction is a scope, not a retrieval tier",
  );
});

function factoryFor() {
  const p = plugin();
  const registered = [];
  p.register({ on: () => {}, registerTool: (factory) => registered.push(factory) });
  return registered[0];
}

const FACTORY_BASE = {
  agentId: "chat",
  senderIsOwner: true,
  sessionKey: "agent:chat:main",
  runtimeConfig: {
    plugins: { entries: { "llm-grounded": { config: { ...FACTS_CONFIG, directSessionPrefixes: ["mc-chat"] } } } },
  },
};

test("the tool factory hides the tool from unrelated agents and non-owners", () => {
  const factory = factoryFor();
  assert.equal(factory({ ...FACTORY_BASE }).name, FACT_TOOL_NAME);
  assert.equal(factory({ ...FACTORY_BASE, agentId: "Atlas" }), null);
  assert.equal(factory({ ...FACTORY_BASE, senderIsOwner: false }), null);
  assert.equal(factory({ ...FACTORY_BASE, senderIsOwner: undefined }), null);
  assert.equal(
    factory({ ...FACTORY_BASE, runtimeConfig: { plugins: { entries: {} } } }),
    null,
    "config that cannot be resolved must close the tool, not open it",
  );
});

test("canonical explicit operator session is exposed without operator.admin", () => {
  const factory = factoryFor();
  assert.equal(
    factory({
      ...FACTORY_BASE,
      senderIsOwner: false,
      sessionKey: "agent:chat:explicit:wp2026004-live",
    })?.name,
    FACT_TOOL_NAME,
  );
});

test("the authenticated OpenClaw Control UI exposes the narrow transaction tool", () => {
  const factory = factoryFor();
  assert.equal(
    factory({ ...FACTORY_BASE, senderIsOwner: false, messageProvider: "webchat" })?.name,
    FACT_TOOL_NAME,
  );
  assert.equal(factory({ ...FACTORY_BASE, senderIsOwner: false, messageProvider: "discord" }), null);
});

test("the tool is not even exposed in a group or channel, owner or not", () => {
  const factory = factoryFor();
  // Exposure, not just execution. A tool the model can see in a shared
  // conversation is one it will try to use there, and the refusal would arrive
  // as a visible failure rather than the tool simply not existing.
  const hidden = [
    "agent:chat:discord:acct:group:12345",
    "agent:chat:discord:channel:98765",
    "agent:chat:signal:group:abc",
  ];
  for (const sessionKey of hidden) {
    assert.equal(factory({ ...FACTORY_BASE, sessionKey }), null, sessionKey);
  }
});

test("ambiguous or missing session context hides the tool", () => {
  const factory = factoryFor();
  for (const sessionKey of ["discord:12345", "something-unrecognized", "", undefined]) {
    assert.equal(factory({ ...FACTORY_BASE, sessionKey }), null, String(sessionKey));
  }
});

test("direct, the console and one-shot sessions are exposed", () => {
  const factory = factoryFor();
  const shown = [
    { sessionKey: "agent:chat:main" },
    { sessionKey: "agent:chat:main:default" },
    { sessionKey: "agent:chat:discord:acct:direct:operator" },
    { sessionKey: "agent:chat:explicit:wp2026004-toolcheck" },
    { sessionKey: "mc-chat-main-20260724-1" },
    { sessionKey: "wp2026004-toolcheck", oneShotCliRun: true },
  ];
  for (const ctx of shown) {
    assert.equal(factory({ ...FACTORY_BASE, ...ctx })?.name, FACT_TOOL_NAME, ctx.sessionKey);
  }
});

// --------------------------------------------------------------------------
// Closure batch: an eligible fact turn may not speak normally unless the
// transaction succeeded.
// --------------------------------------------------------------------------

/** Ground the turn so the grounding gate is satisfied and out of the way. */
function ground(p, ctx) {
  p.handlers.after_tool_call(
    { toolName: "wiki_search", params: { query: "the car" }, result: { content: [{ type: "text", text: "the car — TC10." }] } },
    ctx,
  );
}

const FINALIZE = {
  runId: "run-1",
  sessionId: "sess-1",
  stopHookActive: false,
  lastAssistantMessage: "Got it — the car is an TC20. Noted.",
};

async function settle(p, ctx, { outcome, calls = 0 } = {}) {
  await p.handlers.before_prompt_build(CORRECTION_TURN, ctx);
  ground(p, ctx);
  const entry = p.__store.get({ runId: "run-1" });
  entry.factCalls = calls;
  if (outcome !== undefined) entry.factOutcome = outcome;
  return entry;
}

test("a failed transaction ships the answer with a persistence note", async () => {
  const failures = [
    { ok: false, code: "case-unavailable" },
    { ok: false, code: "case-reject" },
    { ok: false, code: "concurrent-write" },
    { ok: false, code: "stale-value" },
    { ok: false, code: "lint-regression" },
  ];
  for (const outcome of failures) {
    const p = plugin();
    const ctx = contexts();
    await settle(p, ctx, { outcome, calls: 1 });

    // No closure pass: the draft is clean, so it is annotated rather than
    // discarded. A failed write does not make the answer false.
    const finalize = await p.handlers.before_agent_finalize(FINALIZE, ctx);
    assert.equal(finalize, undefined, `${outcome.code}: no revision is owed`);

    const delivered = p.handlers.message_sending({}, ctx);
    assert.match(delivered.content, /the car is an TC20/, outcome.code);
    assert.match(delivered.content, /failed/i, outcome.code);
    assert.notEqual(delivered.content, FACT_FAIL_CLOSED_TEXT, outcome.code);
    assert.equal(delivered.metadata.llmGrounded.persistenceOutcome, "failed");
    assert.equal(delivered.metadata.llmGrounded.responsePolicy, "answer_with_persistence_note");
  }
});

test("a turn that never called the tool is nudged once, then annotated", async () => {
  const p = plugin();
  const ctx = contexts();
  await settle(p, ctx, { calls: 0 });

  const first = await p.handlers.before_agent_finalize(FINALIZE, ctx);
  assert.equal(first.action, "revise");

  // The model ignored the nudge. The budget is spent, and the durable record
  // still does not reflect what the operator said, so the answer ships with the
  // disclosure rather than being replaced by it.
  const second = await p.handlers.before_agent_finalize(FINALIZE, ctx);
  assert.equal(second, undefined);
  const delivered = p.handlers.message_sending({}, ctx);
  assert.match(delivered.content, /the car is an TC20/);
  assert.match(delivered.content, /have not stored/i);
  assert.notEqual(delivered.content, FACT_FAIL_CLOSED_TEXT);
});

test("a refusal is not transacted again, and costs no revision", async () => {
  // A refusal is a decision, not a transient failure. Retrying would invite the
  // model to reshape the proposal until something passes.
  const p = plugin();
  const ctx = contexts();
  await settle(p, ctx, { outcome: { ok: false, code: "case-reject" }, calls: 1 });
  const result = await p.handlers.before_agent_finalize(FINALIZE, ctx);
  assert.equal(result, undefined);
  assert.equal(p.__store.get({ runId: "run-1" }).factRevisions, 0);
  assert.equal(p.__store.get({ runId: "run-1" }).persistenceClaimRevisions, 0);
  assert.match(p.handlers.message_sending({}, ctx).content, /failed|not stored/i);
});

test("a successful transaction delivers the model's own reply untouched", async () => {
  const p = plugin();
  const ctx = contexts();
  await settle(p, ctx, {
    outcome: { ok: true, code: "committed", factKey: "operator.vehicle.car.chassis", revision: 2 },
    calls: 1,
  });
  const finalize = await p.handlers.before_agent_finalize(FINALIZE, ctx);
  assert.equal(finalize, undefined);
  assert.equal(p.__store.get({ runId: "run-1" }).factFailClosed, false);
  assert.equal(p.handlers.message_sending({}, ctx), undefined, "nothing is substituted");
  assert.equal(p.handlers.reply_payload_sending({ payload: { text: "ok" } }, ctx), undefined);
});

test("the payload path carries the annotated answer and keeps its rich content", async () => {
  const p = plugin();
  const ctx = contexts();
  await settle(p, ctx, { outcome: { ok: false, code: "case-unavailable" }, calls: 1 });
  await p.handlers.before_agent_finalize(FINALIZE, ctx);

  const first = p.handlers.reply_payload_sending(
    { payload: { text: "Noted!", mediaUrl: "http://x/y.png", presentation: "card" } },
    ctx,
  );
  // An annotated answer is a real answer, so its media survives. Stripping is
  // for a reply that was withheld, not one that was disclosed.
  assert.match(first.payload.text, /the car is an TC20/);
  assert.match(first.payload.text, /failed/i);
  assert.equal(first.payload.mediaUrl, "http://x/y.png");
  assert.equal(first.payload.presentation, "card");

  // One turn can normalize into several payloads; the terminal text belongs on
  // the first only.
  const second = p.handlers.reply_payload_sending({ payload: { text: "Noted!" } }, ctx);
  assert.equal(second.cancel, true);
});

test("a failed memory write never becomes the generic grounding failure", async () => {
  const p = plugin();
  const ctx = contexts();
  // No successful retrieval this time, so grounding fails closed too.
  await p.handlers.before_prompt_build(CORRECTION_TURN, ctx);
  const entry = p.__store.get({ runId: "run-1" });
  entry.factCalls = 1;
  entry.factOutcome = { ok: false, code: "case-reject" };
  entry.revisions = 1; // bounded grounding revision already spent

  await p.handlers.before_agent_finalize(FINALIZE, ctx);
  const delivered = p.handlers.message_sending({}, ctx);
  // The write failed; the conversation did not. Replacing the answer with the
  // generic grounding sentence would report a retrieval failure that never
  // happened — this turn was never bound to a retrieval tier at all.
  assert.notEqual(
    delivered.content,
    FAIL_CLOSED_TEXT,
    "a persistence failure is not a grounding failure",
  );
});

test("an ineligible turn is never latched, whatever else happened", async () => {
  const p = plugin();
  const ctx = contexts();
  await p.handlers.before_prompt_build(
    { prompt: "[user-message:aaa111]\n2 + 2\n[/user-message:aaa111]", messages: [] },
    ctx,
  );
  const result = await p.handlers.before_agent_finalize(
    { runId: "run-1", sessionId: "sess-1", stopHookActive: false, lastAssistantMessage: "4." },
    ctx,
  );
  assert.equal(result, undefined);
  assert.equal(p.__store.get({ runId: "run-1" }).factFailClosed, false);
  assert.equal(p.handlers.message_sending({}, ctx), undefined);
});

test("a model that already produced the sentence is not latched twice", async () => {
  const p = plugin();
  const ctx = contexts();
  await settle(p, ctx, { outcome: { ok: false, code: "case-reject" }, calls: 1 });
  await p.handlers.before_agent_finalize({ ...FINALIZE, lastAssistantMessage: FACT_FAIL_CLOSED_TEXT }, ctx);
  assert.equal(p.__store.get({ runId: "run-1" }).factFailClosed, false);
});

test("only the annotated terminal text reaches the transcript", async () => {
  const p = plugin();
  const ctx = contexts();
  await settle(p, ctx, { calls: 0 });
  const draft = { role: "assistant", content: [{ type: "thinking", thinking: "I should write this." }, { type: "text", text: "Noted." }] };

  // The tool was never called and a nudge is still available, so this draft is
  // withheld rather than written.
  assert.deepEqual(p.handlers.before_message_write({ message: draft, sessionKey: ctx.sessionKey, agentId: ctx.agentId }, ctx), { block: true });
  const nudge = await p.handlers.before_agent_finalize(FINALIZE, ctx);
  assert.equal(nudge.action, "revise");

  // Budget spent. The transcript now carries exactly what ships — which is what
  // `deliver:false` reads, since it has no payload hook to intercept.
  const written = p.handlers.before_message_write(
    { message: draft, sessionKey: ctx.sessionKey, agentId: ctx.agentId },
    ctx,
  );
  assert.equal(written.block, undefined, "the terminal text is written, not blocked");
  assert.equal(written.message.content.length, 1, "reasoning traces are dropped");
  assert.match(written.message.content[0].text, /Noted\./);
  assert.match(written.message.content[0].text, /have not stored/i);
});


test("correction scope decides what a correction may write", async () => {
  const { resolveCorrection } = await import("../src/corrections.js");

  // User-owned: their say-so is the evidence, no tool required, commit allowed.
  const owned = resolveCorrection("It's an TC20.", "the car is your 330i, an TC10 chassis.");
  assert.equal(owned.correctionScope, "user_owned_fact");
  assert.equal(owned.evidenceSource, "current_user_assertion");
  assert.equal(owned.requiredTool, null);
  assert.equal(owned.factEnforcementRequired, true);
  assert.equal(owned.commitPermitted, true);

  const ram = resolveCorrection("No, I said 64 GB, not 32.", "Your server has 32 GB.");
  assert.equal(ram.correctionScope, "user_owned_fact");
  assert.equal(ram.requiredTool, null);

  // Hypothetical: resembles a correction, must never become a durable fact.
  // This is the turn that sent a web search after a private residence.
  const play = resolveCorrection("What if I told you I am Marlowe Vance?", "");
  assert.equal(play.isCorrection, false);
  assert.equal(play.commitPermitted, false);

  // External world: not settled by asserting it, so no personal-vault commit.
  const external = resolveCorrection("No, Tenet was released in 2019.", "Tenet came out in 2020.");
  assert.equal(external.correctionScope, "external_world");
  assert.equal(external.commitPermitted, false);
  assert.equal(external.factEnforcementRequired, false);

  // Ambiguous: a correction was signalled with no proposition to write.
  // Clarification is the outcome, never a fail-closed.
  const vague = resolveCorrection("That's wrong.", "Your server has 32 GB.");
  assert.equal(vague.correctionScope, "ambiguous");
  assert.equal(vague.commitPermitted, false);
  assert.equal(vague.factEnforcementRequired, false);
});
