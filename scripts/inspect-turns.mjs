#!/usr/bin/env node
// Offline evidence inspection: join turn records to the excerpts they cite.
//
// Reads two directories that already exist and writes JSONL to stdout. It never
// retrieves, never calls a model, never touches a running agent, and never
// writes to either store. Safe to run against a live deployment's data.
//
//   node scripts/inspect-turns.mjs \
//     --telemetry   ~/.openclaw/var/llm-grounded/telemetry \
//     --evidence    ~/.openclaw/var/llm-grounded/evidence-capture \
//     [--extractions ~/.openclaw/var/llm-grounded/claim-extraction] \
//     [--traffic human,synthetic_test] [--since 2026-07-28] [--summary]
//     [--settlement-seconds 60]
//
// Extraction runs after delivery, so a turn record can be written and read
// before its extraction record exists. Within the settlement window that reads
// as `pending`, not as loss.

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { inspectTurn, summarizeInspections } from "../src/inspection.js";

function args(argv) {
  const out = { traffic: null, since: null, summary: false, retentionDays: 14, extractions: null, settlementMs: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--summary") out.summary = true;
    else if (a === "--telemetry") out.telemetry = argv[++i];
    else if (a === "--evidence") out.evidence = argv[++i];
    else if (a === "--extractions") out.extractions = argv[++i];
    else if (a === "--settlement-seconds") out.settlementMs = Number(argv[++i]) * 1000;
    else if (a === "--traffic") out.traffic = new Set(argv[++i].split(",").map((s) => s.trim()).filter(Boolean));
    else if (a === "--since") out.since = Date.parse(argv[++i]);
    else if (a === "--retention-days") out.retentionDays = Number(argv[++i]);
  }
  if (!out.telemetry || !out.evidence) {
    throw new Error("usage: inspect-turns.mjs --telemetry <dir> --evidence <dir> [--traffic a,b] [--since ISO] [--summary]");
  }
  return out;
}

/** Every turn record in the day files, oldest first. */
async function* turnRecords(dir, { since, traffic }) {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl")).sort();
  for (const file of files) {
    let text;
    try {
      text = await readFile(path.join(dir, file), "utf8");
    } catch {
      // A day file that cannot be read is reported and skipped: a partial
      // corpus is usable, a crash halfway through is not.
      process.stderr.write(`skipped unreadable day file: ${file}\n`);
      continue;
    }
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      let record;
      try {
        record = JSON.parse(trimmed);
      } catch {
        process.stderr.write(`skipped malformed record in ${file}\n`);
        continue;
      }
      if (traffic && !traffic.has(record.trafficClass)) continue;
      if (since !== null && Number.isFinite(since)) {
        const at = Date.parse(record.ts ?? "");
        if (!Number.isFinite(at) || at < since) continue;
      }
      yield record;
    }
  }
}

/**
 * Read one record by id, distinguishing absent from unreadable.
 *
 * The id becomes a filename, so it is matched against a strict pattern first:
 * an id read out of a record must not be able to name a path outside the store.
 */
function recordReader(dir, pattern) {
  return async (id) => {
    if (!dir || !pattern.test(id)) return { ok: false, reason: "unreadable" };
    let text;
    try {
      text = await readFile(path.join(dir, `${id}.json`), "utf8");
    } catch (err) {
      return { ok: false, reason: err?.code === "ENOENT" ? "missing" : "unreadable" };
    }
    try {
      return { ok: true, record: JSON.parse(text) };
    } catch {
      return { ok: false, reason: "unreadable" };
    }
  };
}

const opts = args(process.argv.slice(2));
const readEvidence = recordReader(opts.evidence, /^ev_[A-Za-z0-9-]+$/);
const readExtraction = opts.extractions ? recordReader(opts.extractions, /^cx_[A-Za-z0-9-]+$/) : undefined;
const inspections = [];

for await (const turn of turnRecords(opts.telemetry, opts)) {
  const inspection = await inspectTurn(turn, {
    readEvidence,
    readExtraction,
    retentionDays: opts.retentionDays,
    settlementMs: opts.settlementMs,
  });
  inspections.push(inspection);
  if (!opts.summary) process.stdout.write(`${JSON.stringify(inspection)}\n`);
}

if (opts.summary) {
  process.stdout.write(`${JSON.stringify(summarizeInspections(inspections), null, 2)}\n`);
}
