import { test } from "node:test";
import assert from "node:assert/strict";

import { createPlugin, isErrorResult, stripUnverifiable } from "../src/index.js";
import { FAIL_CLOSED_TEXT, VOICE_CODA } from "../src/contract.js";

import "./_vocabulary.mjs";

// Phase 1A: only an explicit instruction, a parsed arithmetic expression, or
// an admin command compels a capability. These integration tests exercise what
// happens *once a turn is bound* — the requirement, the bounded revision, the
// fail-closed latch and the delivery replacement — so their inputs now say so
// outright. The assertions are unchanged; only the trigger is explicit.
//
// Turns that are merely *about* an external subject are covered by the
// advisory tests, which assert the opposite: no obligation, no revision, no
// route to fail-closed.

/** Build a plugin whose evidence writes are captured instead of hitting disk. */
function harness(pluginConfig = {}) {
  const written = [];
  const plugin = createPlugin({
    writeEvidence: async (dir, sessionId, record) => {
      written.push({ dir, sessionId, record });
      return `${dir}/${sessionId}.json`;
    },
    pruneEvidence: async () => 0,
  });
  const ctx = {
    agentId: "main",
    runId: "run-1",
    sessionKey: "sess-1",
    sessionId: "sess-1",
    pluginConfig,
  };
  return { plugin, ctx, written, h: plugin.handlers };
}

test("a direct native turn gets only the compact voice reminder and ships normally", async () => {
  const { h, ctx } = harness();
  const built = await h.before_prompt_build({ prompt: "2 + 2", messages: [] }, ctx);
  assert.equal(built.appendContext, VOICE_CODA, "a direct native turn appends the coda and nothing else");
  assert.doesNotMatch(built.appendContext, /web_search|memory_search/, "no grounding requirement");
  // WP-2026-005: the coda is generic. The retired version calibrated a stance
  // for questions about the operator's car and his profile, which is a second,
  // partial persona specification competing with SOUL.md.
  assert.doesNotMatch(built.appendContext, /stance|profile|car|review/i);
  assert.match(built.prependSystemContext, /Correction rule/);

  const finalize = await h.before_agent_finalize(
    { sessionId: "sess-1", stopHookActive: false, lastAssistantMessage: "Four." },
    ctx,
  );
  assert.equal(finalize, undefined, "no revision requested");
  assert.equal(h.reply_payload_sending({ payload: { text: "Four." }, runId: "run-1" }, ctx), undefined);
});

test("REGRESSION: an identity turn requires no tool and no control-file lookup", async () => {
  // WP-2026-005. Asked what it was, the agent classified the question as memory,
  // searched, and read workspace control prose back at the operator instead of
  // answering as itself. End to end: no requirement injected, no revision
  // requested, nothing to satisfy — so the turn cannot call a tool to answer
  // it, and the answer is never a control file.
  for (const prompt of ["What are you?", "what can you do, the agent?", "what are your settings?"]) {
    const { h, ctx, written } = harness();
    const built = await h.before_prompt_build({ prompt, messages: [] }, ctx);
    assert.equal(built.appendContext, VOICE_CODA, `${prompt}: coda only`);
    assert.doesNotMatch(built.appendContext, /web_search|memory_search|wiki_search/, prompt);
    assert.doesNotMatch(built.prependSystemContext, /TARS_CONTROL|SOUL\.md|AGENTS\.md/, prompt);

    const finalize = await h.before_agent_finalize(
      { sessionId: "sess-1", stopHookActive: false, lastAssistantMessage: "the agent. the operator's operator." },
      ctx,
    );
    assert.equal(finalize, undefined, `${prompt}: no revision, so no forced search`);
    assert.equal(written.at(-1).record.grounding, null, `${prompt}: recorded as direct`);
    assert.equal(written.at(-1).record.failClosed, false, prompt);
    // Delivery is untouched: the model's own answer ships.
    assert.equal(
      h.reply_payload_sending({ payload: { text: "the agent." }, runId: "run-1" }, ctx),
      undefined,
      prompt,
    );
  }
});

