// The observation numbers, and the two ways they could lie.
//
// The first: counting excluded traffic against coverage, which would make the
// completion rate a function of how often the heartbeat runs rather than of
// whether extraction works.
//
// The second: reporting a number that could not be computed as zero. An unknown
// cost and a cost of zero look identical in a table and only one is true.

import { test } from "node:test";
import assert from "node:assert/strict";

import { reviewSample, shadowMetrics } from "../src/shadow-metrics.js";

const turn = (over = {}) => ({
  ts: "2026-07-28T12:00:00.000Z",
  turnId: "run-1",
  internalTurnId: "t_a_1",
  trafficClass: "human",
  claimExtractionStatus: "extracted",
  claimExtractionId: "cx_1",
  claimExtractionCompletedAt: "2026-07-28T12:00:05.000Z",
  claimExtractionLatencyMs: 2000,
  claimExtractionLagMs: 20,
  claimCount: 2,
  materialClaimCount: 1,
  ...over,
});

const record = (over = {}) => ({
  extractionId: "cx_1",
  status: "extracted",
  latencyMs: 2000,
  lagMs: 20,
  claims: [{ claimType: "current_external" }, { claimType: "stable_general" }],
  provenance: { usage: { inputTokens: 100, outputTokens: 400 } },
  ...over,
});

const store = (records) => new Map(records.map((r) => [r.extractionId, r]));

// ---------------------------------------------------------------------------
// Coverage is over eligible traffic only
// ---------------------------------------------------------------------------

test("excluded traffic is not counted against coverage", () => {
  // A heartbeat correctly skipped is not a missed extraction. Counting it would
  // make the completion rate depend on the heartbeat interval.
  const m = shadowMetrics([
    turn(),
    turn({ trafficClass: "heartbeat", claimExtractionStatus: "skipped", claimExtractionId: null }),
    turn({ trafficClass: "scheduled_automation", claimExtractionStatus: "skipped", claimExtractionId: null }),
  ], store([record()]));

  assert.equal(m.overall.eligibleTurns, 1);
  assert.equal(m.overall.extractionsScheduled, 1);
  assert.equal(m.overall.completionRate, 1);
  assert.equal(m.byTraffic.heartbeat, undefined, "excluded classes do not get a bucket");
});

test("an eligible turn that was skipped counts as eligible but not as scheduled", () => {
  const m = shadowMetrics([turn({ claimExtractionStatus: "skipped", claimExtractionId: null })], null);
  assert.equal(m.overall.eligibleTurns, 1);
  assert.equal(m.overall.extractionsScheduled, 0);
  assert.equal(m.overall.byStatus.skipped, 1);
  assert.equal(m.overall.completionRate, null, "no denominator, so no rate");
});

// ---------------------------------------------------------------------------
// Completion, and what only the store can see
// ---------------------------------------------------------------------------

test("a scheduled record that never completed is a loss, not a completion", () => {
  const m = shadowMetrics([turn()], store([record({ status: "scheduled" })]));
  assert.equal(m.overall.extractionsScheduled, 1);
  assert.equal(m.overall.extractionsCompleted, 0);
  assert.equal(m.overall.pendingOrLost, 1);
  assert.equal(m.overall.completionRate, 0);
});

test("without the extraction store, completion falls back to the turn record", () => {
  const withStamp = shadowMetrics([turn()], null);
  assert.equal(withStamp.overall.extractionsCompleted, 1);
  assert.equal(withStamp.basis.extractionStoreRead, false);

  const withoutStamp = shadowMetrics([turn({ claimExtractionCompletedAt: null })], null);
  assert.equal(withoutStamp.overall.extractionsCompleted, 0);
});

test("abstention reasons are separated into the ones about the draft and the ones about the provider", () => {
  const m = shadowMetrics([
    turn({ claimExtractionStatus: "abstained", claimExtractionAbstentionReason: "provider_error" }),
    turn({ claimExtractionStatus: "abstained", claimExtractionAbstentionReason: "timeout" }),
    turn({ claimExtractionStatus: "abstained", claimExtractionAbstentionReason: "malformed_output" }),
    turn({ claimExtractionStatus: "abstained", claimExtractionAbstentionReason: "non_atomic_claims" }),
  ], null);

  assert.equal(m.overall.providerErrors, 1);
  assert.equal(m.overall.timeouts, 1);
  assert.equal(m.overall.malformedOutput, 1);
  assert.equal(m.overall.abstentions.non_atomic_claims, 1, "composite decomposition failures are their own count");
});

// ---------------------------------------------------------------------------
// Nothing unknown is reported as zero
// ---------------------------------------------------------------------------

test("cost is null unless prices were supplied", () => {
  const m = shadowMetrics([turn()], store([record()]));
  assert.equal(m.overall.cost.total, null);
  assert.equal(m.overall.cost.perExtraction, null);
  assert.equal(m.basis.pricingSupplied, false);
});

