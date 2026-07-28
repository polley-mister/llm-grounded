// Bounded, redacted evidence excerpts, stored apart from telemetry.
//
// Claim verification needs to ask whether a *specific* claim is supported by
// *specific* evidence. Today that question cannot be asked: telemetry records
// {name, ok, params} per tool call and nothing of what came back. This module
// captures the missing half.
//
// Three properties are load-bearing:
//
//   * A successful tool call is not a supported claim. `claimSupported` is
//     written as null and stays null until an entailment stage that does not
//     exist yet. Storing a boolean called "supported" here would reintroduce
//     "a web tool ran" as grounding, which is the error this project exists to
//     correct.
//
//   * Capture never fails a turn. If the store is unwritable the tool result
//     proceeds unchanged and the failure is recorded. A logging subsystem that
//     can break delivery is the wrong trade for a shadow feature.
//
//   * A missing excerpt beats a stored credential. Where safe redaction cannot
//     be guaranteed, the capture is skipped.
//
// See docs/evidence-capture.md. Nothing here is wired into a hook.

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { extractEvidenceItems } from "./evidence-adapters.js";
import { looksSecret } from "./values.js";
import { varDir } from "./paths.js";

export const EVIDENCE_SCHEMA_VERSION = "evidence-v1";

/** Where evidence excerpts live. Separate from telemetry, deliberately. */
export const DEFAULT_EVIDENCE_CAPTURE_DIR = path.join(varDir(), "evidence-capture");

/**
 * Tools whose results can support a claim.
 *
 * An allowlist, not a denylist: an unknown tool is not captured. `exec` and
 * file reads are absent on purpose — they routinely carry secrets and large
 * private documents, and they need a stricter policy than this module provides.
 */
export const EVIDENCE_TOOLS = Object.freeze({
  web_search: "web",
  web_fetch: "web",
  memory_search: "memory",
  wiki_search: "memory",
  wiki_get: "memory",
});

export const BOUNDS = Object.freeze({
  excerptChars: 2000,
  itemsPerCall: 5,
  itemsPerTurn: 8,
  charsPerTurn: 10000,
});

/** How long a bounded local capture may take before the turn moves on. */
export const DEFAULT_CAPTURE_TIMEOUT_MS = 400;

/** Days before an evidence file is pruned. Shorter than telemetry on purpose. */
export const DEFAULT_RETENTION_DAYS = 14;

// ---------------------------------------------------------------------------
// Extraction and bounding
// ---------------------------------------------------------------------------

/**
 * Pull readable text out of a tool result.
 *
 * Handles the shapes OpenClaw actually produces without asserting a schema:
 * a result may be a string, `{content: [{type:"text", text}]}`, or an object
 * with a `text`/`snippet` field. Anything else yields nothing, which is the
 * safe outcome — an unrecognised shape is not guessed at.
 */
export function extractText(result) {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";

  if (Array.isArray(result.content)) {
    const parts = result.content
      .filter((p) => p && typeof p === "object" && typeof p.text === "string")
      .map((p) => p.text);
    if (parts.length) return parts.join("\n");
  }
  for (const key of ["text", "snippet", "summary", "answer"]) {
    if (typeof result[key] === "string" && result[key].trim()) return result[key];
  }
  return "";
}

/**
 * Redact anything that looks like a credential.
 *
 * Token-wise, reusing `looksSecret` so the definition of "secret" lives in one
 * place. Returns the count as well as the text: a capture that redacted
 * something is materially different from one that did not, and the difference
 * belongs in the record rather than in a log line.
 */
export function redactExcerpt(text) {
  const source = String(text ?? "");
  if (!source) return { text: "", redactionCount: 0 };
  let redactionCount = 0;
  const out = source
    .split(/(\s+)/)
    .map((token) => {
      if (!token.trim() || !looksSecret(token)) return token;
      redactionCount += 1;
      return "[redacted]";
    })
    .join("");
  return { text: out, redactionCount };
}

/** Truncate on a word boundary where possible, so an excerpt ends readably. */
export function boundExcerpt(text, limit = BOUNDS.excerptChars) {
  const source = String(text ?? "");
  if (source.length <= limit) return { text: source, truncated: false };
  const cut = source.slice(0, limit);
  const lastSpace = cut.lastIndexOf(" ");
  return {
    text: (lastSpace > limit * 0.8 ? cut.slice(0, lastSpace) : cut).trimEnd(),
    truncated: true,
  };
}

