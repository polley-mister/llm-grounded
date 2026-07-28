// ---------------------------------------------------------------------------
// Phase 0 turn telemetry.
//
// Changes no behaviour. It exists so the authority change in Phase 1 has a
// real "before" measured with the same instrument as its "after" — and so
// Phase 4's claim extractor has drafts to calibrate against rather than
// guesses.
//
// Three fields carry most of the value and are easy to omit by accident:
//
//   features — which pattern lists matched, per tier. Without them a rule edit
//              orphans the whole corpus, because old records can no longer be
//              re-scored under the new rule.
//   draft    — the answer BEFORE any revision. The final text has already been
//              through the gates, so it cannot show what the gates changed.
//   tools    — names and params, so the disagreement set can be computed: the
//              turns where the chain would have compelled a tool and the model
//              reached for nothing.
//
// Everything here is best effort, on the evidence module's precedent: an
// unwritable directory degrades to "no telemetry" and must never fail a turn.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";

import { workspaceDir } from "./paths.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * Retention bound. The house rule is that nothing grows without a limit, and
 * this file accumulates one line per turn forever otherwise. Days rather than
 * bytes because the corpus is only useful while it reflects current code.
 */
const DEFAULT_RETENTION_DAYS = 30;

/** Conversation text is truncated: this is a measurement corpus, not a transcript store. */
const MAX_TEXT = 4000;

function clip(value, limit = MAX_TEXT) {
  const text = typeof value === "string" ? value : "";
  return text.length > limit ? `${text.slice(0, limit)}…[truncated]` : text;
}

function wordCount(text) {
  return String(text ?? "").trim().split(/\s+/).filter(Boolean).length;
}

