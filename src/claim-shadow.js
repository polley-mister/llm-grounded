// Claim extraction in production, with no authority whatsoever.
//
// This is the first thing in the package that adds a model call to the
// production turn lifecycle, and it is the last one that should be allowed to
// affect a turn. Everything here runs after the answer has already been
// delivered. It cannot revise, cannot retrieve, cannot refuse, cannot block,
// and cannot fail a turn: every path returns a record rather than throwing, and
// the caller ignores the return value.
//
// What it is for: measuring, on live traffic, the four numbers the offline
// corpus can only estimate — how often extraction abstains, how often it calls
// an incidental sentence a material claim, how often it fails to decompose a
// composite, and what it costs in wall-clock.
//
// What it must never become: a source of support labels. `claimSupported` stays
// null here as it does everywhere else. A claim extracted from a draft is a
// statement about the draft, not about the world, and the gap between those two
// is the entire measurement.
//
// Output goes to its own store, not into the turn record. Claims are verbatim
// sentences from an answer, which is the same category of content as an
// evidence excerpt and gets the same treatment: its own directory, its own
// retention, and a reference by id from the turn record rather than an inline
// copy.

import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { extractClaims } from "./claims.js";

export const CLAIM_SHADOW_SCHEMA_VERSION = "claim-extraction-shadow-v1";

/** Why a turn was not extracted from. Not the same as abstaining. */
export const SHADOW_SKIP_REASONS = Object.freeze([
  "disabled",
  "traffic_class_excluded",
  "no_final_text",
  "no_llm",
  "already_extracted",
]);

const REAL_FS = Object.freeze({ mkdir, writeFile });

/**
 * Statuses a stored extraction record can carry.
 *
 * `scheduled` is written *before* the model call and overwritten when it
 * returns. That costs a second small local write per extraction and buys the
 * only way to see a completion loss: if the gateway is restarted or the process
 * dies mid-call, the turn record is never written either — `agent_end` had not
 * finished — so nothing in telemetry would record that an extraction had been
 * started at all. A scheduled record left on disk is that evidence.
 *
 * Without it, a killed extraction is indistinguishable from a turn that was
 * never eligible, and completion rate cannot be measured.
 */
export const SHADOW_RECORD_STATUSES = Object.freeze([
  "scheduled",
  "extracted",
  "no_claims",
  "abstained",
]);

/** A skip: extraction never ran, and nothing was written. */
function skipped(reason, detail = null) {
  return { ran: false, extractionId: null, status: "skipped", skipReason: reason, detail };
}

/**
 * Run extraction for one finished turn.
 *
 * Never throws. A failure to write, a provider outage, a timeout and a
 * malformed reply are all outcomes, because the alternative is a shadow feature
 * with the power to break a turn that has already succeeded.
 *
 * @param {{
 *   cfg: object,
 *   entry: object,
 *   finalText: string,
 *   userTurn?: string,
 *   llm?: object,
 *   logger?: object,
 *   now?: () => number,
 *   extract?: Function,
 *   fsOps?: object,
 * }} input
 */
