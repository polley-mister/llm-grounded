// The guarded tool path: exposure, binding, budgets, prechecks, audit, commit.
//
// Everything that touches the world is injected, so the whole decision chain
// runs here without a gateway, a model, a vault, or a subprocess.
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseConfig } from "../src/config.js";
import {
  containsValue,
  createFactTool,
  isDirectOwnerSession,
  isFactOperatorAuthorized,
  runPrechecks,
  validateProposal,
} from "../src/facts-tool.js";
import { createGroundingStore } from "../src/state.js";

const CFG = parseConfig({
  factsEnabled: true,
  factsAgents: ["main", "chat"],
  vaultPath: "/tmp/vault",
  factsCliPath: "/tmp/vault_fact_commit.py",
}).data;

const PROPOSAL = {
  factKey: "operator.vehicle.car.chassis",
  subject: "the car",
  property: "chassis code",
  operation: "correct",
  previousValue: "F30",
  newValue: "M2",
};

const APPROVED = {
  ok: true,
  decision: { decision: "approve", supportedOldValue: "F30", supportedNewValue: "M2", reason: "stated" },
  attribution: { provider: "deepseek", model: "deepseek-v4-pro", agentId: "case" },
};

/** A store holding one live, eligible correction turn, with the call bound. */
function scenario(overrides = {}) {
  const store = createGroundingStore({ now: () => 1000 });
  store.begin({
    runId: "run-1",
    sessionKey: "sess-1",
    kind: "memory",
    correction: true,
    reason: "correction-personal",
    turnNonce: "abc123",
    userMessage: "It's an M2.",
    prevAssistant: "Sam, your car is a 330i — an F30 chassis.",
    fact: { eligible: true, kind: "correct", reason: "contextual-correction", unambiguous: true },
    ...overrides.begin,
  });
  store.bindToolCall({ toolCallId: "call-1", runId: "run-1", sessionKey: "sess-1" });
  return store;
}

function tool(store, { ctx = {}, deps = {}, cfg = CFG } = {}) {
  const commits = [];
  const audits = [];
  const instance = createFactTool({
    cfg,
    store,
  ctx: {
      agentId: "chat",
      senderIsOwner: true,
      sessionId: "sess-1",
      sessionKey: "agent:chat:main",
      ...ctx,
    },
    deps: {
      runCaseAudit: async (args) => {
        audits.push(args);
        return deps.audit ?? APPROVED;
      },
      commitFactTransaction: async (request, options) => {
        commits.push({ request, options });
        return deps.commit ?? { ok: true, code: "committed", revision: 2, materialized: false, needsRematerialization: false };
      },
      newTransactionId: () => "tx-fixed",
      ...deps.extra,
    },
  });
  return { instance, commits, audits };
}

async function run(store, opts = {}, params = PROPOSAL, callId = "call-1") {
  const t = tool(store, opts);
  const result = await t.instance.execute(callId, params);
  return { ...t, result, details: result.details };
}

// --------------------------------------------------------------------------
// exposure and binding
// --------------------------------------------------------------------------

test("an unrelated agent is refused even if it reaches execute", async () => {
  const { details } = await run(scenario(), { ctx: { agentId: "Atlas" } });
  assert.equal(details.ok, false);
  assert.equal(details.code, "agent-not-allowed");
});

test("a non-owner sender is refused", async () => {
  const { details } = await run(scenario(), { ctx: { senderIsOwner: false } });
  assert.equal(details.code, "not-owner");
  const missing = await run(scenario(), { ctx: { senderIsOwner: undefined } });
  assert.equal(missing.details.code, "not-owner");
});

test("an unbound tool call cannot reach a turn", async () => {
  const { details } = await run(scenario(), {}, PROPOSAL, "call-unknown");
  assert.equal(details.code, "unbound-call");
});