function sha256(text) {
  return `sha256:${createHash("sha256").update(String(text ?? ""), "utf8").digest("hex")}`;
}

// ---------------------------------------------------------------------------
// Building a record
// ---------------------------------------------------------------------------

/**
 * Build one evidence record, or explain why not.
 *
 * Pure: does no I/O, so the decision to capture is testable apart from whether
 * the disk cooperated.
 *
 * @returns {{captureStatus: "captured"|"skipped", reason?: string, record?: object}}
 */
export function buildEvidenceRecord({
  turnId,
  toolCallId,
  tool,
  params,
  result,
  evidenceItem = null,
  evidenceView = "effective_tool_result",
  transformsApplied = [],
  now = () => Date.now(),
  id = () => `ev_${randomUUID()}`,
} = {}) {
  const sourceType = EVIDENCE_TOOLS[tool];
  if (!sourceType) return { captureStatus: "skipped", reason: "tool_not_capturable" };

  // An adapter-produced item is preferred: it has already discarded everything
  // the tool returned except allowlisted fields. `result` remains supported for
  // the isolated unit tests and for tools whose adapter yields a single item.
  const raw = evidenceItem ? String(evidenceItem.excerpt ?? "") : extractText(result);
  if (!raw.trim()) return { captureStatus: "skipped", reason: "no_text_content" };

  const redacted = redactExcerpt(raw);
  // Wholesale redaction means the content was mostly credential-shaped. Storing
  // the remains has no evidentiary value and some risk, so it is skipped.
  if (redacted.redactionCount > 0 && redacted.text.replace(/\[redacted\]/g, "").trim().length < 40) {
    return { captureStatus: "skipped", reason: "sensitive_content" };
  }

  const bounded = boundExcerpt(redacted.text);

  return {
    captureStatus: "captured",
    record: {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      evidenceId: id(),
      turnId: turnId ?? null,
      toolCallId: toolCallId ?? null,
      tool,
      sourceType,
      // The query only; never the full parameter object, which can carry
      // credentials on some tools.
      query: typeof params?.query === "string" ? params.query.slice(0, 500) : null,
      excerpt: bounded.text,
      // Hashes what is actually stored — after redaction and truncation — so it
      // identifies the file's contents rather than something never written.
      excerptHash: sha256(bounded.text),
      capturedAt: new Date(now()).toISOString(),
      originalCharacters: raw.length,
      capturedCharacters: bounded.text.length,
      truncated: bounded.truncated,
      redacted: redacted.redactionCount > 0,
      redactionCount: redacted.redactionCount,
      title: evidenceItem?.title ?? null,
      source: evidenceItem?.source ?? null,
      // Which version of the result this excerpt is. Entailment must judge the
      // evidence the answering model actually saw, so a pre-overlay excerpt
      // would be the wrong thing to check a claim against.
      evidenceView,
      transformsApplied: [...transformsApplied],
      // A tool that ran is not a claim that holds. This stays null until an
      // entailment stage exists to set it.
      claimSupported: null,
    },
  };
}

// ---------------------------------------------------------------------------
// Per-turn budget
// ---------------------------------------------------------------------------

/**
 * Track what a single turn has already captured.
 *
 * Bounds are per turn as well as per item: eight two-thousand-character
 * excerpts is a lot of third-party text to accumulate from one question.
 */
