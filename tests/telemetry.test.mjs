import assert from "node:assert/strict";
import test from "node:test";

import { buildTurnRecord } from "../src/telemetry.js";

import "./_vocabulary.mjs";

const entry = {
  runId: "run-1",
  kind: "web",
  reason: "current-information",
  correction: false,
  revisions: 1,
  voiceRevisions: 0,
  failClosed: false,
  offTopicTools: 0,
  userMessage: "what is the latest Proxmox release?",
  telemetry: {
    features: { currentInfo: true, namedEntity: true, words: 6 },
    drafts: ["first pass answer", "second pass answer"],
    tools: [{ name: "web_search", ok: true, params: { query: "proxmox release" } }],
  },
};

test("the record carries the fields Phase 4 and the FP measurement need", () => {
  const r = buildTurnRecord(entry, { sessionId: "s1", agentId: "chat", final: "second pass answer" });

  // Without the draft there is nothing to calibrate a claim extractor against:
  // the final text has already been through the gates.
  assert.equal(r.draft, "first pass answer");
  assert.equal(r.final, "second pass answer");
  assert.equal(r.draftCount, 2);

  // Without features, a rule edit orphans the corpus.
  assert.equal(r.features.currentInfo, true);
  assert.equal(r.features.namedEntity, true);

  // The disagreement set is verdict vs tools actually called.
  assert.equal(r.verdict.kind, "web");
  assert.equal(r.verdict.enforced, true);
  assert.equal(r.tools[0].name, "web_search");
  assert.equal(r.tools[0].params.query, "proxmox release");

  assert.equal(r.gates.revised, 1);
  assert.equal(r.replyWords, 3);
});

test("a turn with no verdict records as unenforced", () => {
  const r = buildTurnRecord(
    { ...entry, kind: null, reason: "acknowledgement", telemetry: { features: {}, drafts: ["Noted."], tools: [] } },
    { final: "Noted." },
  );
  assert.equal(r.verdict.kind, null);
  assert.equal(r.verdict.enforced, false);
  assert.equal(r.tools.length, 0);
});

test("missing telemetry never throws", () => {
  // Logging must degrade to an empty record, never fail a turn.
  const r = buildTurnRecord({}, {});
  assert.equal(r.draft, "");
  assert.deepEqual(r.features, {});
  assert.deepEqual(r.tools, []);
  assert.equal(r.replyWords, 0);
});

test("long text is truncated rather than stored whole", () => {
  const huge = "word ".repeat(3000);
  const r = buildTurnRecord(
    { userMessage: huge, telemetry: { drafts: [huge], tools: [], features: {} } },
    { final: huge },
  );
  assert.ok(r.turn.length < 4200, "turn truncated");
  assert.ok(r.draft.endsWith("[truncated]"));
});

test("synthetic turns are marked, and draft length is kept alongside final", () => {
  // The fail-closed path is the most destructive branch and must be tested,
  // but a test turn must never be counted as ordinary use.
  const r = buildTurnRecord(
    { userMessage: "probe", telemetry: { features: {}, drafts: ["a b c d e f"], tools: [] } },
    { synthetic: true, syntheticReason: "failclosed", final: "a b" },
  );
  assert.equal(r.synthetic, true);
  assert.equal(r.syntheticReason, "failclosed");

  // Both lengths, always: the pair is the entire measurement of what the
  // voice gate did, which is why the gate stays enabled during the baseline.
  assert.equal(r.draftWords, 6);
  assert.equal(r.replyWords, 2);
});

test("an ordinary turn is not marked synthetic", () => {
  const r = buildTurnRecord({ telemetry: { drafts: ["hi"], tools: [], features: {} } }, { final: "hi" });
  assert.equal(r.synthetic, false);
  assert.equal(r.syntheticReason, null);
});

test("behaviour identity is carried per surface", () => {
  const r = buildTurnRecord(
    { telemetry: { drafts: ["x"], tools: [], features: {} } },
    {
      final: "x",
      identity: {
        behaviorEpoch: "v1.10.0-enforced",
        promptHash: "sha256:aaa",
        rulesetHash: "sha256:bbb",
        configHash: "sha256:ccc",
      },
    },
  );
  // Split rather than combined: a prompt edit and a rule edit are different
  // events and analysis must be able to tell them apart.
  assert.equal(r.behaviorEpoch, "v1.10.0-enforced");
  assert.equal(r.promptHash, "sha256:aaa");
  assert.equal(r.rulesetHash, "sha256:bbb");
  assert.equal(r.configHash, "sha256:ccc");
});

test("fail-closed is recorded from the outcome, not the latch", () => {
  // Found by forcing the path in production: when the model emits the
  // fail-closed line itself the handler takes the alreadyFailClosed branch and
  // never latches, so entry.failClosed stays false on a turn that plainly
  // failed closed. The most destructive outcome must not depend on which code
  // path produced it.
  const entry = { telemetry: { drafts: ["I could not confirm that."], tools: [], features: {} }, failClosed: false };

  const detected = buildTurnRecord(entry, { final: "I could not confirm that.", failedClosed: true });
  assert.equal(detected.gates.failedClosed, true);

  // The latch alone still counts, for turns the plugin substituted.
  const latched = buildTurnRecord({ ...entry, failClosed: true }, { final: "x" });
  assert.equal(latched.gates.failedClosed, true);

  // And an ordinary turn stays false.
  const ordinary = buildTurnRecord(entry, { final: "Four hundred and eight." });
  assert.equal(ordinary.gates.failedClosed, false);
});