test("a binding is single use, so a replayed call id fails closed", async () => {
  const store = scenario();
  const first = await run(store);
  assert.equal(first.details.ok, true);
  const replay = await run(store);
  assert.equal(replay.details.code, "unbound-call");
});

test("a binding from another run never resolves this one", async () => {
  const store = scenario();
  store.begin({
    runId: "run-2", sessionKey: "sess-1", kind: null, turnNonce: "def456",
    userMessage: "2 + 2", prevAssistant: "", fact: { eligible: false },
  });
  store.bindToolCall({ toolCallId: "call-2", runId: "run-2", sessionKey: "sess-1" });
  const { details } = await run(store, {}, PROPOSAL, "call-2");
  // Resolved to run-2, which is not an eligible turn.
  assert.equal(details.code, "turn-not-eligible");
});

// --------------------------------------------------------------------------
// budgets
// --------------------------------------------------------------------------

test("one transaction and one audit per run", async () => {
  const store = scenario();
  const first = await run(store);
  assert.equal(first.details.ok, true);
  assert.equal(first.audits.length, 1);

  store.bindToolCall({ toolCallId: "call-2", runId: "run-1", sessionKey: "sess-1" });
  const second = await run(store, {}, PROPOSAL, "call-2");
  assert.equal(second.details.code, "already-used");
  assert.equal(second.audits.length, 0, "a refused second call must not spend an audit");
});

// --------------------------------------------------------------------------
// eligibility and structure
// --------------------------------------------------------------------------

test("an ineligible turn never audits or commits", async () => {
  const store = createGroundingStore({ now: () => 1000 });
  store.begin({
    runId: "run-1", sessionKey: "sess-1", kind: null, turnNonce: "n",
    userMessage: "What chassis is the car?", prevAssistant: "",
    fact: { eligible: false, kind: null, reason: "question", unambiguous: false },
  });
  store.bindToolCall({ toolCallId: "call-1", runId: "run-1", sessionKey: "sess-1" });
  const { details, audits, commits } = await run(store);
  assert.equal(details.code, "turn-not-eligible");
  assert.equal(audits.length, 0);
  assert.equal(commits.length, 0);
});

test("the operation must match what the turn actually was", async () => {
  const { details } = await run(scenario(), {}, {
    ...PROPOSAL, operation: "create", previousValue: undefined,
  });
  assert.equal(details.code, "operation-mismatch");
});

test("proposal validation is structural and strict", () => {
  const bad = [
    [{ ...PROPOSAL, factKey: "NotDotted" }, "invalid-fact-key"],
    [{ ...PROPOSAL, factKey: "nodots" }, "invalid-fact-key"],
    [{ ...PROPOSAL, subject: "" }, "invalid-request"],
    [{ ...PROPOSAL, operation: "delete" }, "invalid-request"],
    [{ ...PROPOSAL, newValue: "M2\nrm -rf /" }, "invalid-request"],
    [{ ...PROPOSAL, newValue: "x".repeat(500) }, "invalid-request"],
    [{ ...PROPOSAL, previousValue: "" }, "invalid-request"],
    [{ ...PROPOSAL, previousValue: "M2" }, "no-op"],
    [{ ...PROPOSAL, operation: "create", previousValue: "F30" }, "invalid-request"],
    [{ ...PROPOSAL, targetPage: "/etc/passwd" }, "invalid-target"],
    [{ ...PROPOSAL, targetPage: "syntheses/../../etc/x.md" }, "invalid-target"],
    [{ ...PROPOSAL, targetPage: "Journal/private.md" }, "invalid-target"],
    [{ ...PROPOSAL, targetPage: "syntheses/CAR.txt" }, "invalid-target"],
  ];
  for (const [params, code] of bad) {
    const result = validateProposal(params);
    assert.equal(result.ok, false, JSON.stringify(params));
    assert.equal(result.code, code, JSON.stringify(params));
  }
  assert.equal(validateProposal(PROPOSAL).ok, true);
  assert.equal(validateProposal({ ...PROPOSAL, targetPage: "syntheses/CAR.md" }).ok, true);
});

