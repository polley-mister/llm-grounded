// Per-tool evidence extraction. Allowlisted fields, never a stringified result.
//
// The tempting shortcut here is `JSON.stringify(result)`, and it is a trap: it
// would eventually store provider metadata, internal identifiers, pagination
// cursors, credentials in echoed request objects, and whole nested payloads —
// growing silently as any tool's response shape evolves. An adapter that names
// the fields it wants cannot do that, and an unknown shape yields nothing
// rather than everything.
//
// One tool call may produce several evidence items. Ten unrelated search
// results are ten pieces of evidence, not one; merging them would make
// "which evidence supports this claim" unanswerable later.

/** Fields worth keeping from a search hit, in preference order for excerpting. */
const SNIPPET_FIELDS = ["snippet", "excerpt", "description", "summary", "content", "text"];
const TITLE_FIELDS = ["title", "name", "heading"];
const SOURCE_FIELDS = ["url", "link", "source", "href", "path", "page"];

function firstString(node, keys, limit = 500) {
  for (const key of keys) {
    const value = node?.[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, limit);
  }
  return null;
}

/** Candidate result arrays, whatever the provider called them. */
function resultList(result) {
  if (Array.isArray(result)) return result;
  for (const key of ["results", "items", "hits", "matches", "documents", "entries"]) {
    if (Array.isArray(result?.[key])) return result[key];
  }
  return null;
}

/** Text parts of an AgentToolResult-shaped payload. */
function contentText(result) {
  if (!Array.isArray(result?.content)) return null;
  const parts = result.content
    .filter((p) => p && typeof p === "object" && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text.trim())
    .filter(Boolean);
  return parts.length ? parts.join("\n") : null;
}

/**
 * One evidence item.
 *
 * `title` and `source` are kept because they are what a person needs to judge
 * an excerpt, and they are cheap. Everything else about the provider response
 * is discarded.
 */
function item(text, { title = null, source = null } = {}) {
  const body = String(text ?? "").trim();
  if (!body) return null;
  return { title, source, excerpt: body };
}

// ---------------------------------------------------------------------------
// Per-tool adapters
// ---------------------------------------------------------------------------

/** Search results: one evidence item per hit. */
export function extractSearchEvidence(result, { maxItems = 5 } = {}) {
  const list = resultList(result);
  if (list) {
    const out = [];
    for (const hit of list) {
      if (out.length >= maxItems) break;
      if (typeof hit === "string") {
        const one = item(hit);
        if (one) out.push(one);
        continue;
      }
      const one = item(firstString(hit, SNIPPET_FIELDS, 4000), {
        title: firstString(hit, TITLE_FIELDS, 200),
        source: firstString(hit, SOURCE_FIELDS, 300),
      });
      if (one) out.push(one);
    }
    if (out.length) return out;
  }
  // No recognisable list: fall back to the rendered text the model would read.
  const text = contentText(result) ?? (typeof result === "string" ? result : null);
  const one = item(text);
  return one ? [one] : [];
}

export const extractWebSearchEvidence = (r, o) => extractSearchEvidence(r, o);
export const extractMemorySearchEvidence = (r, o) => extractSearchEvidence(r, o);
export const extractWikiSearchEvidence = (r, o) => extractSearchEvidence(r, o);

/** A single fetched document: one item, titled and sourced where possible. */
export function extractWebFetchEvidence(result) {
  const text =
    contentText(result) ??
    firstString(result, ["text", "content", "body", "markdown"], 20000) ??
    (typeof result === "string" ? result : null);
  const one = item(text, {
    title: firstString(result, TITLE_FIELDS, 200),
    source: firstString(result, SOURCE_FIELDS, 300),
  });
  return one ? [one] : [];
}

/** A page or record retrieved by id. */
export function extractWikiGetEvidence(result) {
  return extractWebFetchEvidence(result);
}

/**
 * Runtime and status tools.
 *
 * Deliberately narrow: rendered text only, no structured passthrough. Runtime
 * payloads are the most likely of any category to carry hostnames, paths,
 * tokens and internal identifiers, and there is no general shape to allowlist.
 */
export function extractRuntimeEvidence(result) {
  const text = contentText(result) ?? (typeof result === "string" ? result : null);
  const one = item(text);
  return one ? [one] : [];
}

/** Tool name to adapter. Absence means the tool is not capturable. */
export const ADAPTERS = Object.freeze({
  web_search: extractWebSearchEvidence,
  web_fetch: extractWebFetchEvidence,
  memory_search: extractMemorySearchEvidence,
  wiki_search: extractWikiSearchEvidence,
  wiki_get: extractWikiGetEvidence,
});

/**
 * Extract evidence items for one tool result.
 *
 * Returns an empty array for an unknown tool: the adapter table is an
 * allowlist, and a tool nobody has written an adapter for is not captured
 * "generically".
 */
export function extractEvidenceItems(tool, result, opts = {}) {
  const adapter = ADAPTERS[tool] ?? (opts.runtimeTools?.includes(tool) ? extractRuntimeEvidence : null);
  if (!adapter) return [];
  try {
    const items = adapter(result, opts) ?? [];
    return items.filter(Boolean).slice(0, opts.maxItems ?? 5);
  } catch {
    // A malformed payload yields no evidence rather than a partial guess.
    return [];
  }
}
