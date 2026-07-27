// Per-session grounding evidence artifact.
//
// Why this file exists: `openclaw agent --json` returns
// `{runId, status, summary, result:{payloads, meta:{durationMs, agentMeta}}}`
// on OpenClaw 2026.6.1. `agentMeta` carries session/provider/model/usage and
// nothing about tool calls, so the console's CLI (non-delivery) path has no
// way to read tool evidence out of the CLI return. The plugin therefore writes
// a small, bounded, secret-free record that the console reads back by
// OpenClaw session id.
//
// Contract: missing, stale, or mismatched evidence is NOT verified. Mission
// Control fails closed on absence; this file can only ever grant verification
// for a record it actually wrote.

import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { varDir } from "./paths.js";

export const EVIDENCE_VERSION = 1;
export const DEFAULT_EVIDENCE_DIR = path.join(varDir(), "evidence");

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_FILES = 400;

/** OpenClaw session ids are operator-controlled; keep the filename inert. */
export function evidenceFileName(sessionId) {
  const safe = String(sessionId ?? "")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/^[-.]+/, "")
    .slice(0, 120);
  return safe ? `${safe}.json` : "";
}

export function buildEvidence(entry, extra = {}) {
  return {
    version: EVIDENCE_VERSION,
    sessionId: extra.sessionId ?? entry?.sessionKey ?? null,
    runId: entry?.runId ?? null,
    // The only per-turn identifier in the run. See extractTurnNonce: the CLI
    // derives its run id from the session id, so runId and sessionId are both
    // constant across a the console chat session and cannot bind a record
    // to one turn.
    turnNonce: entry?.turnNonce ?? null,
    agentId: extra.agentId ?? null,
    grounding: entry?.kind ?? null,
    groundingVerified: entry ? entry.kind == null || entry.verified === true : false,
    correction: Boolean(entry?.correction),
    toolCalls: entry?.toolCalls ?? 0,
    toolFailures: entry?.toolFailures ?? 0,
    satisfiedBy: entry?.satisfiedBy ?? [],
    revisions: entry?.revisions ?? 0,
    failClosed: Boolean(entry?.failClosed),
    // WP-2026-004. Codes and counts only: no fact values, no quotations, no
    // vault excerpts. the console needs to know a transaction happened and
    // how it ended, not what it said.
    fact: {
      eligible: Boolean(entry?.factEligible),
      kind: entry?.factKind ?? null,
      reason: entry?.factReason ?? "",
      calls: entry?.factCalls ?? 0,
      audits: entry?.caseAudits ?? 0,
      revisions: entry?.factRevisions ?? 0,
      outcome: entry?.factOutcome
        ? {
            ok: Boolean(entry.factOutcome.ok),
            code: entry.factOutcome.code ?? null,
            factKey: entry.factOutcome.factKey ?? null,
            revision: entry.factOutcome.revision ?? null,
            needsRematerialization: Boolean(entry.factOutcome.needsRematerialization),
            caseModel: entry.factOutcome.attribution?.model ?? null,
            caseAgentId: entry.factOutcome.attribution?.agentId ?? null,
          }
        : null,
    },
    thinkingLevel: extra.thinkingLevel ?? null,
    updatedAt: new Date(extra.now ?? Date.now()).toISOString(),
  };
}

/**
 * Write one evidence record. Best effort: an unwritable directory must never
 * fail the agent turn — it degrades to "no evidence", which fails closed.
 */
export async function writeEvidence(dir, sessionId, record, logger) {
  const name = evidenceFileName(sessionId);
  if (!name) return null;
  const target = path.join(dir, name);
  try {
    await mkdir(dir, { recursive: true, mode: DIR_MODE });
    await writeFile(target, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      mode: FILE_MODE,
    });
    return target;
  } catch (err) {
    logger?.warn?.(`llmGrounded: evidence write failed: ${String(err?.message ?? err)}`);
    return null;
  }
}

/** Keep the evidence directory bounded; oldest-by-name pruning is enough. */
export async function pruneEvidence(dir, maxFiles = MAX_FILES) {
  try {
    const names = (await readdir(dir)).filter((n) => n.endsWith(".json")).sort();
    if (names.length <= maxFiles) return 0;
    const doomed = names.slice(0, names.length - maxFiles);
    for (const name of doomed) await rm(path.join(dir, name), { force: true });
    return doomed.length;
  } catch {
    return 0;
  }
}
