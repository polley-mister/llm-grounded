// The offline join: what a turn cites, what is actually on disk, and the
// difference between the ways those can disagree.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  INSPECTION_SCHEMA_VERSION,
  JOIN_STATUSES,
  inspectTurn,
  inspectTurns,
  summarizeInspections,
} from "../src/inspection.js";

const sha256 = (t) => `sha256:${createHash("sha256").update(String(t), "utf8").digest("hex")}`;

function evidence(id, over = {}) {
  const excerpt = over.excerpt ?? `excerpt for ${id}`;
  return {
    schemaVersion: "evidence-v1",
    evidenceId: id,
    turnId: "run-1",
    tool: "web_search",
    sourceType: "web",
    evidenceView: "effective_tool_result",
    transformsApplied: [],
    excerpt,
    excerptHash: sha256(excerpt),
    capturedAt: "2026-07-28T12:00:00.000Z",
    claimSupported: null,
    ...over,
  };
}

function turn(over = {}) {
  return {
    ts: "2026-07-28T12:00:00.000Z",
    internalTurnId: "t1",
    turnId: "run-1",
    sessionId: "mc-chat-9",
    agentId: "tars-chat",
    trafficClass: "human",
    trafficResolutionStatus: "resolved",
    draft: "About $4,000.",
    final: "About $4,000.",
    evidenceIds: ["ev_a", "ev_b"],
    evidenceCaptureStatus: "complete",
    ...over,
  };
}

/** A store built from the records given; anything else is genuinely absent. */
function store(records) {
  const byId = new Map(records.map((r) => [r.evidenceId, r]));
  return async (id) => (byId.has(id) ? { ok: true, record: byId.get(id) } : { ok: false, reason: "missing" });
}

const NOW = Date.parse("2026-07-28T13:00:00.000Z");

// ---------------------------------------------------------------------------
// The happy path, and what it must not claim
// ---------------------------------------------------------------------------

test("a turn joins to its evidence, in the order it recorded", async () => {
  const out = await inspectTurn(turn(), {
    readEvidence: store([evidence("ev_b"), evidence("ev_a")]),
    now: () => NOW,
  });

  assert.equal(out.schemaVersion, INSPECTION_SCHEMA_VERSION);
  assert.equal(out.joinStatus, "complete");
  assert.deepEqual(out.evidence.map((e) => e.evidenceId), ["ev_a", "ev_b"], "recorded order, not store order");
  assert.equal(out.evidenceCounts.resolved, 2);
  assert.equal(out.internalTurnId, "t1");
});

test("the join asserts nothing about support", async () => {
  // The one thing this file must never do. Four excerpts on a turn that called
  // a search tool is not evidence that the answer was supported, and measuring
  // how often those come apart is the entire purpose.
  const out = await inspectTurn(turn(), {
    readEvidence: store([evidence("ev_a"), evidence("ev_b")]),
    now: () => NOW,
  });
  assert.deepEqual(out.supportLabels, []);
  for (const e of out.evidence) assert.equal(e.claimSupported, null);
  assert.doesNotMatch(JSON.stringify(out), /"supported"\s*:/);
});

test("excerpt text is not copied into the join output", async () => {
  // It would be a second, unretained copy of verbatim third-party content.
  const out = await inspectTurn(turn(), {
    readEvidence: store([evidence("ev_a", { excerpt: "Listed at $4,000 today." }), evidence("ev_b")]),
    now: () => NOW,
  });
  assert.doesNotMatch(JSON.stringify(out), /Listed at \$4,000/);
  assert.equal(out.evidence[0].excerptChars, "Listed at $4,000 today.".length);
});

test("the stored traffic decision is copied, not recomputed", async () => {
  const out = await inspectTurn(turn({ trafficClass: "synthetic_test", sessionId: "mc-chat-9" }), {
    readEvidence: store([evidence("ev_a"), evidence("ev_b")]),
    now: () => NOW,
  });
  // The session id would classify as human. The turn's own answer stands.
  assert.equal(out.trafficClass, "synthetic_test");
});

// ---------------------------------------------------------------------------
// The ways it can go wrong, kept apart
// ---------------------------------------------------------------------------

test("a referenced excerpt that is not there is missing, not absent-by-design", async () => {
  const out = await inspectTurn(turn(), {
    readEvidence: store([evidence("ev_a")]),
    now: () => NOW,
  });
  assert.equal(out.joinStatus, "partially_missing");
  assert.equal(out.evidence[1].resolution, "missing");
  assert.equal(out.evidenceCounts.missing, 1);
});

test("a missing excerpt on a turn older than retention is expired, not missing", async () => {
  // Pruning is the design. Reporting it as loss would make every corpus older
  // than the retention window look broken.
  const out = await inspectTurn(turn({ ts: "2026-06-01T12:00:00.000Z" }), {
    readEvidence: store([]),
    retentionDays: 14,
    now: () => NOW,
  });
  assert.equal(out.joinStatus, "evidence_expired");
  assert.equal(out.evidenceCounts.expired, 2);
  assert.equal(out.evidenceCounts.missing, 0);
});

test("an excerpt that no longer hashes to what was recorded is corrupt", async () => {
  const tampered = evidence("ev_a");
  tampered.excerpt = "something else entirely";
  const out = await inspectTurn(turn(), {
    readEvidence: store([tampered, evidence("ev_b")]),
    now: () => NOW,
  });
  assert.equal(out.joinStatus, "integrity_failure");
  assert.equal(out.evidence[0].resolution, "corrupt");
  assert.match(out.evidence[0].detail, /does not match/);
});