// --------------------------------------------------------------------------
// the evidence-binding prechecks — the acceptance criteria
// --------------------------------------------------------------------------

test("a new value absent from the operator's exact message cannot be committed", async () => {
  const { details, audits, commits } = await run(scenario(), {}, { ...PROPOSAL, newValue: "E46" });
  assert.equal(details.code, "new-value-not-stated");
  assert.equal(audits.length, 0);
  assert.equal(commits.length, 0);
});

test("a correction old value absent from the answer and the vault cannot be committed", async () => {
  const store = scenario();
  const { details, commits } = await run(store, {}, { ...PROPOSAL, previousValue: "E36" });
  assert.equal(details.code, "old-value-unsupported");
  assert.equal(commits.length, 0);
  assert.equal(store.get({ runId: "run-1" }).factCalls, 0, "a precheck refusal does not consume the transaction");
});

test("an early call may retrieve evidence and retry without spending a second transaction", async () => {
  const store = scenario({ begin: { prevAssistant: "" } });
  const first = await run(store);
  assert.equal(first.details.code, "old-value-unsupported");
  assert.equal(store.get({ runId: "run-1" }).factCalls, 0);

  store.recordEvidence({
    runId: "run-1",
    sessionKey: "sess-1",
    toolName: "wiki_search",
    params: { query: "the car chassis" },
    result: { content: [{ type: "text", text: "the car is listed as F30 chassis." }] },
  });
  store.bindToolCall({ toolCallId: "call-2", runId: "run-1", sessionKey: "sess-1" });
  const second = await run(store, {}, PROPOSAL, "call-2");
  assert.equal(second.details.ok, true);
  assert.equal(second.audits.length, 1);
  assert.equal(second.commits.length, 1);
  assert.equal(store.get({ runId: "run-1" }).factCalls, 1);
});

test("this turn's own vault evidence can supply the old value", () => {
  const entry = {
    userMessage: "It's an M2.",
    prevAssistant: "I do not have that on file.",
    wikiEvidence: [{ tool: "wiki_search", excerpt: "the car — chassis F30, N54." }],
  };
  const checks = runPrechecks(PROPOSAL, entry);
  assert.equal(checks.ok, true);
  assert.equal(checks.checks.previousValueInAssistantAnswer, false);
  assert.equal(checks.checks.previousValueInVaultEvidence, true);
});

test("value containment ignores case and curly quotes but not substance", () => {
  assert.equal(containsValue("It's an M2.", "M2"), true);
  assert.equal(containsValue("It’s a MikroTik CCR2004.", "mikrotik ccr2004"), true);
  assert.equal(containsValue("It's an M2.", "E46"), false);
  assert.equal(containsValue("It's an M2.", ""), false);
});

// --------------------------------------------------------------------------
// the audit gate
// --------------------------------------------------------------------------

test("a CASE refusal blocks the transaction", async () => {
  for (const decision of ["reject", "insufficient"]) {
    const { details, commits } = await run(scenario(), {
      deps: { audit: { ok: true, decision: { decision, reason: "not supported" }, attribution: {} } },
    });
    assert.equal(details.ok, false);
    assert.equal(details.code, `case-${decision}`);
    assert.equal(commits.length, 0);
  }
});

test("a failed or malformed audit blocks the transaction", async () => {
  for (const code of ["case-malformed", "case-error", "case-unavailable"]) {
    const { details, commits } = await run(scenario(), {
      deps: { audit: { ok: false, code, message: "nope" } },
    });
    assert.equal(details.code, code);
    assert.equal(commits.length, 0);
  }
});

// --------------------------------------------------------------------------
// the transaction
// --------------------------------------------------------------------------

