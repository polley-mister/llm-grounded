#!/usr/bin/env node
//
// Aggregate repeated runs of the same corpus into stability metrics.
//
// Repetition is for *measuring* instability, not hiding it: there are no
// retries anywhere in this path. A turn that abstained in three runs of five
// abstained in three runs of five.
//
//   node scripts/claims-stability.mjs var/stability-*.jsonl
//
// Reports agreement per turn — did the extractor decide the same thing each
// time — alongside the distribution of what it decided. A metric that is
// excellent on average and unstable per turn is not usable for single-pass
// enforcement, and averaging hides exactly that.

import { readFile } from "node:fs/promises";

function mode(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = null;
  let bestN = 0;
  for (const [v, n] of counts) if (n > bestN) { best = v; bestN = n; }
  return { value: best, count: bestN, agreement: bestN / values.length };
}

const files = process.argv.slice(2);
if (!files.length) {
  console.log("usage: claims-stability.mjs <run.jsonl> [run.jsonl ...]");
  process.exit(1);
}

const runs = [];
for (const f of files) {
  const rows = (await readFile(f, "utf8")).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  runs.push({ file: f, rows });
}

console.log(`runs: ${runs.length}`);
for (const r of runs) console.log(`  ${r.file}  ${r.rows.length} records`);

// Index by turn.
const byTurn = new Map();
for (const run of runs) {
  for (const row of run.rows) {
    if (!byTurn.has(row.turnId)) byTurn.set(row.turnId, []);
    byTurn.get(row.turnId).push(row);
  }
}

const complete = [...byTurn.values()].filter((v) => v.length === runs.length);
console.log(`turns present in every run: ${complete.length} of ${byTurn.size}\n`);

// --- per-run headline counts ----------------------------------------------
console.log("per-run outcome counts");
for (const run of runs) {
  const c = { extracted: 0, no_claims: 0, abstained: 0 };
  const reasons = {};
  let fp = 0;
  for (const row of run.rows) {
    c[row.extractionStatus] = (c[row.extractionStatus] ?? 0) + 1;
    if (row.abstentionReason) reasons[row.abstentionReason] = (reasons[row.abstentionReason] ?? 0) + 1;
    if (Array.isArray(row.goldClaims) && row.goldClaims.length === 0 &&
        row.predictedClaims.some((p) => p.material && p.verificationTarget)) fp += 1;
  }
  const lat = run.rows.map((r) => r.latencyMs).filter((n) => Number.isFinite(n));
  const med = lat.length ? lat.slice().sort((a, b) => a - b)[Math.floor(lat.length / 2)] : null;
  console.log(
    `  ${run.file.split("/").pop().padEnd(28)} extracted ${String(c.extracted).padStart(3)}  ` +
    `no_claims ${String(c.no_claims).padStart(3)}  abstained ${String(c.abstained).padStart(2)} ` +
    `${JSON.stringify(reasons)}  convFP ${fp}  medianLatency ${med ?? "n/a"}ms`,
  );
}

// --- agreement -------------------------------------------------------------
const agg = {
  status: [], claimCount: [], types: [], materiality: [], decomposition: [],
};
const unstable = [];

for (const [turnId, rows] of byTurn) {
  if (rows.length !== runs.length) continue;
  const statuses = rows.map((r) => r.extractionStatus);
  const counts = rows.map((r) => r.predictedClaims.length);
  const typeSets = rows.map((r) => r.predictedClaims.map((p) => p.claimType).sort().join(","));
  const matSets = rows.map((r) => r.predictedClaims.filter((p) => p.material).length);

  const s = mode(statuses), c = mode(counts), t = mode(typeSets), mt = mode(matSets);
  agg.status.push(s.agreement);
  agg.claimCount.push(c.agreement);
  agg.types.push(t.agreement);
  agg.materiality.push(mt.agreement);

  if (s.agreement < 1 || c.agreement < 1) {
    unstable.push({
      turnId,
      family: rows[0].scenarioFamily,
      draft: (rows[0].draft ?? "").slice(0, 52),
      statuses: statuses.join("/"),
      counts: counts.join("/"),
    });
  }
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const pct = (n) => `${(n * 100).toFixed(1)}%`;

console.log("\nagreement across runs (1.0 = identical every time)");
console.log(`  status agreement:      ${pct(mean(agg.status))}`);
console.log(`  claim-count agreement: ${pct(mean(agg.claimCount))}`);
console.log(`  claim-type agreement:  ${pct(mean(agg.types))}`);
console.log(`  materiality agreement: ${pct(mean(agg.materiality))}`);

// --- per-turn frequency for the cases under scrutiny ----------------------
console.log("\nconversational false positives, per turn across runs");
let anyFp = false;
for (const [, rows] of byTurn) {
  if (!Array.isArray(rows[0].goldClaims) || rows[0].goldClaims.length !== 0) continue;
  const hits = rows.filter((r) => r.predictedClaims.some((p) => p.material && p.verificationTarget)).length;
  if (hits === 0) continue;
  anyFp = true;
  console.log(`  ${hits}/${rows.length}  ${JSON.stringify(rows[0].draft)}  (turn ${JSON.stringify(rows[0].userTurn)})`);
}
if (!anyFp) console.log("  none in any run");

console.log("\ncomposite cases, decomposition per turn across runs");
for (const [, rows] of byTurn) {
  if (rows[0].scenarioFamily !== "composite") continue;
  const ok = rows.filter((r) => {
    if (r.extractionStatus === "abstained") return false;
    const bundled = r.predictedClaims.some(
      (p) => ["web", "memory", "system"].filter((k) => (p.requiredEvidence ?? []).includes(k)).length > 1,
    );
    return r.predictedClaims.length >= r.goldClaims.length && !bundled;
  }).length;
  console.log(`  ${ok}/${rows.length}  ${JSON.stringify(rows[0].draft.slice(0, 60))}`);
}

if (unstable.length) {
  console.log(`\nturns that did not decide the same way every run (${unstable.length})`);
  for (const u of unstable.slice(0, 20)) {
    console.log(`  ${u.family.padEnd(20)} status ${u.statuses.padEnd(30)} counts ${u.counts.padEnd(12)} ${JSON.stringify(u.draft)}`);
  }
}

// --- token usage -----------------------------------------------------------
const usages = runs.flatMap((r) => r.rows.map((x) => x.usage).filter(Boolean));
if (usages.length) {
  const out = usages.map((u) => u.completion_tokens ?? u.output_tokens).filter(Number.isFinite);
  if (out.length) {
    const sorted = out.slice().sort((a, b) => a - b);
    console.log(`\noutput tokens: median ${sorted[Math.floor(sorted.length / 2)]}, ` +
      `p95 ${sorted[Math.floor(sorted.length * 0.95)]}, max ${sorted.at(-1)} (budget 16000)`);
  }
}
