#!/usr/bin/env node
// The shadow observation report, and the review sample.
//
// Reads the telemetry and extraction stores and prints JSON. Never writes to
// either store, never calls a model, never touches a running agent. Safe to run
// against a live deployment's data.
//
//   node scripts/shadow-report.mjs \
//     --telemetry    ~/.openclaw/var/llm-grounded/telemetry \
//     --extractions  ~/.openclaw/var/llm-grounded/claim-extraction \
//     [--since 2026-07-28] [--sample] \
//     [--price-input 0.27 --price-output 1.10]
//
// Prices are per million tokens and must be supplied deliberately: a cost table
// computed from a guessed rate is worse than no cost table.

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { reviewSample, shadowMetrics } from "../src/shadow-metrics.js";

function args(argv) {
  const out = { since: null, sample: false, pricing: null, eligible: null, windowEpoch: null };
  let priceIn = null;
  let priceOut = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--sample") out.sample = true;
    else if (a === "--telemetry") out.telemetry = argv[++i];
    else if (a === "--extractions") out.extractions = argv[++i];
    else if (a === "--since") out.since = Date.parse(argv[++i]);
    else if (a === "--price-input") priceIn = Number(argv[++i]);
    else if (a === "--price-output") priceOut = Number(argv[++i]);
    else if (a === "--eligible") out.eligible = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--window-epoch") out.windowEpoch = argv[++i];
  }
  if (!out.telemetry) throw new Error("usage: shadow-report.mjs --telemetry <dir> [--extractions <dir>] [--sample]");
  if (Number.isFinite(priceIn) && Number.isFinite(priceOut)) {
    out.pricing = { inputPerMillion: priceIn, outputPerMillion: priceOut, currency: "USD" };
  } else if (priceIn !== null || priceOut !== null) {
    throw new Error("--price-input and --price-output must be given together");
  }
  return out;
}

async function turnRecords(dir, { since }) {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl")).sort();
  const out = [];
  for (const file of files) {
    let text;
    try {
      text = await readFile(path.join(dir, file), "utf8");
    } catch {
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
      if (since !== null && Number.isFinite(since)) {
        const at = Date.parse(record.ts ?? "");
        if (!Number.isFinite(at) || at < since) continue;
      }
      out.push(record);
    }
  }
  return out;
}

/** Every extraction record, by id. Null when the store was not given. */
async function extractionRecords(dir) {
  if (!dir) return null;
  const byId = new Map();
  let names;
  try {
    names = await readdir(dir);
  } catch {
    process.stderr.write(`extraction store unreadable: ${dir}\n`);
    return new Map();
  }
  for (const name of names) {
    if (!name.startsWith("cx_") || !name.endsWith(".json")) continue;
    try {
      const record = JSON.parse(await readFile(path.join(dir, name), "utf8"));
      byId.set(record.extractionId, record);
    } catch {
      process.stderr.write(`skipped unreadable extraction record: ${name}\n`);
    }
  }
  return byId;
}

const opts = args(process.argv.slice(2));
const turns = await turnRecords(opts.telemetry, opts);
const extractions = await extractionRecords(opts.extractions);

const report = {
  generatedAt: new Date().toISOString(),
  turnsRead: turns.length,
  extractionsRead: extractions ? extractions.size : null,
  ...shadowMetrics(turns, extractions, {
    eligible: opts.eligible,
    pricing: opts.pricing,
    windowEpoch: opts.windowEpoch,
  }),
};

if (opts.sample) report.reviewSample = reviewSample(turns, extractions, { eligible: opts.eligible });

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
