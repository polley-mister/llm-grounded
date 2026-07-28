// The shadow observation numbers, computed from the two stores.
//
// Everything here is arithmetic over records that already exist. Nothing is
// estimated, nothing is imputed, and where a number cannot be computed from
// what is on disk it is reported as null rather than as zero — a cost of zero
// and an unknown cost look identical in a table, and only one of them is true.
//
// One rule that shapes the whole file: coverage is measured over *eligible*
// turns. A heartbeat that was correctly excluded is not a missed extraction,
// and counting it as one would make the completion rate a function of how
// often the heartbeat runs.

/** Traffic that shadow extraction is expected to run on. */
const DEFAULT_ELIGIBLE = Object.freeze(["human", "synthetic_test"]);

/** Abstention reasons that mean the provider or the budget failed, not the draft. */
const INFRASTRUCTURE_REASONS = Object.freeze(["provider_error", "timeout", "output_truncated", "empty_output"]);

function percentile(sorted, p) {
  if (!sorted.length) return null;
  // Nearest-rank. With tens of samples an interpolated percentile implies a
  // precision the sample size does not have.
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

function rate(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

function emptyBucket() {
  return {
    // Three denominators, because one number cannot answer "was extraction
    // working" and "how much traffic has this deployment seen".
    //
    // Reporting 3 scheduled against 50 eligible reads as a 6% scheduling rate.
    // It is not: 47 of those turns predate extraction being enabled at all, and
    // a turn that ran before the feature existed was never a candidate. The
    // completion denominator is turns actually expected to schedule.
    eligibleTurns: 0,
    eligibleSinceExtractionEnabled: 0,
    eligibleInWindow: 0,
    // Scheduled and completed under the current configuration, which is what
    // the rates below are computed from. The all-time totals are kept beside
    // them for reference and are deliberately not used as a numerator: an
    // all-time count over an in-window denominator is the same category of
    // error as the one this whole split exists to remove.
    scheduledInWindow: 0,
    completedInWindow: 0,
    extractionsScheduled: 0,
    extractionsCompleted: 0,
    completionRate: null,
    pendingOrLost: 0,
    byStatus: { extracted: 0, no_claims: 0, abstained: 0, skipped: 0 },
    abstentions: {},
    malformedOutput: 0,
    providerErrors: 0,
    timeouts: 0,
    claims: 0,
    materialClaims: 0,
    claimsPerTurn: null,
    // How often the extractor labelled a claim material. A prevalence
    // statistic about its own output, and nothing more.
    //
    // It is not precision. Precision needs a human to say whether those labels
    // were correct, and recall needs a human to say what was missed. Both are
    // carried as explicit nulls rather than omitted, so a reader cannot mistake
    // this rate for either of them.
    materialLabelRate: null,
    materialityPrecision: null,
    materialityRecall: null,
    claimPrecision: null,
    claimRecall: null,
    claimsByType: {},
    latencyMs: { p50: null, p90: null, p95: null, p99: null, samples: 0 },
    lagMs: { p50: null, p95: null, samples: 0 },
    tokens: { input: 0, output: 0, reasoning: 0, cached: 0, known: 0, unknown: 0 },
    cost: { perExtraction: null, total: null, currency: null },
    _latencies: [],
    _lags: [],
  };
}

function finalize(bucket, pricing) {
  // Both rates are window over window. Nothing here mixes an all-time count
  // with an in-window one.
  bucket.completionRate = rate(bucket.completedInWindow, bucket.scheduledInWindow);
  bucket.schedulingRate = rate(bucket.scheduledInWindow, bucket.eligibleInWindow);
  bucket.completionRateAllTime = rate(bucket.extractionsCompleted, bucket.extractionsScheduled);
  bucket.claimsPerTurn = rate(bucket.claims, bucket.byStatus.extracted);
  bucket.materialClaimsPerTurn = rate(bucket.materialClaims, bucket.byStatus.extracted);
  bucket.materialLabelRate = rate(bucket.materialClaims, bucket.claims);
  // Left null deliberately. Nothing computable from these two stores can fill
  // them in; they need labelled turns. See docs/SHADOW-OBSERVATION.md.
  bucket.materialityPrecision = null;
  bucket.materialityRecall = null;
  bucket.claimPrecision = null;
  bucket.claimRecall = null;

  const lat = bucket._latencies.sort((a, b) => a - b);
  bucket.latencyMs = {
    p50: percentile(lat, 50), p90: percentile(lat, 90),
    p95: percentile(lat, 95), p99: percentile(lat, 99), samples: lat.length,
  };
  const lag = bucket._lags.sort((a, b) => a - b);
  bucket.lagMs = { p50: percentile(lag, 50), p95: percentile(lag, 95), samples: lag.length };

  if (pricing) {
    const total =
      (bucket.tokens.input / 1e6) * pricing.inputPerMillion +
      (bucket.tokens.output / 1e6) * pricing.outputPerMillion;
    bucket.cost = {
      perExtraction: rate(total, bucket.extractionsCompleted),
      total,
      currency: pricing.currency ?? "USD",
      // Stated, because a cost computed over records whose usage the provider
      // did not report is a cost over a subset pretending to be the whole.
      tokensKnownFor: bucket.tokens.known,
      tokensUnknownFor: bucket.tokens.unknown,
    };
  }

  delete bucket._latencies;
  delete bucket._lags;
  return bucket;
}

/**
 * Compute the observation numbers.
 *
 * @param {object[]} turns telemetry records
 * @param {Map<string, object>|null} extractions extraction records by id, when the store was read
 * @param {{eligible?: string[], pricing?: {inputPerMillion: number, outputPerMillion: number, currency?: string}}} [opts]
 */
export function shadowMetrics(turns, extractions = null, opts = {}) {
  const eligible = new Set(opts.eligible ?? DEFAULT_ELIGIBLE);
  const pricing = opts.pricing ?? null;
  // The window the current configuration has been in force for. Given as a
  // behaviour epoch because that is the thing that changes when the deployment
  // does, and it is already on every record.
  const windowEpoch = opts.windowEpoch ?? null;

  const overall = emptyBucket();
  const byTraffic = {};
  const byEpoch = {};

  for (const turn of turns ?? []) {
    const cls = turn?.trafficClass ?? "unknown";
    // Excluded traffic is not counted against coverage: a heartbeat correctly
    // skipped is not a missed extraction.
    if (!eligible.has(cls)) continue;

    byTraffic[cls] ??= emptyBucket();
    const buckets = [overall, byTraffic[cls]];
    for (const b of buckets) b.eligibleTurns += 1;

    const epoch = turn?.behaviorEpoch ?? "unknown";
    byEpoch[epoch] ??= { eligible: 0, scheduled: 0, completed: 0 };
    byEpoch[epoch].eligible += 1;

    const status = turn?.claimExtractionStatus ?? null;
    // The field only exists once the extraction code is present, so its absence
    // is how a turn from before the feature identifies itself.
    const extractionCodeLive = status !== null && status !== undefined;
    const inWindow = windowEpoch === null ? extractionCodeLive : epoch === windowEpoch;
    for (const b of buckets) {
      if (extractionCodeLive) b.eligibleSinceExtractionEnabled += 1;
      if (inWindow) b.eligibleInWindow += 1;
    }

    if (!status || status === "skipped") {
      for (const b of buckets) b.byStatus.skipped += 1;
      continue;
    }
    byEpoch[epoch].scheduled += 1;

    for (const b of buckets) {
      b.extractionsScheduled += 1;
      if (inWindow) b.scheduledInWindow += 1;
      if (status in b.byStatus) b.byStatus[status] += 1;
    }

    // Completion is judged from the extraction store when it was read, and from
    // the turn record otherwise. A turn record exists only if agent_end
    // finished, so on its own it cannot see an extraction that was killed
    // mid-flight — that is exactly what the scheduled-first record is for.
    const record = extractions?.get(turn?.claimExtractionId) ?? null;
    const completed = extractions
      ? Boolean(record) && record.status !== "scheduled"
      : Boolean(turn?.claimExtractionCompletedAt);
    for (const b of buckets) {
      if (completed) {
        b.extractionsCompleted += 1;
        if (inWindow) b.completedInWindow += 1;
      } else {
        b.pendingOrLost += 1;
      }
    }
    if (completed) byEpoch[epoch].completed += 1;
    if (!completed) continue;

    const reason = turn?.claimExtractionAbstentionReason ?? record?.abstentionReason ?? null;
    if (status === "abstained" && reason) {
      for (const b of buckets) {
        b.abstentions[reason] = (b.abstentions[reason] ?? 0) + 1;
        if (reason === "malformed_output") b.malformedOutput += 1;
        if (reason === "provider_error") b.providerErrors += 1;
        if (reason === "timeout") b.timeouts += 1;
      }
    }

    for (const b of buckets) {
      b.claims += turn?.claimCount ?? 0;
      b.materialClaims += turn?.materialClaimCount ?? 0;
      const latency = turn?.claimExtractionLatencyMs ?? record?.latencyMs ?? null;
      if (Number.isFinite(latency)) b._latencies.push(latency);
      const lag = turn?.claimExtractionLagMs ?? record?.lagMs ?? null;
      if (Number.isFinite(lag)) b._lags.push(lag);
    }

    // Epistemic types and token usage need the record: telemetry carries counts
    // and a reference, never the claims.
    if (record) {
      for (const claim of record.claims ?? []) {
        const type = claim?.claimType ?? "unknown";
        for (const b of buckets) b.claimsByType[type] = (b.claimsByType[type] ?? 0) + 1;
      }
      const usage = record.provenance?.usage ?? null;
      for (const b of buckets) {
        if (!usage) { b.tokens.unknown += 1; continue; }
        b.tokens.known += 1;
        b.tokens.input += usage.inputTokens ?? usage.promptTokens ?? 0;
        b.tokens.output += usage.outputTokens ?? usage.completionTokens ?? 0;
        b.tokens.reasoning += usage.reasoningTokens ?? 0;
        b.tokens.cached += usage.cacheReadTokens ?? 0;
      }
    } else {
      for (const b of buckets) b.tokens.unknown += 1;
    }
  }

  return {
    overall: finalize(overall, pricing),
    byTraffic: Object.fromEntries(Object.entries(byTraffic).map(([k, v]) => [k, finalize(v, pricing)])),
    // Per epoch, so the windows can be read directly rather than inferred from
    // a single collapsed rate.
    byEpoch,
    // What the numbers were computed from, so a table can never be read as
    // covering more than it does.
    basis: {
      eligibleClasses: [...eligible],
      extractionStoreRead: Boolean(extractions),
      pricingSupplied: Boolean(pricing),
      windowEpoch,
      infrastructureAbstentions: [...INFRASTRUCTURE_REASONS],
      // Stated in the output, not only in a document. Anyone reading this
      // object should be told what it cannot tell them.
      notMeasurable: [
        "materialityPrecision and materialityRecall: need human labels",
        "claimPrecision and claimRecall: need human labels",
        "support or entailment: not part of shadow extraction at all",
      ],
    },
  };
}

/**
 * A stratified review sample.
 *
 * Stratified rather than random because the interesting groups are rare: an
 * all-material extraction and a stored-personal claim would each appear once or
 * twice in fifty random turns, and those are the two the materiality judge is
 * most likely to be wrong about.
 *
 * Deterministic given the same input and seed, so a review can be repeated and
 * a second reviewer sees the same fifty turns.
 */
export function reviewSample(turns, extractions, opts = {}) {
  const quotas = opts.quotas ?? {
    conversational: 10,
    single_claim: 10,
    multi_claim: 10,
    all_material: 5,
    current_external: 5,
    stored_personal: 5,
    failures_and_slowest: 5,
  };
  const eligible = new Set(opts.eligible ?? DEFAULT_ELIGIBLE);

  const rows = [];
  for (const turn of turns ?? []) {
    if (!eligible.has(turn?.trafficClass)) continue;
    const record = extractions?.get(turn?.claimExtractionId) ?? null;
    rows.push({ turn, record });
  }

  const types = (r) => new Set((r?.claims ?? []).map((c) => c?.claimType));
  const groups = {
    // A turn that extracted nothing, or asserted nothing checkable.
    conversational: (t, r) => t.claimExtractionStatus === "no_claims" || (r && (r.claims ?? []).length === 0),
    single_claim: (t) => (t.claimCount ?? 0) === 1,
    multi_claim: (t) => (t.claimCount ?? 0) > 1,
    all_material: (t) => (t.claimCount ?? 0) > 0 && t.claimCount === t.materialClaimCount,
    current_external: (_t, r) => types(r).has("current_external"),
    stored_personal: (_t, r) => types(r).has("stored_personal"),
    failures_and_slowest: (t) => t.claimExtractionStatus === "abstained",
  };

  const chosen = new Map();
  const sample = {};
  for (const [name, quota] of Object.entries(quotas)) {
    const predicate = groups[name];
    if (!predicate) continue;
    let candidates = rows.filter(({ turn, record }) => !chosen.has(turn.turnId) && predicate(turn, record));
    if (name === "failures_and_slowest") {
      // Failures first, then the slowest completions, since a near-ceiling
      // latency is the other thing worth reading by hand.
      const slow = rows
        .filter(({ turn }) => !chosen.has(turn.turnId) && Number.isFinite(turn.claimExtractionLatencyMs))
        .sort((a, b) => b.turn.claimExtractionLatencyMs - a.turn.claimExtractionLatencyMs);
      candidates = [...candidates, ...slow];
    }
    const picked = candidates.slice(0, quota);
    for (const row of picked) chosen.set(row.turn.turnId, name);
    sample[name] = {
      requested: quota,
      found: picked.length,
      // Reported rather than quietly short. A group that could not be filled is
      // a fact about the corpus, and the reviewer needs to know before drawing
      // a conclusion about it.
      short: Math.max(0, quota - picked.length),
      turns: picked.map(({ turn }) => ({
        internalTurnId: turn.internalTurnId ?? null,
        turnId: turn.turnId ?? null,
        ts: turn.ts ?? null,
        trafficClass: turn.trafficClass ?? null,
        claimExtractionId: turn.claimExtractionId ?? null,
        claimCount: turn.claimCount ?? 0,
        materialClaimCount: turn.materialClaimCount ?? 0,
        claimExtractionStatus: turn.claimExtractionStatus ?? null,
        claimExtractionLatencyMs: turn.claimExtractionLatencyMs ?? null,
      })),
    };
  }

  const requested = Object.values(quotas).reduce((a, b) => a + b, 0);
  const found = Object.values(sample).reduce((a, g) => a + g.found, 0);
  return { sample, requested, found, poolSize: rows.length };
}