test("a record with no hash to check is corrupt, not trusted", async () => {
  const unhashed = evidence("ev_a");
  delete unhashed.excerptHash;
  const out = await inspectTurn(turn({ evidenceIds: ["ev_a"] }), {
    readEvidence: store([unhashed]),
    now: () => NOW,
  });
  assert.equal(out.evidence[0].resolution, "corrupt");
  assert.equal(out.joinStatus, "integrity_failure");
});

test("an unreadable record is distinguished from a missing one", async () => {
  const out = await inspectTurn(turn({ evidenceIds: ["ev_a"] }), {
    readEvidence: async () => ({ ok: false, reason: "unreadable" }),
    now: () => NOW,
  });
  assert.equal(out.evidence[0].resolution, "unreadable");
  assert.equal(out.joinStatus, "integrity_failure");
});

test("an unrecognised read failure is treated as unreadable, never as fine", async () => {
  const out = await inspectTurn(turn({ evidenceIds: ["ev_a"] }), {
    readEvidence: async () => ({ ok: false, reason: "something new" }),
    now: () => NOW,
  });
  assert.equal(out.evidence[0].resolution, "unreadable");
});

test("a reader that throws does not abort the join", async () => {
  const out = await inspectTurn(turn({ evidenceIds: ["ev_a", "ev_b"] }), {
    readEvidence: async (id) => {
      if (id === "ev_a") throw new Error("disk gone");
      return { ok: true, record: evidence("ev_b") };
    },
    now: () => NOW,
  });
  assert.equal(out.evidence[0].resolution, "unreadable");
  assert.equal(out.evidence[1].resolution, "resolved");
});

test("integrity failure outranks a missing excerpt on the same turn", async () => {
  // A store telling us something untrue is worse news than one telling us
  // nothing, and the headline should be the worse news.
  const tampered = evidence("ev_a");
  tampered.excerpt = "changed";
  const out = await inspectTurn(turn(), { readEvidence: store([tampered]), now: () => NOW });
  assert.equal(out.evidence[0].resolution, "corrupt");
  assert.equal(out.evidence[1].resolution, "missing");
  assert.equal(out.joinStatus, "integrity_failure");
});

// ---------------------------------------------------------------------------
// Turns with nothing to join
// ---------------------------------------------------------------------------

test("a turn that cited no evidence is no_evidence, not a failure", async () => {
  const out = await inspectTurn(turn({ evidenceIds: [] }), { readEvidence: store([]), now: () => NOW });
  assert.equal(out.joinStatus, "no_evidence");
  assert.equal(out.evidenceReferenced, 0);
});

test("a turn with no evidenceIds field at all is handled", async () => {
  const out = await inspectTurn({ ts: "2026-07-28T12:00:00.000Z" }, { readEvidence: store([]), now: () => NOW });
  assert.equal(out.joinStatus, "no_evidence");
  assert.deepEqual(out.evidence, []);
});

test("an abstained extraction is reported as such", async () => {
  const out = await inspectTurn(turn({ evidenceIds: [] }), {
    readEvidence: store([]),
    extraction: { status: "abstained", claims: [], abstentionReason: "non_atomic_claims" },
    now: () => NOW,
  });
  assert.equal(out.joinStatus, "claim_extraction_abstained");
  assert.equal(out.claimExtraction.abstentionReason, "non_atomic_claims");
});

test("a turn inspected without an extraction has not abstained", async () => {
  // It was never asked. Recording that as abstention would invent a measured
  // outcome from the absence of a measurement.
  const out = await inspectTurn(turn({ evidenceIds: [] }), { readEvidence: store([]), now: () => NOW });
  assert.equal(out.claimExtraction.status, "not_run");
  assert.notEqual(out.joinStatus, "claim_extraction_abstained");
});

test("evidence problems outrank an abstention", async () => {
  const out = await inspectTurn(turn(), {
    readEvidence: store([evidence("ev_a")]),
    extraction: { status: "abstained", claims: [] },
    now: () => NOW,
  });
  assert.equal(out.joinStatus, "partially_missing");
});

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

test("every emitted join status is one of the declared set", async () => {
  const cases = [
    turn(),
    turn({ evidenceIds: [] }),
    turn({ evidenceIds: ["ev_missing"] }),
    turn({ ts: "2026-01-01T00:00:00.000Z", evidenceIds: ["ev_gone"] }),
  ];
  for (const t of cases) {
    const out = await inspectTurn(t, { readEvidence: store([evidence("ev_a"), evidence("ev_b")]), now: () => NOW });
    assert.ok(JOIN_STATUSES.includes(out.joinStatus), `${out.joinStatus} for ${JSON.stringify(t.evidenceIds)}`);
  }
});

test("inspectTurn refuses to run without a reader rather than reporting no evidence", async () => {
  await assert.rejects(() => inspectTurn(turn(), {}), TypeError);
});

test("many turns summarize by status and traffic class", async () => {
  const out = await inspectTurns(
    [turn(), turn({ evidenceIds: [] }), turn({ trafficClass: "heartbeat", evidenceIds: [] })],
    { readEvidence: store([evidence("ev_a"), evidence("ev_b")]), now: () => NOW },
  );
  const summary = summarizeInspections(out);
  assert.equal(summary.turns, 3);
  assert.equal(summary.byStatus.complete, 1);
  assert.equal(summary.byStatus.no_evidence, 2);
  assert.equal(summary.byTraffic.human, 2);
  assert.equal(summary.byTraffic.heartbeat, 1);
  assert.equal(summary.evidenceReferenced, 2);
  assert.equal(summary.evidenceResolved, 2);
});