export function createTurnBudget(bounds = BOUNDS) {
  let items = 0;
  let chars = 0;
  return {
    /** Whether another record of this size may be stored. */
    admit(record) {
      if (items >= bounds.itemsPerTurn) return { ok: false, reason: "item_limit" };
      if (chars + record.capturedCharacters > bounds.charsPerTurn) {
        return { ok: false, reason: "turn_char_limit" };
      }
      items += 1;
      chars += record.capturedCharacters;
      return { ok: true };
    },
    get used() {
      return { items, chars };
    },
  };
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * Write one record atomically.
 *
 * Temporary file, then rename: a crash mid-write leaves either the previous
 * state or the new one, never a truncated record whose hash describes nothing.
 *
 * Never throws. Capture is best-effort by design — an unwritable store must not
 * be able to fail a user's turn.
 */
/**
 * The filesystem calls, injectable.
 *
 * Not for flexibility — there is one real implementation and there will only
 * ever be one. It is so the failure path can be tested by causing a failure.
 * The test that covered this made the directory unwritable with `chmod 0500`,
 * which does nothing when the test process is root: the write succeeded and the
 * assertion passed for the wrong reason, on the one branch whose entire purpose
 * is to swallow an error without disturbing the turn.
 */
const REAL_FS = Object.freeze({ mkdir, writeFile, rename });

export async function writeEvidenceRecord(dir, record, logger, fsOps = REAL_FS) {
  try {
    await fsOps.mkdir(dir, { recursive: true, mode: 0o700 });
    const target = path.join(dir, `${record.evidenceId}.json`);
    const temp = `${target}.tmp`;
    await fsOps.writeFile(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    await fsOps.rename(temp, target);
    return { ok: true, path: target };
  } catch (err) {
    logger?.warn?.(`llmGrounded: evidence capture failed: ${String(err?.message ?? err)}`);
    return { ok: false, reason: String(err?.message ?? err) };
  }
}

/**
 * Drop evidence past its retention window.
 *
 * Excerpts are verbatim third-party and private content. A store with no expiry
 * becomes an unbounded private archive nobody audits, so retention is shorter
 * than telemetry's by default.
 */
export async function pruneEvidenceCapture(dir, retentionDays = DEFAULT_RETENTION_DAYS, logger, now = () => Date.now()) {
  const cutoff = now() - Math.max(1, retentionDays) * 24 * 60 * 60 * 1000;
  let removed = 0;
  try {
    for (const name of await readdir(dir)) {
      if (!name.endsWith(".json")) continue;
      const full = path.join(dir, name);
      const info = await stat(full);
      if (info.mtimeMs < cutoff) {
        await rm(full, { force: true });
        removed += 1;
      }
    }
  } catch (err) {
    if (err?.code !== "ENOENT") {
      logger?.warn?.(`llmGrounded: evidence prune failed: ${String(err?.message ?? err)}`);
    }
  }
  return removed;
}

/**
 * Capture one tool result end to end.
 *
 * Returns what telemetry should record: references and outcome flags, never
 * excerpt text.
 */
/**
 * Capture every evidence item from one successful tool call.
 *
 * Bounded three ways — per item, per call, per turn — and every rejection is
 * reported rather than silently dropped, because "we captured nothing" and "we
 * captured nothing because the budget was spent" are different facts about a
 * turn.
 */
export async function captureToolCallEvidence({
  dir,
  budget,
  logger,
  tool,
  result,
  runtimeTools = [],
  bounds = BOUNDS,
  fsOps,
  ...rest
}) {
  const items = extractEvidenceItems(tool, result, {
    maxItems: bounds.itemsPerCall,
    runtimeTools,
  });
  if (!items.length) {
    return { evidenceIds: [], captured: 0, skipped: 1, failed: 0, reasons: ["no_evidence_items"] };
  }

  const evidenceIds = [];
  const reasons = [];
  let captured = 0;
  let skipped = 0;
  let failed = 0;

  for (const evidenceItem of items) {
    const out = await captureEvidence({ dir, budget, logger, tool, result, evidenceItem, fsOps, ...rest });
    if (out.captured) {
      evidenceIds.push(out.evidenceId);
      captured += 1;
      continue;
    }
    if (out.reason === "write_failed") failed += 1;
    else skipped += 1;
    reasons.push(out.reason);
  }
  return { evidenceIds, captured, skipped, failed, reasons };
}

export async function captureEvidence({ dir, budget, logger, fsOps, ...input }) {
  const built = buildEvidenceRecord(input);
  if (built.captureStatus !== "captured") {
    return { captured: false, reason: built.reason, evidenceId: null };
  }
  const admitted = budget?.admit?.(built.record) ?? { ok: true };
  if (!admitted.ok) {
    return { captured: false, reason: admitted.reason, evidenceId: null };
  }
  const written = await writeEvidenceRecord(dir, built.record, logger, fsOps);
  if (!written.ok) {
    return { captured: false, reason: "write_failed", evidenceId: null };
  }
  return { captured: true, evidenceId: built.record.evidenceId, reason: null };
}