test("a web turn injects the requirement and passes once web_search succeeds", async () => {
  const { h, ctx, written } = harness();
  const built = await h.before_prompt_build({ prompt: "How did Boromir die? Search the web.", messages: [] }, ctx);
  assert.match(built.appendContext, /web_search/);
  assert.match(built.appendContext, new RegExp(FAIL_CLOSED_TEXT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  h.after_tool_call({ toolName: "web_search", params: {}, result: { content: [] } }, ctx);
  const finalize = await h.before_agent_finalize(
    { sessionId: "sess-1", stopHookActive: false, lastAssistantMessage: "He died in the Atlas explosion." },
    ctx,
  );
  assert.equal(finalize, undefined);
  assert.equal(written.at(-1).record.groundingVerified, true);
  assert.equal(written.at(-1).record.grounding, "web");
  assert.equal(written.at(-1).record.toolCalls, 1);
});

test("an ungrounded web turn asks for exactly one bounded revision", async () => {
  const { h, ctx } = harness();
  await h.before_prompt_build({ prompt: "How did Boromir die? Search the web.", messages: [] }, ctx);

  const first = await h.before_agent_finalize(
    { sessionId: "sess-1", stopHookActive: false, lastAssistantMessage: "He drowned." },
    ctx,
  );
  assert.equal(first.action, "revise");
  assert.equal(first.retry.maxAttempts, 1);
  assert.match(first.retry.instruction, /web_search/);

  const second = await h.before_agent_finalize(
    { sessionId: "sess-1", stopHookActive: false, lastAssistantMessage: "He still drowned." },
    ctx,
  );
  assert.equal(second, undefined, "no second revision");
});

test("delivery fails closed after the bounded revision is spent", async () => {
  const { h, ctx, written } = harness();
  await h.before_prompt_build({ prompt: "How did Boromir die? Search the web.", messages: [] }, ctx);
  await h.before_agent_finalize({ sessionId: "sess-1", stopHookActive: false, lastAssistantMessage: "a" }, ctx);
  await h.before_agent_finalize({ sessionId: "sess-1", stopHookActive: false, lastAssistantMessage: "b" }, ctx);

  const payload = h.reply_payload_sending(
    { payload: { text: "b", mediaUrls: ["x"], presentation: { kind: "card" } }, runId: "run-1" },
    ctx,
  );
  assert.equal(payload.payload.text, FAIL_CLOSED_TEXT);
  assert.equal(payload.payload.mediaUrls, undefined, "unverifiable media is dropped");
  assert.equal(payload.payload.presentation, undefined);

  const message = h.message_sending({ to: "x", content: "b" }, ctx);
  assert.equal(message.content, FAIL_CLOSED_TEXT);
  assert.equal(written.at(-1).record.failClosed, true);
  assert.equal(written.at(-1).record.groundingVerified, false);
});

test("an ungrounded retry draft never becomes a second visible transcript reply", async () => {
  const { h, ctx } = harness();
  await h.before_prompt_build({ prompt: "How did Boromir die? Search the web.", messages: [] }, ctx);
  const draft = { role: "assistant", content: [{ type: "text", text: "He drowned." }] };

  assert.deepEqual(
    h.before_message_write({ message: draft, sessionKey: ctx.sessionKey, agentId: ctx.agentId }, ctx),
    { block: true },
  );
  const retry = await h.before_agent_finalize(
    { sessionId: "sess-1", stopHookActive: false, lastAssistantMessage: "He drowned." },
    ctx,
  );
  assert.equal(retry.action, "revise");

  const exhausted = h.before_message_write(
    { message: draft, sessionKey: ctx.sessionKey, agentId: ctx.agentId },
    ctx,
  );
  assert.deepEqual(exhausted.message.content, [{ type: "text", text: FAIL_CLOSED_TEXT }]);
});

// --- live acceptance lifecycle (2026-07-24) --------------------------------
// Reproduces the failing run end to end: runId 705b8a76-…, session
// wp2026002-arithmetic-20260724. The native transport delivered
// `[Fri 2026-07-24 18:46 PDT] Hey Atlas, what is 2 + 2?`; the timestamp prefix
// defeated vocative stripping, `the agent` read as a project term, the turn was
// classified `memory`, and the correct answer was thrown away by a revision.

const LIVE_PROMPT = "[Fri 2026-07-24 18:46 PDT] Hey Atlas, what is 2 + 2?";
const LIVE_ANSWER = "Four. No deliberation budget needed for that one.";

test("REGRESSION: the live arithmetic turn finalizes with no revision", async () => {
  const { h, ctx, written } = harness();
  const built = await h.before_prompt_build({ prompt: LIVE_PROMPT, messages: [] }, ctx);
  assert.match(built.appendContext, /Reply as the agent, in the voice SOUL\.md defines/);
  assert.doesNotMatch(built.appendContext, /web_search|memory_search/, "a direct turn injects no grounding requirement");

  const finalize = await h.before_agent_finalize(
    { sessionId: "sess-1", stopHookActive: false, lastAssistantMessage: LIVE_ANSWER },
    ctx,
  );
  assert.equal(finalize, undefined, "no revision may be requested");
  assert.equal(written.at(-1).record.grounding, null, "evidence must record a direct turn");
  assert.equal(written.at(-1).record.groundingVerified, true);

  // The answer ships untouched.
  assert.equal(h.reply_payload_sending({ payload: { text: LIVE_ANSWER }, runId: "run-1" }, ctx), undefined);
});

test("REGRESSION: a revision pass does not reclassify the turn", async () => {
  const { h, ctx } = harness();
  await h.before_prompt_build({ prompt: LIVE_PROMPT, messages: [] }, ctx);

  // The harness rebuilds the prompt inside the same run. That rebuilt prompt
  // carries this plugin's own requirement text, which names memory_search and
  // web_search — the exact text that flipped a direct turn to `memory` live.
  const rebuilt =
    "Grounding required for this turn: run memory_search or wiki_search before answering.\n" +
    "You answered without memory_search or wiki_search. Run it now.";
  const second = await h.before_prompt_build({ prompt: rebuilt, messages: [] }, ctx);

  assert.match(second.appendContext, /Reply as the agent, in the voice SOUL\.md defines/);
  assert.doesNotMatch(second.appendContext, /web_search|memory_search/, "the turn is still direct");
  const finalize = await h.before_agent_finalize(
    { sessionId: "sess-1", stopHookActive: false, lastAssistantMessage: LIVE_ANSWER },
    ctx,
  );
  assert.equal(finalize, undefined, "state must not have been replaced by a memory entry");
});

test("a grounded turn keeps its original kind and evidence across its revision", async () => {
  const { h, ctx, written } = harness();
  await h.before_prompt_build({ prompt: "How did Boromir die? Search the web.", messages: [] }, ctx);

  // Unverified: the plugin asks for its one bounded revision.
  const revise = await h.before_agent_finalize(
    { sessionId: "sess-1", stopHookActive: false, lastAssistantMessage: "He drowned." },
    ctx,
  );
  assert.equal(revise.action, "revise");

  // The revision pass rebuilds the prompt. The turn must stay `web` — and must
  // not be re-counted as a fresh turn, which would reset the revision budget.
  const rebuilt = "You answered without web_search. Run it now and answer from what it returns.";
  const built = await h.before_prompt_build({ prompt: rebuilt, messages: [] }, ctx);
  assert.match(built.appendContext, /web_search/, "the original requirement is restated");

  h.after_tool_call({ toolName: "web_search", params: {}, result: {} }, ctx);
  const finalize = await h.before_agent_finalize(
    { sessionId: "sess-1", stopHookActive: false, lastAssistantMessage: "The Atlas explosion." },
    ctx,
  );
  assert.equal(finalize, undefined, "grounded on the retry, so it finalizes");
  assert.equal(written.at(-1).record.grounding, "web", "kind preserved across the revision");
  assert.equal(written.at(-1).record.groundingVerified, true);
  assert.equal(written.at(-1).record.revisions, 1, "the revision budget was not reset");
});

test("a genuine new the console turn is reclassified", async () => {
  const { h, ctx } = harness();
  const turn = (nonce, body) => `[user-message:${nonce}]\n${body}\n[/user-message:${nonce}]`;

  // Turn one: direct. the console reuses one run id across a chat session,
  // so only the nonce distinguishes the turns.
  const first = await h.before_prompt_build({ prompt: turn("aaaaaaaa", "2 + 2"), messages: [] }, ctx);
  assert.equal(first.appendContext, undefined);

  // Turn two: grounded. A new nonce means a new turn, so it must reclassify.
  const second = await h.before_prompt_build(
    { prompt: turn("bbbbbbbb", "How did Boromir die? Search the web."), messages: [] },
    ctx,
  );
  assert.match(second.appendContext, /web_search/, "the new turn must be classified fresh");
});

test("native sequential turns are each classified fresh", async () => {
  const { h, ctx } = harness();
  // Each native turn arrives on its own run, so there is no prior entry to keep.
  await h.before_prompt_build({ prompt: LIVE_PROMPT, messages: [] }, ctx);

  const next = { ...ctx, runId: "run-2" };
  const built = await h.before_prompt_build({ prompt: "How did Boromir die? Search the web.", messages: [] }, next);
  assert.match(built.appendContext, /web_search/, "a new native turn must be classified fresh");
});

test("a multi-payload fail-closed turn says it once and cancels the rest", async () => {
  const { h, ctx } = harness();
  await h.before_prompt_build({ prompt: "How did Boromir die? Search the web.", messages: [] }, ctx);
  await h.before_agent_finalize({ sessionId: "sess-1", stopHookActive: false, lastAssistantMessage: "a" }, ctx);
  await h.before_agent_finalize({ sessionId: "sess-1", stopHookActive: false, lastAssistantMessage: "a" }, ctx);

  const first = h.reply_payload_sending({ payload: { text: "chunk 1" }, runId: "run-1" }, ctx);
  assert.equal(first.payload.text, FAIL_CLOSED_TEXT);
  const second = h.reply_payload_sending({ payload: { text: "chunk 2" }, runId: "run-1" }, ctx);
  assert.equal(second.cancel, true);
  assert.equal(second.payload, undefined);

  // The message lane counts separately: cancelling it because the payload lane
  // already fired would drop the reply entirely.
  const message = h.message_sending({ to: "x", content: "chunk 1" }, ctx);
  assert.equal(message.content, FAIL_CLOSED_TEXT);
  assert.equal(h.message_sending({ to: "x", content: "chunk 2" }, ctx).cancel, true);
});

test("agent_end flushes evidence even without a natural finalize", async () => {
  const { h, ctx, written } = harness();
  await h.before_prompt_build({ prompt: "How did Boromir die? Search the web.", messages: [] }, ctx);
  h.after_tool_call({ toolName: "web_search", params: {}, result: {} }, ctx);
  written.length = 0;

  await h.agent_end({ runId: "run-1" }, ctx);
  assert.equal(written.length, 1, "agent_end wrote the terminal record");
  assert.equal(written[0].record.grounding, "web");
  assert.equal(written[0].record.groundingVerified, true);
  assert.equal(written[0].sessionId, "sess-1");
});

test("agent_end does not release state that delivery hooks still need", async () => {
  const { h, ctx } = harness();
  await h.before_prompt_build({ prompt: "How did Boromir die? Search the web.", messages: [] }, ctx);
  await h.before_agent_finalize({ sessionId: "sess-1", stopHookActive: false, lastAssistantMessage: "a" }, ctx);
  await h.before_agent_finalize({ sessionId: "sess-1", stopHookActive: false, lastAssistantMessage: "a" }, ctx);
  await h.agent_end({ runId: "run-1" }, ctx);
  assert.equal(
    h.reply_payload_sending({ payload: { text: "a" }, runId: "run-1" }, ctx).payload.text,
    FAIL_CLOSED_TEXT,
  );
});

test("a failed grounding tool still fails closed", async () => {
  const { h, ctx } = harness();
  await h.before_prompt_build({ prompt: "search the web for the latest release of Node", messages: [] }, ctx);
  h.after_tool_call({ toolName: "web_search", params: {}, error: "timeout" }, ctx);
  await h.before_agent_finalize({ sessionId: "sess-1", stopHookActive: false, lastAssistantMessage: "v20" }, ctx);
  await h.before_agent_finalize({ sessionId: "sess-1", stopHookActive: false, lastAssistantMessage: "v20" }, ctx);
  assert.equal(
    h.reply_payload_sending({ payload: { text: "v20" }, runId: "run-1" }, ctx).payload.text,
    FAIL_CLOSED_TEXT,
  );
});

test("a model that fails closed on its own is not asked to revise", async () => {
  const { h, ctx } = harness();
  await h.before_prompt_build({ prompt: "How did Boromir die? Search the web.", messages: [] }, ctx);
  const finalize = await h.before_agent_finalize(
    { sessionId: "sess-1", stopHookActive: false, lastAssistantMessage: FAIL_CLOSED_TEXT },
    ctx,
  );
  assert.equal(finalize, undefined);
});

test("delivery hooks with no run id resolve through the session", async () => {
  const { h, ctx } = harness();
  await h.before_prompt_build({ prompt: "How did Boromir die? Search the web.", messages: [] }, ctx);
  await h.before_agent_finalize({ sessionId: "sess-1", stopHookActive: false, lastAssistantMessage: "a" }, ctx);
  await h.before_agent_finalize({ sessionId: "sess-1", stopHookActive: false, lastAssistantMessage: "a" }, ctx);

  const outbound = { channelId: "discord", sessionKey: "sess-1", pluginConfig: {} };
  assert.equal(h.message_sending({ to: "x", content: "a" }, outbound).content, FAIL_CLOSED_TEXT);
});

test("agents outside enabledAgents are untouched", async () => {
  const { h, ctx } = harness({ enabledAgents: ["main"] });
  const other = { ...ctx, agentId: "market-research" };
  assert.equal(await h.before_prompt_build({ prompt: "How did Boromir die? Search the web.", messages: [] }, other), undefined);
});

test("memory turns require a memory tool", async () => {
  const { h, ctx, written } = harness();
  await h.before_prompt_build({ prompt: "check your memory for my on-call weekend schedule", messages: [] }, ctx);
  h.after_tool_call({ toolName: "wiki_search", params: {}, result: {} }, ctx);
  const finalize = await h.before_agent_finalize(
    { sessionId: "sess-1", stopHookActive: false, lastAssistantMessage: "Saturday." },
    ctx,
  );
  assert.equal(finalize, undefined);
  assert.equal(written.at(-1).record.grounding, "memory");
  assert.equal(written.at(-1).record.groundingVerified, true);
});

test("tool results that report their own error count as failures", () => {
  assert.equal(isErrorResult({ isError: true }), true);
  assert.equal(isErrorResult({ content: [{ type: "text", isError: true }] }), true);
  assert.equal(isErrorResult({ content: [{ type: "text", text: "ok" }] }), false);
  assert.equal(isErrorResult(undefined), false);
});

test("stripUnverifiable removes claim-carrying payload fields", () => {
  const out = stripUnverifiable({
    text: "t",
    mediaUrl: "a",
    mediaUrls: ["a"],
    presentation: {},
    interactive: {},
    spokenText: "s",
    btw: { question: "q" },
    replyToId: "keep",
  });
  assert.deepEqual(Object.keys(out).sort(), ["replyToId", "text"]);
});