/** One file per day keeps pruning trivial and files small enough to read by hand. */
function fileFor(dir, when) {
  const d = when instanceof Date ? when : new Date(when ?? Date.now());
  const stamp = [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("-");
  return path.join(dir, `turns-${stamp}.jsonl`);
}

// ---------------------------------------------------------------------------
// Provenance.
//
// A corpus is only comparable against itself. Without a version and a config
// hash on every line, a later edit to SOUL.md, a classifier rule, a gate limit
// or the model silently produces incompatible records inside the same daily
// file, and nothing downstream can tell which regime a turn belongs to.
//
// The restart that enabled this logger also enabled the voice gate, the
// settings-disclosure rule and the contraction fix, all of which had been
// installed but unloaded. That makes this a v1.9.0 full-stack baseline rather
// than a record of the older behaviour — which is exactly the kind of fact a
// fingerprint should carry rather than a README.
//
// Hashes only: prompt files contain the operator's private context and have no
// business being copied into a measurement corpus.
// ---------------------------------------------------------------------------

/** Prompt surfaces. A wording change alters behaviour without touching code. */
/**
 * Default prompt surfaces, used only when config supplies none. Overridable
 * through the `promptFiles` config key, which is how a non-OpenClaw host
 * points this at its own prompt sources.
 */
const DEFAULT_PROMPT_FILES = ["SOUL.md", "AGENTS.md"].map((f) => path.join(workspaceDir(), f));

/** Rule surfaces. An edit here changes decisions without touching the prompt. */
const RULESET_FILES = ["classify.js", "voice.js", "contract.js"];

let identityCache = null;

function sha(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

async function hashFiles(files, resolve) {
  const parts = [];
  for (const file of files) {
    try {
      parts.push(sha(await readFile(resolve ? resolve(file) : file, "utf8")));
    } catch {
      parts.push("absent");
    }
  }
  return sha(parts.join("|"));
}

/**
 * Behaviour identity for a record.
 *
 * Split rather than a single fingerprint so analysis can ask which surface
 * moved. A prompt edit and a rule edit both change behaviour, but they change
 * different things, and a combined hash only says "something differs".
 *
 * This is what makes rolling epochs work: development need not stop, because
 * every record carries the exact configuration that produced it. Freeze
 * interpretability, not progress.
 */
export async function behaviorIdentity(cfg, extra = {}) {
  if (identityCache) return { ...identityCache, model: extra.model ?? identityCache.model };
  const here = new URL(".", import.meta.url).pathname;
  const behaviour = {
    maxRevisions: cfg?.maxRevisions ?? null,
    maxVoiceRevisions: cfg?.maxVoiceRevisions ?? null,
    voiceMaxWords: cfg?.voiceMaxWords ?? null,
    maxFactRevisions: cfg?.maxFactRevisions ?? null,
    factsEnabled: cfg?.factsEnabled ?? null,
    enabledAgents: cfg?.enabledAgents ?? null,
  };
  identityCache = {
    behaviorEpoch: cfg?.behaviorEpoch ?? null,
    promptHash: `sha256:${await hashFiles(cfg?.promptFiles?.length ? cfg.promptFiles : DEFAULT_PROMPT_FILES)}`,
    rulesetHash: `sha256:${await hashFiles(RULESET_FILES, (f) => `${here}${f}`)}`,
    configHash: `sha256:${sha(JSON.stringify(behaviour))}`,
    model: extra.model ?? null,
  };
  return identityCache;
}

/** Reset between tests, and after any deliberate config change. */
export function resetFingerprint() {
  identityCache = null;
}

/**
 * Build the record from a completed turn's store entry.
 *
 * Kept pure so it can be unit tested without touching the filesystem, and so
 * the shape is asserted in tests rather than discovered later when Phase 4
 * finds a field missing.
 */
/**
 * Which build produced a record.
 *
 * Read from `build-info.json`, written into the artifact at pack time.
 * Deliberately not a config key: an operator-supplied commit is a *claim* about
 * what is deployed, and the reason to record it at all is to know what was
 * actually running when a turn was measured. A config value drifts silently the
 * moment someone repoints a path without editing it.
 *
 * Absent in a source checkout, which is honest — nothing was packed, so there
 * is no build to name.
 */
let buildInfoCache;
export function buildInfo(read = readFileSync) {
  if (buildInfoCache !== undefined) return buildInfoCache;
  try {
    const parsed = JSON.parse(read(new URL("../build-info.json", import.meta.url), "utf8"));
    buildInfoCache = {
      coreCommit: typeof parsed.commit === "string" ? parsed.commit : null,
      builtAt: typeof parsed.packedAt === "string" ? parsed.packedAt : null,
    };
  } catch {
    buildInfoCache = { coreCommit: null, builtAt: null };
  }
  return buildInfoCache;
}

/** Test seam: drop the memoised build info. */
export function resetBuildInfo() {
  buildInfoCache = undefined;
}

/**
 * Overall capture outcome for a turn.
 *
 * `partial` matters: at least one item stored and at least one eligible item
 * lost is a different state from either "worked" or "failed", and collapsing it
 * would hide systematic truncation behind an apparent success.
 */
function evidenceCaptureStatus(entry) {
  // A build that could not read its own configuration did not decline to
  // capture; it was unable to. Reporting that as not_applicable would make a
  // fault look like a legitimate choice, which is exactly what happened.
  if (entry?.runtimeConfigResolved === false) return "unavailable";
  // Same distinction, one layer along: a turn whose identity was never resolved
  // did not fall outside the capture policy, it never reached one.
  if (entry?.evidenceCaptureSkipReason === "traffic_class_unresolved") return "unavailable";
  if (!entry?.evidenceCaptureAttempted) return "not_applicable";
  const captured = entry.evidenceCapturedCount ?? 0;
  const lost = (entry.evidenceCaptureSkippedCount ?? 0) + (entry.evidenceCaptureFailedCount ?? 0);
  if (captured === 0) return "failed";
  return lost > 0 ? "partial" : "complete";
}

export function buildTurnRecord(entry, extra = {}) {
  const t = entry?.telemetry ?? {};
  const drafts = Array.isArray(t.drafts) ? t.drafts : [];
  return {
    ts: new Date(extra.now ?? Date.now()).toISOString(),
    // Provenance. Records without these cannot be safely compared across a
    // restart, a prompt edit, or a model change.
    pluginVersion: extra.pluginVersion ?? null,
    // Which implementation produced this turn, and from which build. Records
    // written either side of a cutover must be distinguishable without relying
    // on their timestamps.
    pluginId: extra.pluginId ?? null,
    implementation: extra.implementation ?? null,
    coreCommit: extra.coreCommit ?? null,
    // Behaviour identity, split by surface so analysis can attribute a change.
    behaviorEpoch: extra.identity?.behaviorEpoch ?? null,
    promptHash: extra.identity?.promptHash ?? null,
    rulesetHash: extra.identity?.rulesetHash ?? null,
    configHash: extra.identity?.configHash ?? null,

    // Turns produced by testing rather than use. Excluded from rates, kept so
    // the destructive paths stay verifiable without polluting the corpus.
    // Phase 1A: what the old classifier would have done, recorded without
    // authority. The decisive record is legacyWouldCompel true with no tool
    // used and the answer accepted — each one is a prevented failure.
    policyMode: extra.policy?.policyMode ?? null,
    hardTrigger: extra.policy?.hardTrigger ?? null,
    hardReason: extra.policy?.hardReason ?? null,
    correctionScope: extra.policy?.correctionScope ?? null,
    evidenceSource: extra.policy?.evidenceSource ?? null,
    policyScope: extra.policy?.policyScope ?? null,
    legacyVerdict: extra.policy?.legacyVerdict ?? null,
    legacyReason: extra.policy?.legacyReason ?? null,
    legacyWouldCompel: extra.policy?.legacyWouldCompel ?? null,
    actualToolUsed: Array.isArray(t.tools) && t.tools.length > 0,

    // The fact turn's two independent outcomes, and the policy that followed.
    // Kept separate deliberately: "did the operator's correction land" and "did
    // it reach durable storage" are different questions, and conflating them is
    // the bug this block exists to make measurable.
    correctionOutcome: extra.delivery?.correctionOutcome ?? null,
    persistenceOutcome: extra.delivery?.persistenceOutcome ?? null,
    responsePolicy: extra.delivery?.responsePolicy ?? null,
    correctionAppliedToResponse: Boolean(extra.delivery?.correctionAppliedToResponse),
    persistenceFailureNoted: Boolean(extra.delivery?.persistenceFailureNoted),
    sessionOverlayApplied: Boolean(extra.delivery?.sessionOverlayApplied),
    factCommitAttempted: (entry?.factCalls ?? 0) > 0 || entry?.factOutcome != null,
    factCommitSucceeded: entry?.factOutcome?.ok === true,
    // Repairs spent on a draft that falsely claimed the write succeeded. On its
    // own budget, and named for what it repairs: the defect is a false factual
    // assertion in the draft, not a defective note.
    persistenceClaimRevisions: entry?.persistenceClaimRevisions ?? 0,

    // Whether a delivery lane was actually seen to emit this text, and which
    // one. Finalize can only ever report what it resolved; delivery happens
    // afterwards. A record claiming to be "what shipped" without this would be
    // asserting something it cannot know.
    // Did a terminal host lane see this text, and which one. Distinct from
    // whether the plugin changed it: an ordinary pass-through turn is still
    // observed leaving.
    emissionObserved: Boolean(extra.emissionObserved),
    emittedLane: extra.emittedLane ?? null,
    // Whether it left through an outbound lane rather than only the transcript.
    // False on deliver:false, which is correct rather than a gap.
    externalDeliveryObserved: Boolean(extra.externalDeliveryObserved),
    deliveryAction: extra.deliveryAction ?? null,
    textMutatedByPlugin: Boolean(extra.textMutatedByPlugin),
    // Centralised delivery promises byte-identical text on every lane. True
    // here means that promise broke, and is a smoke-test failure.
    terminalTextMismatch: Boolean(extra.terminalTextMismatch),
    observedLanes: extra.observedLanes ?? [],

    // Evidence capture. References and counts only — an excerpt here would put
    // verbatim third-party content into the ordinary telemetry corpus, which is
    // exactly what the separate store exists to avoid.
    evidenceIds: entry?.evidenceIds ?? [],
    evidenceCaptureAttempted: Boolean(entry?.evidenceCaptureAttempted),
    evidenceCapturedCount: entry?.evidenceCapturedCount ?? 0,
    evidenceCaptureSkippedCount: entry?.evidenceCaptureSkippedCount ?? 0,
    evidenceCaptureFailedCount: entry?.evidenceCaptureFailedCount ?? 0,
    evidenceCaptureStatus: evidenceCaptureStatus(entry),
    evidenceCaptureSkipReason: entry?.evidenceCaptureSkipReason ?? null,
    runtimeConfigResolved: entry?.runtimeConfigResolved !== false,
    runtimeConfigReason: entry?.runtimeConfigReason ?? null,
    overlayConfigResolved: entry?.overlayConfigResolved !== false,
    overlayApplied: Boolean(entry?.overlayApplied),
    overlaySkipReason: entry?.overlaySkipReason ?? null,
    // A captured excerpt says nothing about whether any claim holds. Kept
    // explicitly null so no consumer infers support from capture success.
    claimSupported: null,

    // Safety refusals, kept even though they are rare: a count of zero is the
    // success criterion and needs a field to be zero in.
    blockedTools: extra.blockedTools ?? [],
    toolBlocked: Boolean((extra.blockedTools ?? []).length),

    // Who produced this turn, and whether that was actually established.
    // Default analysis should filter to "human": the heartbeat runs every 30
    // minutes and would otherwise dominate every rate computed from this
    // corpus.
    //
    // No default is applied here. This field used to read "system" whenever the
    // verdict was missing, which made an unidentified turn indistinguishable
    // from a positively identified system one — and system turns are excluded
    // from capture, so the substitution was silently load-bearing. A null class
    // with an explicit status is the honest shape.
    trafficClass: extra.traffic?.trafficClass ?? null,
    trafficResolutionStatus: extra.traffic?.status ?? "unresolved",
    // Which rule answered, or why none could: `builtin-prefix:smoke-`,
    // `session-prefix:mc-chat`, `agent:tars-chat`, `identity_unavailable`.
    trafficClassSource: extra.traffic?.reason ?? null,
    trafficClassResolvedAt: extra.traffic?.resolvedAt ?? null,
    // The host later presented a different identity for this turn. Recorded,
    // never acted on: the first decision is the turn's.
    trafficIdentityMismatch: Boolean(extra.trafficIdentityMismatch),

    synthetic: Boolean(extra.synthetic),
    syntheticReason: extra.synthetic ? extra.syntheticReason ?? "" : null,
    sessionId: extra.sessionId ?? null,
    agentId: extra.agentId ?? null,
    runId: entry?.runId ?? null,
    turnId: extra.turnId ?? entry?.runId ?? null,

    turn: clip(entry?.userMessage),

    // What the chain decided, and why. `enforced` records whether that verdict
    // was binding on this turn — in Phase 0 it always is, which is the point:
    // the baseline is taken under the old regime.
    verdict: {
      kind: entry?.kind ?? null,
      reason: entry?.reason ?? "",
      correction: Boolean(entry?.correction),
      enforced: Boolean(entry?.kind),
    },
    features: t.features ?? {},

    tools: Array.isArray(t.tools) ? t.tools : [],

    // drafts[0] is pre-revision. Later entries exist only when a gate asked
    // for another pass, which makes the gate's effect measurable.
    draft: clip(drafts[0] ?? ""),
    final: clip(extra.final ?? drafts[drafts.length - 1] ?? ""),
    draftCount: drafts.length,

    gates: {
      revised: entry?.revisions ?? 0,
      voiceRevised: entry?.voiceRevisions ?? 0,
      // Outcome, not mechanism: the caller detects the shipped line, because
      // the latch is unset when the model produces it directly.
      failedClosed: extra.failedClosed ?? Boolean(entry?.failClosed),
      offTopicTools: entry?.offTopicTools ?? 0,
      voiceViolations: t.voiceViolations ?? [],
    },

    model: extra.model ?? null,
    latencyMs: extra.latencyMs ?? null,
    // Both, always. draftWords is the raw model reply; replyWords is what
    // shipped. With the gate enabled the pair measures its effect directly,
    // which is why the gate stays on rather than being disabled to see the
    // untouched tail.
    draftWords: wordCount(drafts[0] ?? ""),
    replyWords: wordCount(extra.final ?? drafts[drafts.length - 1] ?? ""),
  };
}

/** Append one record. Never throws. */
export async function writeTurn(dir, record, logger) {
  if (!dir) return null;
  const target = fileFor(dir, record?.ts);
  try {
    await mkdir(dir, { recursive: true, mode: DIR_MODE });
    await appendFile(target, `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      mode: FILE_MODE,
    });
    return target;
  } catch (err) {
    logger?.warn?.(`llmGrounded: telemetry write failed: ${String(err?.message ?? err)}`);
    return null;
  }
}

/** Drop day files older than the retention window. Never throws. */
export async function pruneTurns(dir, retentionDays = DEFAULT_RETENTION_DAYS, logger) {
  if (!dir) return 0;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  try {
    for (const name of await readdir(dir)) {
      if (!/^turns-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) continue;
      const target = path.join(dir, name);
      const info = await stat(target).catch(() => null);
      if (info && info.mtimeMs < cutoff) {
        await rm(target, { force: true });
        removed += 1;
      }
    }
  } catch (err) {
    logger?.warn?.(`llmGrounded: telemetry prune failed: ${String(err?.message ?? err)}`);
  }
  return removed;
}