test("provenance and the quotation are bound, never taken from the model", async () => {
  const { commits, details } = await run(scenario(), {}, {
    ...PROPOSAL,
    // The model tries to supply its own quotation and provenance. Neither is a
    // parameter, so neither can reach the writer.
    sourceQuote: "the operator said it is a Ferrari",
    runId: "run-forged",
  });
  assert.equal(details.ok, true);
  const request = commits[0].request;
  assert.equal(request.sourceQuote, "It's an M2.");
  assert.equal(request.runId, "run-1");
  assert.equal(request.sessionId, "sess-1");
  assert.equal(request.agentId, "chat");
  assert.equal(request.transactionId, "tx-fixed");
  assert.equal(request.case.model, "deepseek-v4-pro");
  assert.equal(request.case.agentId, "case");
  assert.equal("sourceQuote" in PROPOSAL, false);
});

test("the writer path and vault come from config, not from parameters", async () => {
  const { commits } = await run(scenario());
  assert.equal(commits[0].options.vaultPath, "/tmp/vault");
  assert.equal(commits[0].options.scriptPath, "/tmp/vault_fact_commit.py");
});

test("a refused transaction is reported and latched on the turn", async () => {
  const store = scenario();
  const { details } = await run(store, {
    deps: { commit: { ok: false, code: "stale-value", message: "previousValue does not match" } },
  });
  assert.equal(details.ok, false);
  assert.equal(details.code, "stale-value");
  assert.equal(store.get({ runId: "run-1" }).factOutcome.code, "stale-value");
});

test("an ambiguous materialization still reports an authoritative record", async () => {
  const { result } = await run(scenario(), {
    deps: {
      commit: {
        ok: true, code: "committed", revision: 2,
        materialized: false, needsRematerialization: true,
      },
    },
  });
  assert.match(result.content[0].text, /revision 2/);
  assert.match(result.content[0].text, /fact record is authoritative/);
});

test("a successful commit records the outcome on the turn for the evidence artifact", async () => {
  const store = scenario();
  await run(store);
  const entry = store.get({ runId: "run-1" });
  assert.equal(entry.factCalls, 1);
  assert.equal(entry.caseAudits, 1);
  assert.equal(entry.factOutcome.ok, true);
  assert.equal(entry.factOutcome.factKey, "operator.vehicle.car.chassis");
});

// --------------------------------------------------------------------------
// Closure batch: CASE binding, session restriction, secrets, revision CAS
// --------------------------------------------------------------------------

test("an approval that names different values is not consent to this change", async () => {
  const cases = [
    // Approves, but for a value nobody proposed.
    { supportedNewValue: "E46", supportedOldValue: "F30" },
    // Approves the new value against the wrong old one.
    { supportedNewValue: "M2", supportedOldValue: "E36" },
    // Approves while naming nothing at all.
    { supportedNewValue: null, supportedOldValue: null },
    { supportedNewValue: "M2", supportedOldValue: null },
  ];
  for (const decision of cases) {
    const { details, commits } = await run(scenario(), {
      deps: {
        audit: {
          ok: true,
          decision: { decision: "approve", reason: "ok", ...decision },
          attribution: { model: "deepseek-v4-pro" },
        },
      },
    });
    assert.equal(details.ok, false, JSON.stringify(decision));
    assert.equal(details.code, "case-unbound", JSON.stringify(decision));
    assert.equal(commits.length, 0);
  }
});

test("an approval bound to the proposal commits, allowing only normalization", async () => {
  const { details, commits } = await run(scenario(), {
    deps: {
      audit: {
        ok: true,
        // Case and punctuation differences are the only permitted drift.
        decision: { decision: "approve", supportedOldValue: "F30", supportedNewValue: "M2.", reason: "ok" },
        attribution: { model: "deepseek-v4-pro", agentId: "case" },
      },
    },
  });
  assert.equal(details.ok, true);
  assert.equal(commits.length, 1);
});

