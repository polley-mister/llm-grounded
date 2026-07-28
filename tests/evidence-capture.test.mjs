// Evidence capture: bounds, redaction, integrity, and the distinction that
// matters most — a tool that ran is not a claim that holds.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  BOUNDS,
  EVIDENCE_SCHEMA_VERSION,
  EVIDENCE_TOOLS,
  boundExcerpt,
  buildEvidenceRecord,
  captureEvidence,
  createTurnBudget,
  extractText,
  pruneEvidenceCapture,
  redactExcerpt,
  writeEvidenceRecord,
} from "../src/evidence-capture.js";

const dir = () => mkdtemp(path.join(tmpdir(), "evidence-"));

const input = (over = {}) => ({
  turnId: "turn-1",
  toolCallId: "call-1",
  tool: "web_search",
  params: { query: "current price" },
  result: { content: [{ type: "text", text: "The product currently lists at $4,000 across two retailers." }] },
  ...over,
});

// ---------------------------------------------------------------------------
// The distinction this module exists to protect
// ---------------------------------------------------------------------------

test("a captured result makes no claim about support", () => {
  // "A web tool ran" as a proxy for grounding is the error this project exists
  // to correct. Storing a boolean called supported here would reintroduce it.
  const { record } = buildEvidenceRecord(input());
  assert.equal(record.claimSupported, null);
  assert.equal("supported" in record, false);
});

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

test("only approved evidence-bearing tools are captured", () => {
  for (const tool of Object.keys(EVIDENCE_TOOLS)) {
    assert.equal(buildEvidenceRecord(input({ tool })).captureStatus, "captured", tool);
  }
  // An unknown tool is not captured, rather than captured cautiously.
  for (const tool of ["exec", "read", "write", "process", "some_plugin_thing"]) {
    const out = buildEvidenceRecord(input({ tool }));
    assert.equal(out.captureStatus, "skipped", tool);
    assert.equal(out.reason, "tool_not_capturable");
  }
});

test("source type follows the tool", () => {
  assert.equal(buildEvidenceRecord(input({ tool: "web_search" })).record.sourceType, "web");
  assert.equal(buildEvidenceRecord(input({ tool: "wiki_search" })).record.sourceType, "memory");
});

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

test("credentials are redacted before anything is written", () => {
  const { record } = buildEvidenceRecord(input({
    result: "The endpoint needs sk-abcdefghijklmnopqrst and returns the current price of $4,000 per unit.",
  }));
  assert.doesNotMatch(record.excerpt, /sk-abcdefghijklmnopqrst/);
  assert.match(record.excerpt, /\[redacted\]/);
  assert.equal(record.redacted, true);
  assert.equal(record.redactionCount, 1);
});

test("content that is mostly credential is skipped, not stored in pieces", () => {
  // A missing excerpt beats a stored credential, and the remains of a
  // wholly-redacted payload have no evidentiary value anyway.
  const out = buildEvidenceRecord(input({ result: "sk-abcdefghijklmnopqrst" }));
  assert.equal(out.captureStatus, "skipped");
  assert.equal(out.reason, "sensitive_content");
});

test("ordinary text is not disturbed", () => {
  const { text, redactionCount } = redactExcerpt("The product lists at $4,000 today.");
  assert.equal(text, "The product lists at $4,000 today.");
  assert.equal(redactionCount, 0);
});

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

test("an excerpt is bounded and marked truncated", () => {
  const long = "word ".repeat(2000);
  const { record } = buildEvidenceRecord(input({ result: long }));
  assert.ok(record.capturedCharacters <= BOUNDS.excerptChars);
  assert.equal(record.truncated, true);
  assert.equal(record.originalCharacters, long.length);
});

test("truncation prefers a word boundary", () => {
  const out = boundExcerpt(`${"a".repeat(50)} ${"b".repeat(2000)}`, 100);
  assert.equal(out.truncated, true);
  assert.doesNotMatch(out.text, /\s$/);
});

test("a short excerpt is not marked truncated", () => {
  const { record } = buildEvidenceRecord(input());
  assert.equal(record.truncated, false);
  assert.equal(record.capturedCharacters, record.originalCharacters);
});

test("a turn budget caps items and total characters", () => {
  // Eight two-thousand-character excerpts is a lot of third-party text to
  // accumulate from one question.
  const budget = createTurnBudget({ itemsPerTurn: 2, charsPerTurn: 10000 });
  const rec = { capturedCharacters: 100 };
  assert.equal(budget.admit(rec).ok, true);
  assert.equal(budget.admit(rec).ok, true);
  assert.equal(budget.admit(rec).reason, "item_limit");

  const charBudget = createTurnBudget({ itemsPerTurn: 8, charsPerTurn: 150 });
  assert.equal(charBudget.admit(rec).ok, true);
  assert.equal(charBudget.admit(rec).reason, "turn_char_limit");
});

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------

