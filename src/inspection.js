// Offline join: one turn, its claims, and the evidence it actually holds.
//
// This is the last step before claim verification, and it is deliberately the
// dullest thing in the package. It reads two stores that already exist, matches
// them by recorded id, checks that what is on disk is what was written, and
// says what it found. It does not retrieve, does not call a model, does not
// touch a response, and does not decide whether any claim holds.
//
// The one temptation it exists to refuse: a turn that called a search tool and
// stored four excerpts looks, from a distance, like a turn whose answer was
// supported. It is not. `supportLabels` stays empty here and `claimSupported`
// stays null, exactly as they do in the capture path, because the whole point
// of the exercise is to measure how often the two come apart. A join that
// filled them in would be measuring itself.
//
// Failure modes are kept apart rather than collapsed into "no evidence":
//
//   missing        the id was recorded, the file is not there
//   expired        the file is gone and the turn is older than retention,
//                  so pruning is the explanation and nothing is wrong
//   unreadable     the file is there and cannot be parsed
//   corrupt        the file parses and its excerpt no longer hashes to what
//                  was recorded
//
// The difference between the first two is the difference between a bug and a
// retention policy working, and a corpus that cannot tell them apart will spend
// a day looking for the bug.

import { createHash } from "node:crypto";

export const INSPECTION_SCHEMA_VERSION = "claim-evidence-inspection-v1";

/**
 * How a turn's evidence resolved, worst first.
 *
 * Precedence is by how much the result should be distrusted, not by how
 * interesting it is. An integrity failure means the store is telling us
 * something untrue, which outranks an abstention — abstention is an expected,
 * measured outcome, and a corrupt store is a fault in the instrument.
 */
export const JOIN_STATUSES = Object.freeze([
  "integrity_failure",
  "partially_missing",
  "evidence_expired",
  "extraction_pending",
  "extraction_lost",
  "claim_extraction_abstained",
  "no_evidence",
  "complete",
]);

/**
 * How a turn's extraction resolved.
 *
 * `pending` and `lost` are the two the settlement window exists to separate.
 * Extraction runs after delivery, so a turn record can be written and read
 * before the extraction store has caught up — and an inspector that read that
 * as loss would report a completion failure on every turn it happened to catch
 * mid-flight. Past the window, an extraction that announced itself and never
 * finished is a real loss: the process died holding it.
 */
export const EXTRACTION_RESOLUTIONS = Object.freeze([
  "complete",
  "pending",
  "lost",
  "missing",
  "expired",
  "unreadable",
  "not_run",
]);

/**
 * How long after a turn an unwritten extraction is still merely late.
 *
 * Sixty seconds against a twenty-second extraction timeout: three times the
 * ceiling, so a record that has not appeared is not simply slow.
 */
export const DEFAULT_SETTLEMENT_MS = 60_000;

/** How one referenced excerpt resolved. */
export const EVIDENCE_RESOLUTIONS = Object.freeze([
  "resolved",
  "missing",
  "expired",
  "unreadable",
  "corrupt",
]);

const DAY_MS = 24 * 60 * 60 * 1000;

function sha256(text) {
  return `sha256:${createHash("sha256").update(String(text ?? ""), "utf8").digest("hex")}`;
}

function parseTime(value) {
  const t = Date.parse(String(value ?? ""));
  return Number.isFinite(t) ? t : null;
}

/**
 * Resolve one recorded evidence id.
 *
 * `read` returns `{ok: true, record}`, `{ok: false, reason: "missing"}` or
 * `{ok: false, reason: "unreadable"}`. Anything else is treated as unreadable:
 * an unrecognised failure is not a reason to assume the evidence was fine.
 */
async function resolveEvidence(evidenceId, { read, prunedBefore }) {
  let out;
  try {
    out = await read(evidenceId);
  } catch {
    return { evidenceId, resolution: "unreadable", detail: "read threw" };
  }

  if (!out?.ok) {
    const missing = out?.reason === "missing";
    if (!missing) return { evidenceId, resolution: "unreadable", detail: out?.reason ?? "unknown" };
    // A file that is gone from a turn old enough to have been pruned is not
    // lost. Reporting it as missing would make every corpus older than the
    // retention window look broken.
    if (prunedBefore !== null) {
      return { evidenceId, resolution: "expired", detail: "older than the retention window" };
    }
    return { evidenceId, resolution: "missing", detail: "no such evidence record" };
  }

  const record = out.record;
  const recorded = record?.excerptHash ?? null;
  if (!recorded) {
    return { evidenceId, resolution: "corrupt", detail: "record carries no excerpt hash" };
  }
  const actual = sha256(record.excerpt);
  if (actual !== recorded) {
    return { evidenceId, resolution: "corrupt", detail: "excerpt does not match its recorded hash" };
  }

  return {
    evidenceId,
    resolution: "resolved",
    detail: null,
    tool: record.tool ?? null,
    sourceType: record.sourceType ?? null,
    evidenceView: record.evidenceView ?? null,
    transformsApplied: [...(record.transformsApplied ?? [])],
    capturedAt: record.capturedAt ?? null,
    source: record.source ?? null,
    title: record.title ?? null,
    query: record.query ?? null,
    redacted: Boolean(record.redacted),
    truncated: Boolean(record.truncated),
    excerptHash: recorded,
    // The excerpt itself is deliberately not copied here. Inspection output is
    // a join, not a second copy of the evidence store, and an excerpt in it
    // would be verbatim third-party content with no retention of its own.
    excerptChars: typeof record.excerpt === "string" ? record.excerpt.length : 0,
    // Never inferred, never filled in. A stored excerpt says nothing about
    // whether a claim holds.
    claimSupported: null,
  };
}