test("a substring of a stated value is not a stated value", async () => {
  // "2" is a substring of "M2"; the old substring check let it through.
  const { details, audits } = await run(scenario(), {}, { ...PROPOSAL, newValue: "2" });
  assert.equal(details.code, "new-value-not-stated");
  assert.equal(audits.length, 0);
});

test("a multi-word value must be stated as a phrase", () => {
  const entry = {
    userMessage: "My router is a MikroTik CCR2004 and the switch is a CRS328.",
    prevAssistant: "",
    wikiEvidence: [],
  };
  const proposal = { operation: "create", newValue: "MikroTik CCR2004" };
  assert.equal(runPrechecks(proposal, entry).ok, true);
  assert.equal(runPrechecks({ ...proposal, newValue: "MikroTik CRS328" }, entry).ok, false);
});

test("a source message carrying a credential is refused whole", async () => {
  const store = scenario({
    begin: { userMessage: "My router is a CCR2004, password hunter2" },
  });
  const { details, audits, commits } = await run(store, {}, {
    ...PROPOSAL,
    operation: "correct",
    previousValue: "F30",
    newValue: "CCR2004",
  });
  // The proposed value is benign; the message it would be quoted from is not.
  assert.equal(details.code, "secret-like-message");
  assert.equal(audits.length, 0);
  assert.equal(commits.length, 0);
});

test("group and channel sessions may not write vault facts", async () => {
  const cases = {
    "agent:chat:discord:acct:group:12345": "not-direct-session",
    "agent:chat:discord:channel:98765": "not-direct-session",
    "agent:chat:signal:group:abc": "not-direct-session",
    "": "not-direct-session",
    "something-unrecognized": "not-direct-session",
  };
  for (const [sessionKey, code] of Object.entries(cases)) {
    const { details, commits } = await run(scenario(), { ctx: { sessionKey } });
    assert.equal(details.code, code, sessionKey || "(empty)");
    assert.equal(commits.length, 0);
  }
});

test("direct, explicit and one-shot sessions are permitted", async () => {
  const cfg = parseConfig({
    factsEnabled: true,
    factsAgents: ["main", "chat"],
    vaultPath: "/tmp/vault",
    factsCliPath: "/tmp/vault_fact_commit.py",
    directSessionPrefixes: ["mc-chat"],
  }).data;

  const allowed = [
    { sessionKey: "agent:chat:main" },
    { sessionKey: "agent:chat:main:default" },
    { sessionKey: "agent:chat:discord:acct:direct:operator" },
    { sessionKey: "agent:chat:explicit:wp2026004-toolcheck" },
    { sessionKey: "mc-chat-main-20260724-1" },
    { sessionKey: "wp2026004-toolcheck", oneShotCliRun: true },
  ];
  for (const ctx of allowed) {
    const { details } = await run(scenario(), { ctx, cfg });
    assert.equal(details.ok, true, ctx.sessionKey);
  }
});

test("session shapes are classified without running a transaction", () => {
  const cfg = { directSessionPrefixes: ["mc-chat"] };
  assert.equal(isDirectOwnerSession("agent:main:main", {}, cfg).ok, true);
  assert.equal(isDirectOwnerSession("agent:main:x:group:1", {}, cfg).ok, false);
  assert.equal(isDirectOwnerSession("agent:main:x:channel:1", {}, cfg).ok, false);
  assert.equal(isDirectOwnerSession("agent:main:explicit:wp2026004-toolcheck", {}, cfg).ok, true);
  assert.equal(isDirectOwnerSession("agent:main:explicit:", {}, cfg).ok, false);
  assert.equal(isDirectOwnerSession("mc-chat-1", {}, cfg).ok, true);
  assert.equal(isDirectOwnerSession("mc-chat-1", {}, {}).ok, false, "the prefix must be configured");
  // Ambiguous native context fails closed rather than being guessed at.
  assert.equal(isDirectOwnerSession("discord:12345", {}, cfg).ok, false);
  assert.equal(isDirectOwnerSession(undefined, {}, cfg).ok, false);
});

