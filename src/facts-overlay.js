// Retrieval precedence: making an authoritative fact record actually win.
//
// Writing the record was never the hard part. The hard part is that
// `wiki_search` and `wiki_get` rank and return whatever the vault says, and a
// stale synthesis paragraph — "the car is an TC10 sedan" — reads exactly as
// authoritative to the model as the fact record does. When materialization is
// unsafe the prose is deliberately left alone, so the conflict is not an edge
// case: it is the designed steady state of `needsRematerialization`.
//
// The seam is `api.registerAgentToolResultMiddleware`, the supported async
// pre-model hook for rewriting a tool result on its way to the model. Nothing
// in OpenClaw's bundled files is touched and the retrieval implementation is
// untouched: this package owns a strictly additive overlay on results its own
// agents receive.
//
// `tool_result_persist` was the first attempt and was wrong twice over. It is
// transcript persistence, which happens after the model has already seen the
// result, so it could not satisfy the requirement even in principle; and the
// hook runner is synchronous, so an async handler's Promise is explicitly
// discarded — "this hook is synchronous and the result was ignored"
// (hook-runner-global). The overlay needs to await a file read, so the
// middleware seam is the only correct one.
//
// What it does, only when a retrieved result contradicts a record:
//   * prepends an authoritative block naming the current value, so the fact
//     leads the message rather than trailing it;
//   * marks the superseded value inline so a model that reads past the block
//     still sees which token is stale.
//
// What it does not do: touch the vault, drop retrieved content, or fire when
// nothing conflicts.

import { readFile } from "node:fs/promises";
import path from "node:path";

import { statesValue } from "./values.js";

export const META_DIR = ".openclaw-facts";
export const OVERLAY_NAME = "index.json";

/** Overlays are re-read at most this often; a commit invalidates immediately. */
const DEFAULT_CACHE_MS = 5000;
/** Bound on how many conflicting records are announced in one result. */
const MAX_ANNOUNCED = 5;

export function overlayPath(vaultPath) {
  return path.join(vaultPath, META_DIR, OVERLAY_NAME);
}

/**
 * Cached overlay reader. A missing or malformed overlay yields no facts, which
 * degrades to today's behaviour rather than failing a retrieval.
 */
export function createOverlayReader({ vaultPath, cacheMs = DEFAULT_CACHE_MS, now = () => Date.now(), read = readFile, logger } = {}) {
  let cached = null;
  let readAt = 0;

  return {
    /** Drop the cache, so a just-committed record is visible immediately. */
    invalidate() {
      cached = null;
      readAt = 0;
    },
    async load() {
      if (cached && now() - readAt < cacheMs) return cached;
      try {
        const text = await read(overlayPath(vaultPath), "utf8");
        const parsed = JSON.parse(text);
        cached = parsed && typeof parsed.facts === "object" && parsed.facts ? parsed : { facts: {} };
      } catch (err) {
        if (err?.code !== "ENOENT") {
          logger?.warn?.(`llmGrounded: fact overlay unreadable: ${String(err?.message ?? err)}`);
        }
        cached = { facts: {} };
      }
      readAt = now();
      return cached;
    },
  };
}

/**
 * Find records the retrieved text contradicts.
 *
 * A conflict is a record whose superseded value the text states while not
 * stating the current one. Text that already agrees is left alone — an overlay
 * that fires on every retrieval would be noise, and noise gets ignored.
 */
export function findConflicts(overlay, text) {
  const facts = overlay?.facts ?? {};
  const conflicts = [];
  for (const [factKey, entry] of Object.entries(facts)) {
    if (!entry || typeof entry !== "object") continue;
    const current = entry.currentValue;
    if (!current) continue;
    if (statesValue(text, current)) continue;
    const superseded = Array.isArray(entry.supersededValues) ? entry.supersededValues : [];
    const stale = superseded.find((value) => value && statesValue(text, value));
    if (!stale) continue;
    conflicts.push({ factKey, entry, stale });
    if (conflicts.length >= MAX_ANNOUNCED) break;
  }
  return conflicts;
}

/** The block prepended ahead of contradicted retrieval text. */
export function renderAuthoritativeBlock(conflicts) {
  const lines = conflicts.map(({ entry, stale }) => {
    const subject = entry.subject ?? "";
    const property = entry.property ?? "";
    return `- ${subject} — ${property}: ${entry.currentValue} (revision ${entry.revision}; "${stale}" is superseded and must not be used)`;
  });
  return [
    "[authoritative fact records — these override any conflicting text below]",
    ...lines,
    "[end authoritative fact records]",
    "",
  ].join("\n");
}

/**
 * Overlay one retrieved text. Returns the original when nothing conflicts, so
 * the caller can skip the rewrite entirely.
 */
export function overlayText(overlay, text) {
  const original = String(text ?? "");
  if (!original.trim()) return { changed: false, text: original, conflicts: [] };
  const conflicts = findConflicts(overlay, original);
  if (conflicts.length === 0) return { changed: false, text: original, conflicts: [] };
  return {
    changed: true,
    text: `${renderAuthoritativeBlock(conflicts)}${original}`,
    conflicts,
  };
}

/**
 * Rewrite a retrieval tool's result before the model consumes it.
 *
 * This operates on `AgentToolResult` — `{content: [{type: "text", text}], details}`
 * — which is what the agent tool-result middleware hands over on its way to the
 * model. The block goes on the first text part so it leads; later parts and
 * `details` are untouched, and nothing retrieved is dropped.
 *
 * Returns null when nothing conflicts, so the caller can leave the result
 * object identical rather than cloning it for no reason.
 */
export function overlayToolResult(overlay, result) {
  if (!result || typeof result !== "object") return null;
  const content = result.content;
  if (!Array.isArray(content)) return null;

  const combined = content
    .filter((part) => part && typeof part === "object" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
  const overlaid = overlayText(overlay, combined);
  if (!overlaid.changed) return null;

  let applied = false;
  const next = content.map((part) => {
    if (applied) return part;
    if (!part || typeof part !== "object" || typeof part.text !== "string") return part;
    applied = true;
    return { ...part, text: `${renderAuthoritativeBlock(overlaid.conflicts)}${part.text}` };
  });
  if (!applied) return null;
  return { result: { ...result, content: next }, conflicts: overlaid.conflicts };
}