export async function runShadowExtraction(input) {
  const { cfg, entry, finalText, userTurn, llm, logger } = input;
  const now = typeof input.now === "function" ? input.now : () => Date.now();
  const extract = input.extract ?? extractClaims;

  try {
    if (!cfg?.claimExtractionEnabled) return skipped("disabled");

    // Extraction runs on the traffic the calibration is about. Heartbeats and
    // scheduled runs are excluded for the same reason capture excludes them:
    // volume without calibration value, and here it is volume that costs a
    // model call apiece.
    const trafficClass = entry?.traffic?.trafficClass ?? null;
    if (entry?.traffic?.status !== "resolved") {
      return skipped("traffic_class_excluded", "unresolved");
    }
    if (!(cfg.claimExtractionTrafficClasses ?? []).includes(trafficClass)) {
      return skipped("traffic_class_excluded", trafficClass);
    }

    // Once per turn. `agent_end` is latched already, but a second extraction
    // would be a second model call charged to a turn that is over.
    if (entry?.claimExtractionId) return skipped("already_extracted", entry.claimExtractionId);

    const draft = typeof finalText === "string" ? finalText.trim() : "";
    if (!draft) return skipped("no_final_text");

    if (!llm || typeof llm.complete !== "function") return skipped("no_llm");

    // The id is minted here, not at the end, because the scheduled record and
    // the completed one have to be the same file.
    const extractionId = `cx_${randomUUID()}`;
    const scheduledAt = now();
    const fsOps = input.fsOps ?? REAL_FS;

    // Announce the intent before spending anything on it. If this process does
    // not survive the call, this file is the only thing that will say the
    // extraction was ever attempted.
    await writeShadowRecord(
      cfg.claimExtractionDir,
      {
        schemaVersion: CLAIM_SHADOW_SCHEMA_VERSION,
        extractionId,
        status: "scheduled",
        scheduledAt: new Date(scheduledAt).toISOString(),
        startedAt: null,
        completedAt: null,
        internalTurnId: entry?.turnId ?? null,
        turnId: entry?.runId ?? entry?.sessionKey ?? null,
        trafficClass: entry?.traffic?.trafficClass ?? null,
        behaviorEpoch: cfg?.behaviorEpoch ?? null,
        claimSupported: null,
        supportLabels: [],
      },
      logger,
      fsOps,
    );

    const startedAt = now();
    const extraction = await extract(
      { draft, userTurn: typeof userTurn === "string" ? userTurn : "" },
      {
        llm,
        timeoutMs: cfg.claimExtractionTimeoutMs ?? 20000,
        maxTokens: cfg.claimExtractionMaxTokens ?? 16000,
        agentId: cfg.claimExtractionAgentId ?? null,
      },
    );
    const completedAt = now();
    const latencyMs = completedAt - startedAt;

    const record = buildShadowRecord({
      cfg, entry, extraction, draft, latencyMs, now,
      extractionId, scheduledAt, startedAt, completedAt,
    });
    const written = await writeShadowRecord(cfg.claimExtractionDir, record, logger, fsOps);
    if (!written.ok) {
      logger?.warn?.(`llmGrounded: claim extraction record not stored: ${written.reason}`);
      // The extraction happened; only the record did not. Say both.
      return {
        ran: true,
        // The id is still reported: the scheduled record may well be on disk
        // even though the completed one is not, and an inspector needs to be
        // able to find it.
        extractionId,
        status: extraction.status,
        skipReason: null,
        storeFailed: true,
        scheduledAt,
        startedAt,
        completedAt,
        lagMs: startedAt - scheduledAt,
        latencyMs,
        claimCount: record.claimCount,
        materialClaimCount: record.materialClaimCount,
        abstentionReason: record.abstentionReason,
      };
    }

    return {
      ran: true,
      extractionId: record.extractionId,
      status: extraction.status,
      skipReason: null,
      storeFailed: false,
      scheduledAt,
      startedAt,
      completedAt,
      // How long the turn waited between deciding to extract and the call
      // beginning. Distinct from latency: this is queueing and setup, and if it
      // grows it points somewhere entirely different.
      lagMs: startedAt - scheduledAt,
      latencyMs,
      claimCount: record.claimCount,
      materialClaimCount: record.materialClaimCount,
      abstentionReason: record.abstentionReason,
    };
  } catch (err) {
    // Deliberately swallowed, like evidence capture. A turn that has already
    // been delivered cannot be failed by its own bookkeeping.
    logger?.warn?.(`llmGrounded: claim extraction error: ${String(err?.message ?? err)}`);
    return { ran: false, extractionId: null, status: "error", skipReason: null, detail: String(err?.message ?? err) };
  }
}