function joinStatusFor(evidence, extraction, referenced) {
  const has = (r) => evidence.some((e) => e.resolution === r);
  if (has("corrupt") || has("unreadable")) return "integrity_failure";
  if (has("missing")) return "partially_missing";
  if (has("expired")) return "evidence_expired";
  // An extraction that announced itself and never finished outranks an
  // abstention: abstention is an answer, this is the absence of one.
  if (extraction?.resolution === "lost" || extraction?.resolution === "unreadable") return "extraction_lost";
  if (extraction?.resolution === "pending") return "extraction_pending";
  if (extraction?.status === "abstained") return "claim_extraction_abstained";
  if (referenced === 0) return "no_evidence";
  return "complete";
}

/**
 * Resolve the turn's extraction record, if it claimed to have one.
 *
 * A turn that was never eligible has nothing to resolve and says `not_run`.
 * That is not a gap.
 */
async function resolveExtraction(turn, { read, now, settlementMs, prunedBefore }) {
  const id = turn?.claimExtractionId ?? null;
  const declared = turn?.claimExtractionStatus ?? null;

  if (!id) {
    return {
      extractionId: null,
      resolution: declared && declared !== "skipped" ? "missing" : "not_run",
      status: declared ?? "not_run",
      skipReason: turn?.claimExtractionSkipReason ?? null,
      claims: [],
    };
  }
  if (typeof read !== "function") {
    // No reader supplied: report what the turn said, and do not pretend to have
    // checked the store.
    return { extractionId: id, resolution: "not_run", status: declared, claims: [] };
  }

  let out;
  try {
    out = await read(id);
  } catch {
    return { extractionId: id, resolution: "unreadable", status: declared, claims: [] };
  }

  if (!out?.ok) {
    if (out?.reason !== "missing") {
      return { extractionId: id, resolution: "unreadable", status: declared, claims: [] };
    }
    if (prunedBefore !== null) {
      return { extractionId: id, resolution: "expired", status: declared, claims: [] };
    }
    const turnAt = parseTime(turn?.ts);
    const settled = turnAt === null || now - turnAt > settlementMs;
    return { extractionId: id, resolution: settled ? "missing" : "pending", status: declared, claims: [] };
  }

  const record = out.record ?? {};
  // Written, announced, and never finished. The process did not survive it.
  if (record.status === "scheduled") {
    const scheduledAt = parseTime(record.scheduledAt);
    const settled = scheduledAt === null || now - scheduledAt > settlementMs;
    return {
      extractionId: id,
      resolution: settled ? "lost" : "pending",
      status: "scheduled",
      scheduledAt: record.scheduledAt ?? null,
      claims: [],
    };
  }

  return {
    extractionId: id,
    resolution: "complete",
    status: record.status ?? declared,
    abstentionReason: record.abstentionReason ?? null,
    scheduledAt: record.scheduledAt ?? null,
    startedAt: record.startedAt ?? null,
    completedAt: record.completedAt ?? null,
    lagMs: record.lagMs ?? null,
    latencyMs: record.latencyMs ?? null,
    claimCount: record.claimCount ?? 0,
    materialClaimCount: record.materialClaimCount ?? 0,
    provenance: record.provenance ?? null,
    claims: record.claims ?? [],
  };
}

/**
 * Join one turn record to its evidence.
 *
 * @param {object} turn a record from the turn telemetry store
 * @param {{
 *   readEvidence: (id: string) => Promise<{ok: boolean, record?: object, reason?: string}>,
 *   extraction?: {status: string, claims?: object[], abstentionReason?: string}|null,
 *   retentionDays?: number,
 *   now?: () => number,
 * }} opts
 */
