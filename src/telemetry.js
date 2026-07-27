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
const PROMPT_FILES = ["SOUL.md", "AGENTS.md"].map((f) => path.join(workspaceDir(), f));

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
    promptHash: `sha256:${await hashFiles(PROMPT_FILES)}`,
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
export function buildTurnRecord(entry, extra = {}) {
  const t = entry?.telemetry ?? {};
  const drafts = Array.isArray(t.drafts) ? t.drafts : [];
  return {
    ts: new Date(extra.now ?? Date.now()).toISOString(),
    // Provenance. Records without these cannot be safely compared across a
    // restart, a prompt edit, or a model change.
    pluginVersion: extra.pluginVersion ?? null,
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

    // Safety refusals, kept even though they are rare: a count of zero is the
    // success criterion and needs a field to be zero in.
    blockedTools: extra.blockedTools ?? [],
    toolBlocked: Boolean((extra.blockedTools ?? []).length),

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
    logger?.warn?.(`groundskeeper: telemetry write failed: ${String(err?.message ?? err)}`);
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
    logger?.warn?.(`groundskeeper: telemetry prune failed: ${String(err?.message ?? err)}`);
  }
  return removed;
}