test("narrow operator sessions authorize without operator.admin", () => {
  const cfg = { directSessionPrefixes: ["mc-chat"] };
  const canonical = isDirectOwnerSession("agent:chat:explicit:turn-1", {}, cfg);
  const configured = isDirectOwnerSession("mc-chat-turn-1", {}, cfg);
  const ordinary = isDirectOwnerSession("agent:chat:main", {}, cfg);
  assert.equal(isFactOperatorAuthorized({ senderIsOwner: false }, canonical), true);
  assert.equal(isFactOperatorAuthorized({ senderIsOwner: false }, configured), true);
  assert.equal(isFactOperatorAuthorized({ senderIsOwner: false }, ordinary), false);
  assert.equal(isFactOperatorAuthorized({ senderIsOwner: true }, ordinary), true);
});

test("the authenticated OpenClaw Control UI main session authorizes without operator.admin", () => {
  const direct = isDirectOwnerSession("agent:chat:main", {}, {});
  assert.equal(isFactOperatorAuthorized({ senderIsOwner: false, messageProvider: "webchat" }, direct), true);
  assert.equal(isFactOperatorAuthorized({ senderIsOwner: false, messageProvider: "discord" }, direct), false);
});

test("canonical explicit operator session executes without operator.admin", async () => {
  const cfg = parseConfig({
    factsEnabled: true,
    factsAgents: ["main", "chat"],
    vaultPath: "/tmp/vault",
    factsCliPath: "/tmp/vault_fact_commit.py",
  }).data;
  const { details } = await run(scenario(), {
    cfg,
    ctx: {
      senderIsOwner: false,
      sessionKey: "agent:chat:explicit:wp2026004-live",
    },
  });
  assert.equal(details.ok, true);
});

test("the revision this decision was made against is bound to the write", async () => {
  const overlay = {
    load: async () => ({
      facts: { "operator.vehicle.car.chassis": { currentValue: "F30", revision: 7 } },
    }),
    invalidate() {},
  };
  const { commits } = await run(scenario(), { deps: { extra: { overlay } } });
  assert.equal(commits[0].request.expectedRevision, 7);
});

test("an unknown or unreadable overlay simply omits the hint", async () => {
  const { commits } = await run(scenario(), {
    deps: { extra: { overlay: { load: async () => ({ facts: {} }), invalidate() {} } } },
  });
  assert.equal(commits[0].request.expectedRevision, null);

  const broken = await run(scenario(), {
    deps: {
      extra: {
        overlay: { load: async () => { throw new Error("unreadable"); }, invalidate() {} },
      },
    },
  });
  assert.equal(broken.commits[0].request.expectedRevision, null);
});

test("a stale revision is reported through the plugin path", async () => {
  const overlay = {
    load: async () => ({
      facts: { "operator.vehicle.car.chassis": { currentValue: "F30", revision: 1 } },
    }),
    invalidate() {},
  };
  const store = scenario();
  const { details } = await run(store, {
    deps: {
      extra: { overlay },
      commit: {
        ok: false,
        code: "stale-revision",
        message: "expectedRevision 1 but the record is at 3",
      },
    },
  });
  assert.equal(details.ok, false);
  assert.equal(details.code, "stale-revision");
  assert.equal(store.get({ runId: "run-1" }).factOutcome.code, "stale-revision");
});

test("a committed record invalidates the overlay for the next retrieval", async () => {
  let invalidated = 0;
  const overlay = { load: async () => ({ facts: {} }), invalidate: () => { invalidated += 1; } };
  await run(scenario(), { deps: { extra: { overlay } } });
  assert.equal(invalidated, 1);

  invalidated = 0;
  await run(scenario(), {
    deps: { extra: { overlay }, commit: { ok: false, code: "stale-value", message: "no" } },
  });
  assert.equal(invalidated, 0, "a refused transaction changed nothing to invalidate");
});