/**
 * The stored record.
 *
 * Claims carry their own text, because a claim that cannot be read is not
 * reviewable and review is the point. The draft is stored alongside them for
 * the same reason — a claim without the sentence it came from cannot be judged
 * material or not. Both live here rather than in telemetry, which is the store
 * that must stay free of verbatim content.
 */
export function buildShadowRecord({
  cfg, entry, extraction, draft, latencyMs, now = () => Date.now(),
  extractionId, scheduledAt, startedAt, completedAt,
}) {
  const claims = extraction?.status === "extracted" ? extraction.claims ?? [] : [];
  const stamp = (v) => (Number.isFinite(v) ? new Date(v).toISOString() : null);
  return {
    schemaVersion: CLAIM_SHADOW_SCHEMA_VERSION,
    extractionId: extractionId ?? `cx_${randomUUID()}`,
    extractedAt: new Date(now()).toISOString(),

    // The lifecycle, so "not written yet" and "never finished" are different
    // observations rather than the same absence.
    scheduledAt: stamp(scheduledAt),
    startedAt: stamp(startedAt),
    completedAt: stamp(completedAt),
    lagMs: Number.isFinite(scheduledAt) && Number.isFinite(startedAt) ? startedAt - scheduledAt : null,

    // Joins to the turn. The internal id is the principal one; the host-derived
    // key is kept because evidence files reference that form.
    internalTurnId: entry?.turnId ?? null,
    turnId: entry?.runId ?? entry?.sessionKey ?? null,
    trafficClass: entry?.traffic?.trafficClass ?? null,
    behaviorEpoch: cfg?.behaviorEpoch ?? null,

    status: extraction?.status ?? "abstained",
    abstentionReason: extraction?.status === "abstained" ? extraction.reason ?? null : null,
    abstentionDetail: extraction?.status === "abstained" ? extraction.detail ?? null : null,
    provenance: extraction?.provenance ?? null,
    latencyMs,

    draft,
    claims,
    premises: extraction?.premises ?? [],
    claimCount: claims.length,
    materialClaimCount: claims.filter((c) => c?.material).length,
    verificationTargetCount: claims.filter((c) => c?.material && c?.verificationTarget).length,

    // Shadow means shadow. Nothing here was checked against anything, and a
    // consumer that wants support has to go and establish it.
    claimSupported: null,
    supportLabels: [],
  };
}

/** One file per extraction, 0600 in a 0700 directory, like every other store here. */
export async function writeShadowRecord(dir, record, logger, fsOps = REAL_FS) {
  if (!dir) return { ok: false, reason: "no claim extraction directory configured" };
  try {
    await fsOps.mkdir(dir, { recursive: true, mode: 0o700 });
    const target = path.join(dir, `${record.extractionId}.json`);
    await fsOps.writeFile(target, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    return { ok: true, path: target };
  } catch (err) {
    logger?.warn?.(`llmGrounded: claim extraction write failed: ${String(err?.message ?? err)}`);
    return { ok: false, reason: String(err?.message ?? err) };
  }
}

/**
 * Drop extractions past their retention window.
 *
 * Shorter than telemetry's by default, for the same reason evidence capture's
 * is: these records hold verbatim answer text.
 */
export async function pruneShadowExtractions(dir, retentionDays = 14, logger, now = () => Date.now()) {
  const cutoff = now() - Math.max(1, retentionDays) * 24 * 60 * 60 * 1000;
  let removed = 0;
  try {
    for (const name of await readdir(dir)) {
      if (!name.startsWith("cx_") || !name.endsWith(".json")) continue;
      const full = path.join(dir, name);
      const info = await stat(full);
      if (info.mtimeMs < cutoff) {
        await rm(full, { force: true });
        removed += 1;
      }
    }
  } catch (err) {
    if (err?.code !== "ENOENT") {
      logger?.warn?.(`llmGrounded: claim extraction prune failed: ${String(err?.message ?? err)}`);
    }
  }
  return removed;
}