export async function inspectTurn(turn, opts = {}) {
  const read = opts.readEvidence;
  if (typeof read !== "function") throw new TypeError("inspectTurn requires readEvidence");

  const retentionDays = Number.isFinite(opts.retentionDays) ? opts.retentionDays : 14;
  const now = typeof opts.now === "function" ? opts.now() : Date.now();
  const turnAt = parseTime(turn?.ts);
  // Null unless this turn is old enough for pruning to explain a missing file.
  const prunedBefore = turnAt !== null && turnAt < now - retentionDays * DAY_MS ? turnAt : null;

  // Strictly the recorded ids, in the recorded order. Not a directory listing:
  // evidence that the turn does not reference is not this turn's evidence, and
  // ordering is the only thing that says which retrieval came first.
  const ids = Array.isArray(turn?.evidenceIds) ? turn.evidenceIds.filter((id) => typeof id === "string") : [];

  const evidence = [];
  for (const id of ids) {
    evidence.push(await resolveEvidence(id, { read, prunedBefore }));
  }

  const settlementMs = Number.isFinite(opts.settlementMs) ? opts.settlementMs : DEFAULT_SETTLEMENT_MS;
  const extraction = opts.extraction
    ? {
        resolution: "complete",
        status: opts.extraction.status ?? "not_run",
        claims: opts.extraction.claims ?? [],
        ...(opts.extraction.abstentionReason ? { abstentionReason: opts.extraction.abstentionReason } : {}),
      }
    : await resolveExtraction(turn, {
        read: opts.readExtraction,
        now,
        settlementMs,
        prunedBefore,
      });

  const counts = Object.fromEntries(
    EVIDENCE_RESOLUTIONS.map((r) => [r, evidence.filter((e) => e.resolution === r).length]),
  );

  return {
    schemaVersion: INSPECTION_SCHEMA_VERSION,
    // The join identity. Host identifiers are carried as metadata only: they
    // are how the turn was named by whichever hook saw it, and two of them can
    // name the same turn.
    internalTurnId: turn?.internalTurnId ?? null,
    turnId: turn?.turnId ?? null,
    sessionId: turn?.sessionId ?? null,
    agentId: turn?.agentId ?? null,
    ts: turn?.ts ?? null,
    pluginVersion: turn?.pluginVersion ?? null,
    behaviorEpoch: turn?.behaviorEpoch ?? null,

    // The stored decision, copied. Not recomputed, and not derived from the
    // session id sitting next to it.
    trafficClass: turn?.trafficClass ?? null,
    trafficResolutionStatus: turn?.trafficResolutionStatus ?? null,

    draft: turn?.draft ?? null,
    final: turn?.final ?? null,

    // What the turn said about extraction, and what the store actually holds.
    // Claim text is not copied here, for the same reason excerpt text is not:
    // this is a join, not a second copy of a store with its own retention.
    claimExtraction: {
      ...extraction,
      claims: undefined,
      claimCount: extraction.claimCount ?? (extraction.claims ?? []).length,
    },

    evidence,
    evidenceCounts: counts,
    evidenceReferenced: ids.length,
    // What capture itself said, so a join that finds two excerpts on a turn
    // that reported four losses does not read as a healthy turn.
    evidenceCaptureStatus: turn?.evidenceCaptureStatus ?? null,
    evidenceCaptureLostCount: turn?.evidenceCaptureLostCount ?? 0,

    joinStatus: joinStatusFor(evidence, extraction, ids.length),
    // Left empty by construction. Nothing in this file may write to it: a label
    // here would be an assertion about support derived from the presence of
    // evidence, which is the exact error the project exists to measure.
    supportLabels: [],
  };
}

/**
 * Join many turns, in the order given.
 *
 * Sequential on purpose. This reads a private evidence store on a machine that
 * is also serving an agent, and the work is not urgent enough to be worth
 * competing for its disk.
 */
export async function inspectTurns(turns, opts = {}) {
  const out = [];
  for (const turn of turns ?? []) out.push(await inspectTurn(turn, opts));
  return out;
}

/** Counts by join status, for a corpus summary. */
export function summarizeInspections(inspections) {
  const byStatus = Object.fromEntries(JOIN_STATUSES.map((s) => [s, 0]));
  const byExtraction = Object.fromEntries(EXTRACTION_RESOLUTIONS.map((s) => [s, 0]));
  const byTraffic = {};
  let referenced = 0;
  let resolved = 0;
  for (const i of inspections ?? []) {
    if (i?.joinStatus in byStatus) byStatus[i.joinStatus] += 1;
    const ex = i?.claimExtraction?.resolution;
    if (ex in byExtraction) byExtraction[ex] += 1;
    const cls = i?.trafficClass ?? "unknown";
    byTraffic[cls] = (byTraffic[cls] ?? 0) + 1;
    referenced += i?.evidenceReferenced ?? 0;
    resolved += i?.evidenceCounts?.resolved ?? 0;
  }
  return {
    turns: (inspections ?? []).length,
    byStatus,
    byExtraction,
    byTraffic,
    evidenceReferenced: referenced,
    evidenceResolved: resolved,
  };
}