test("text is pulled from the shapes tools actually return", () => {
  assert.match(extractText("plain string"), /plain string/);
  assert.match(extractText({ content: [{ type: "text", text: "from content" }] }), /from content/);
  assert.match(extractText({ snippet: "from snippet" }), /from snippet/);
  // An unrecognised shape yields nothing rather than a guess.
  assert.equal(extractText({ mystery: { nested: 1 } }), "");
  assert.equal(extractText(null), "");
});

test("a result with no readable text is skipped", () => {
  const out = buildEvidenceRecord(input({ result: { mystery: 1 } }));
  assert.equal(out.captureStatus, "skipped");
  assert.equal(out.reason, "no_text_content");
});

// ---------------------------------------------------------------------------
// Identity and integrity
// ---------------------------------------------------------------------------

test("identity is generated, not derived from the query", () => {
  // The same query returns different results at different times; a
  // content-addressed id would merge two retrievals into one.
  const a = buildEvidenceRecord(input()).record;
  const b = buildEvidenceRecord(input()).record;
  assert.notEqual(a.evidenceId, b.evidenceId);
  assert.match(a.evidenceId, /^ev_/);
  assert.equal(a.turnId, "turn-1");
  assert.equal(a.toolCallId, "call-1");
});

test("the hash covers what is stored, not what arrived", async () => {
  // After redaction and truncation. A hash of the original would identify
  // something that was never written.
  const { record } = buildEvidenceRecord(input({
    // Real prose, not opaque filler: looksSecret flags a long unbroken token as
    // credential-shaped, which is correct and would otherwise make this test
    // measure redaction rather than hashing.
    result: `Auth uses sk-abcdefghijklmnopqrst. ${"The product lists at four thousand dollars today. ".repeat(60)}`,
  }));
  const { createHash } = await import("node:crypto");
  const expected = `sha256:${createHash("sha256").update(record.excerpt, "utf8").digest("hex")}`;
  assert.equal(record.excerptHash, expected);
});

test("only the query is kept, never the whole parameter object", () => {
  const { record } = buildEvidenceRecord(input({
    params: { query: "current price", apiKey: "sk-abcdefghijklmnopqrst", cookie: "session=x" },
  }));
  assert.equal(record.query, "current price");
  const serialised = JSON.stringify(record);
  assert.doesNotMatch(serialised, /sk-abcdefghijklmnopqrst/);
  assert.doesNotMatch(serialised, /session=x/);
});

test("records carry their schema version", () => {
  assert.equal(buildEvidenceRecord(input()).record.schemaVersion, EVIDENCE_SCHEMA_VERSION);
});

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

test("a record is written atomically with restrictive permissions", async () => {
  const d = await dir();
  const { record } = buildEvidenceRecord(input());
  const out = await writeEvidenceRecord(d, record);
  assert.equal(out.ok, true);

  const files = await readdir(d);
  assert.deepEqual(files, [`${record.evidenceId}.json`], "no temporary file is left behind");
  assert.equal((await stat(out.path)).mode & 0o777, 0o600);
  assert.equal((await stat(d)).mode & 0o700, 0o700);
  assert.deepEqual(JSON.parse(await readFile(out.path, "utf8")), record);
  await rm(d, { recursive: true, force: true });
});

test("an unwritable store never throws", async () => {
  // Capture is best-effort. A logging subsystem that can break delivery is the
  // wrong trade for a shadow feature.
  const d = await dir();
  await chmod(d, 0o500);
  const { record } = buildEvidenceRecord(input());
  const out = await writeEvidenceRecord(path.join(d, "nested"), record);
  assert.equal(out.ok, false);
  await chmod(d, 0o700);
  await rm(d, { recursive: true, force: true });
});

test("capture reports references and outcome, never excerpt text", async () => {
  const d = await dir();
  const out = await captureEvidence({ dir: d, budget: createTurnBudget(), ...input() });
  assert.equal(out.captured, true);
  assert.match(out.evidenceId, /^ev_/);
  assert.equal("excerpt" in out, false, "telemetry must reference, not embed");
  await rm(d, { recursive: true, force: true });
});

test("a skipped capture reports why and stores nothing", async () => {
  const d = await dir();
  const out = await captureEvidence({ dir: d, budget: createTurnBudget(), ...input({ tool: "exec" }) });
  assert.equal(out.captured, false);
  assert.equal(out.reason, "tool_not_capturable");
  assert.deepEqual(await readdir(d), []);
  await rm(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

test("evidence past its window is pruned", async () => {
  const d = await dir();
  const { record } = buildEvidenceRecord(input());
  await writeEvidenceRecord(d, record);
  assert.equal(await pruneEvidenceCapture(d, 14, null, () => Date.now()), 0, "fresh evidence stays");
  const later = Date.now() + 15 * 24 * 60 * 60 * 1000;
  assert.equal(await pruneEvidenceCapture(d, 14, null, () => later), 1);
  assert.deepEqual(await readdir(d), []);
  await rm(d, { recursive: true, force: true });
});

test("pruning a missing directory is not an error", async () => {
  assert.equal(await pruneEvidenceCapture("/nonexistent/evidence", 14, null), 0);
});