test("cost is computed from supplied prices, and says how much of it is known", () => {
  const m = shadowMetrics(
    [turn(), turn({ turnId: "run-2", claimExtractionId: "cx_2" })],
    store([record(), record({ extractionId: "cx_2", provenance: {} })]),
    { pricing: { inputPerMillion: 0.27, outputPerMillion: 1.1 } },
  );
  assert.ok(m.overall.cost.total > 0);
  assert.equal(m.overall.cost.tokensKnownFor, 1);
  assert.equal(m.overall.cost.tokensUnknownFor, 1, "a record with no usage is counted, not ignored");
});

test("percentiles over an empty sample are null, not zero", () => {
  const m = shadowMetrics([turn({ claimExtractionStatus: "skipped", claimExtractionId: null })], null);
  assert.equal(m.overall.latencyMs.p50, null);
  assert.equal(m.overall.latencyMs.samples, 0);
  assert.equal(m.overall.claimsPerTurn, null);
});

test("latency percentiles use nearest-rank over the samples present", () => {
  const turns = [10, 20, 30, 40, 100].map((ms, i) =>
    turn({ turnId: `run-${i}`, claimExtractionId: `cx_${i}`, claimExtractionLatencyMs: ms }));
  const m = shadowMetrics(turns, null);
  assert.equal(m.overall.latencyMs.samples, 5);
  assert.equal(m.overall.latencyMs.p50, 30);
  assert.equal(m.overall.latencyMs.p99, 100);
});

// ---------------------------------------------------------------------------
// Claim shape
// ---------------------------------------------------------------------------

test("claims by epistemic type come from the store, because telemetry has no claims", () => {
  const withStore = shadowMetrics([turn()], store([record()]));
  assert.deepEqual(withStore.overall.claimsByType, { current_external: 1, stable_general: 1 });

  const without = shadowMetrics([turn()], null);
  assert.deepEqual(without.overall.claimsByType, {}, "and are simply absent without it");
});

test("material claims per turn is over extractions, not over all eligible turns", () => {
  const m = shadowMetrics([
    turn(),
    turn({ turnId: "run-2", claimExtractionStatus: "skipped", claimExtractionId: null }),
  ], store([record()]));
  assert.equal(m.overall.claimsPerTurn, 2, "one extraction, two claims");
  assert.equal(m.overall.materialClaimsPerTurn, 1);
});

test("numbers are reported per traffic class as well as overall", () => {
  const m = shadowMetrics([
    turn(),
    turn({ trafficClass: "synthetic_test", turnId: "run-2", claimExtractionId: "cx_2", claimCount: 4, materialClaimCount: 4 }),
  ], store([record(), record({ extractionId: "cx_2" })]));

  assert.equal(m.overall.claims, 6);
  assert.equal(m.byTraffic.human.claims, 2);
  assert.equal(m.byTraffic.synthetic_test.claims, 4);
});

// ---------------------------------------------------------------------------
// The review sample
// ---------------------------------------------------------------------------

test("the sample is stratified, and says where it fell short", () => {
  // The interesting groups are rare, which is the whole reason for stratifying:
  // an all-material extraction would appear once or twice in fifty random
  // turns, and it is one of the two the materiality judge is most likely to get
  // wrong.
  const turns = [
    turn({ turnId: "a", claimCount: 1, materialClaimCount: 1 }),
    turn({ turnId: "b", claimCount: 3, materialClaimCount: 3 }),
    turn({ turnId: "c", claimExtractionStatus: "no_claims", claimCount: 0, materialClaimCount: 0 }),
  ];
  const out = reviewSample(turns, store([record()]), {
    quotas: { conversational: 2, single_claim: 2, multi_claim: 2, all_material: 2 },
  });

  assert.equal(out.poolSize, 3);
  assert.equal(out.sample.conversational.found, 1);
  assert.equal(out.sample.conversational.short, 1, "a group that could not be filled says so");
  assert.equal(out.sample.single_claim.turns[0].turnId, "a");
});

test("a turn appears in at most one sample group", () => {
  const turns = Array.from({ length: 6 }, (_, i) =>
    turn({ turnId: `r${i}`, claimCount: 1, materialClaimCount: 1 }));
  const out = reviewSample(turns, null, {
    quotas: { single_claim: 3, all_material: 3 },
  });
  const ids = Object.values(out.sample).flatMap((g) => g.turns.map((t) => t.turnId));
  assert.equal(new Set(ids).size, ids.length, "no turn is reviewed twice under two headings");
});

test("the sample carries no claim text", () => {
  const out = reviewSample([turn()], store([record()]), { quotas: { single_claim: 1, multi_claim: 1 } });
  assert.doesNotMatch(JSON.stringify(out), /claimType/);
  assert.doesNotMatch(JSON.stringify(out), /surfaceText/);
});

test("the sample only draws from eligible traffic", () => {
  const out = reviewSample([
    turn({ turnId: "h", trafficClass: "heartbeat" }),
    turn({ turnId: "x", claimCount: 1 }),
  ], null, { quotas: { single_claim: 5 } });
  assert.equal(out.poolSize, 1);
  assert.deepEqual(out.sample.single_claim.turns.map((t) => t.turnId), ["x"]);
});
