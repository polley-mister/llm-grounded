// Per-tool evidence adapters: allowlisted fields, never a stringified result.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ADAPTERS,
  extractEvidenceItems,
  extractRuntimeEvidence,
  extractSearchEvidence,
  extractWebFetchEvidence,
} from "../src/evidence-adapters.js";

test("a search result becomes one evidence item per hit", () => {
  // Ten unrelated results are ten pieces of evidence. Merging them would make
  // "which evidence supports this claim" unanswerable later.
  const items = extractSearchEvidence({
    results: [
      { title: "Retailer A", url: "https://a.example/p", snippet: "Listed at $4,000." },
      { title: "Retailer B", url: "https://b.example/p", snippet: "In stock, $4,050." },
    ],
  });
  assert.equal(items.length, 2);
  assert.equal(items[0].title, "Retailer A");
  assert.equal(items[0].source, "https://a.example/p");
  assert.match(items[0].excerpt, /\$4,000/);
});

test("provider metadata never survives extraction", () => {
  // The whole reason adapters exist rather than JSON.stringify.
  const items = extractSearchEvidence({
    requestId: "req_secret_123",
    apiKey: "sk-abcdefghijklmnopqrst",
    cursor: "eyJwYWdlIjoy",
    _internal: { traceId: "abc", cost: 0.004 },
    results: [{ title: "T", url: "https://x.example", snippet: "Body text." }],
  });
  const serialised = JSON.stringify(items);
  for (const leak of ["req_secret_123", "sk-abcdefghijklmnopqrst", "eyJwYWdlIjoy", "traceId"]) {
    assert.doesNotMatch(serialised, new RegExp(leak), leak);
  }
  assert.deepEqual(Object.keys(items[0]).sort(), ["excerpt", "source", "title"]);
});

test("hit fields outside the allowlist are dropped", () => {
  const items = extractSearchEvidence({
    results: [{ title: "T", snippet: "Body.", rawHtml: "<script>x</script>", score: 0.98, docId: "internal-42" }],
  });
  const serialised = JSON.stringify(items);
  assert.doesNotMatch(serialised, /script|internal-42|0\.98/);
});

test("results per call are bounded", () => {
  const many = { results: Array.from({ length: 20 }, (_, i) => ({ snippet: `hit ${i}` })) };
  assert.equal(extractSearchEvidence(many, { maxItems: 5 }).length, 5);
});

test("an AgentToolResult shape falls back to its rendered text", () => {
  const items = extractSearchEvidence({ content: [{ type: "text", text: "One rendered block." }] });
  assert.equal(items.length, 1);
  assert.match(items[0].excerpt, /rendered block/);
});

test("a fetched document becomes a single titled item", () => {
  const items = extractWebFetchEvidence({ title: "Spec", url: "https://x.example/spec", text: "48 GB of memory." });
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Spec");
  assert.match(items[0].excerpt, /48 GB/);
});

test("runtime evidence is rendered text only", () => {
  // Runtime payloads are the most likely to carry hosts, paths and internal
  // identifiers, and there is no general shape worth allowlisting.
  const items = extractRuntimeEvidence({
    content: [{ type: "text", text: "service: running" }],
    pid: 1234,
    cmdline: "/usr/bin/node --secret-flag",
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].excerpt, "service: running");
  assert.doesNotMatch(JSON.stringify(items), /cmdline|1234/);
});

test("an unknown tool yields nothing", () => {
  // The adapter table is an allowlist. A tool nobody wrote an adapter for is
  // not captured "generically".
  for (const tool of ["exec", "read", "write", "some_plugin"]) {
    assert.deepEqual(extractEvidenceItems(tool, { content: [{ type: "text", text: "x" }] }), []);
  }
});

test("a runtime tool is captured only when explicitly approved", () => {
  const result = { content: [{ type: "text", text: "uptime 12h" }] };
  assert.deepEqual(extractEvidenceItems("status_check", result), []);
  assert.equal(extractEvidenceItems("status_check", result, { runtimeTools: ["status_check"] }).length, 1);
});

test("every approved tool has an adapter", () => {
  for (const tool of ["web_search", "web_fetch", "memory_search", "wiki_search", "wiki_get"]) {
    assert.equal(typeof ADAPTERS[tool], "function", tool);
  }
});

test("a malformed payload yields no evidence rather than a partial guess", () => {
  const exploding = { get results() { throw new Error("boom"); } };
  assert.deepEqual(extractEvidenceItems("web_search", exploding), []);
});

test("empty and absent content produce nothing", () => {
  assert.deepEqual(extractEvidenceItems("web_search", null), []);
  assert.deepEqual(extractEvidenceItems("web_search", { results: [] }), []);
  assert.deepEqual(extractEvidenceItems("web_search", { results: [{ snippet: "   " }] }), []);
});
