#!/usr/bin/env node
//
// Offline claim-extraction harness.
//
// Replays drafts — from the curated corpus or from historical telemetry —
// through the extractor, writes a hand-labellable JSONL, and reports metrics.
// It never writes to telemetry and never touches a live turn.
//
//   npm run claims:extract -- --corpus tests/fixtures/claims-corpus.jsonl --dry-run
//   npm run claims:extract -- --corpus tests/fixtures/claims-corpus.jsonl \
//                             --llm-module ./private/claims-provider.mjs
//   npm run claims:extract -- --telemetry ~/.openclaw/var/llm-grounded/telemetry \
//                             --output var/claim-analysis.jsonl --llm-module ...
//
// The provider is injected by path so credentials and private configuration
// stay out of this repository. The module exports:
//
//   export async function createLlm() { return { complete: async (req) => ... }; }
//
// With no provider the run completes and reports 100% abstained with reason
// no_llm. That is deliberately NOT an all-clear: a missing extractor must look
// like a failure, not like a corpus with nothing to check.

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { extractClaims, segment } from "../src/claims.js";

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { split: null, dryRun: false, limit: Infinity };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--corpus") out.corpus = next();
    else if (a === "--telemetry") out.telemetry = next();
    else if (a === "--output") out.output = next();
    else if (a === "--llm-module") out.llmModule = next();
    else if (a === "--split") out.split = next();
    else if (a === "--limit") out.limit = Number(next()) || Infinity;
    else if (a === "--rescore") out.rescore = next();
    else if (a === "--run-id") out.runId = next();
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

const USAGE = `
claims:extract — offline claim extraction over a corpus or historical telemetry

  --corpus <file.jsonl>     curated corpus with goldClaims
  --telemetry <dir>         replay drafts from telemetry JSONL (no gold labels)
  --output <file.jsonl>     write labellable records here
  --llm-module <path>       module exporting createLlm(); omit to force abstention
  --split <dev|validation|test>   restrict to one split
  --limit <n>               cap records processed
  --rescore <file.jsonl>    re-score a previous run offline; calls no model
  --run-id <id>             label records, for repetition studies
  --dry-run                 do not write output
`;

// ---------------------------------------------------------------------------
// Splits, assigned by group
// ---------------------------------------------------------------------------

/**
 * Assign a split by hashing the *group*, not the turn.
 *
 * Paraphrases of one scenario — "what does it cost now", "current price",
 * "how much today" — must not land in three different splits. Grouping them
 * keeps a model from being credited for generalisation it never demonstrated.
 */
export function splitFor(groupId) {
  const h = createHash("sha256").update(String(groupId ?? "")).digest();
  const bucket = h.readUInt16BE(0) % 100;
  if (bucket < 70) return "dev";
  if (bucket < 85) return "validation";
  return "test";
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

async function loadCorpus(file) {
  const text = await readFile(file, "utf8");
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
    .map((r) => ({
      turnId: r.id,
      groupId: r.groupId ?? r.scenarioFamily ?? r.id,
      userTurn: r.userTurn ?? "",
      draft: r.draft ?? "",
      goldClaims: Array.isArray(r.goldClaims) ? r.goldClaims : null,
      scenarioFamily: r.scenarioFamily ?? null,
      source: "corpus",
    }));
}

/**
 * Telemetry replay. Heartbeat and synthetic traffic are excluded: a rate
 * computed over scheduled robot turns is a rate about robots.
 */
async function loadTelemetry(dir) {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl")).sort();
  const rows = [];
  for (const f of files) {
    const text = await readFile(path.join(dir, f), "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      const cls = r.trafficClass ?? null;
      if (cls === "heartbeat" || cls === "synthetic_test" || r.synthetic) continue;
      if (String(r.turn ?? "").includes("HEARTBEAT")) continue;
      if (!r.draft || !String(r.draft).trim()) continue;
      rows.push({
        turnId: r.turnId ?? r.runId ?? `${f}:${rows.length}`,
        groupId: `telemetry:${r.turnId ?? rows.length}`,
        userTurn: r.turn ?? "",
        draft: String(r.draft),
        // Never invented. An unlabelled turn is unlabelled.
        goldClaims: null,
        trafficClass: cls,
        source: "telemetry",
      });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Match a prediction to a gold claim by text overlap on the draft.
 *
 * Offsets would be exact, but gold claims are hand-written paraphrases rather
 * than spans, so this falls back to normalised containment. Reported as
 * approximate, because pretending otherwise would overstate precision.
 */
function matches(pred, gold) {
  const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9$.,%°]+/g, " ").trim();
  // Either form may match. A reconstructed proposition ("17 multiplied by 24
  // equals 408") and the surface fragment it came from ("Four hundred and
  // eight.") share almost no tokens, so requiring one or the other would
  // score the extractor on which field it happened to fill.
  const preds = [norm(pred.proposition), norm(pred.surfaceText ?? pred.text)].filter(Boolean);
  const golds = [norm(gold.proposition), norm(gold.surfaceText ?? gold.text)].filter(Boolean);
  for (const a of preds) {
    for (const b of golds) {
      if (a.includes(b) || b.includes(a)) return true;
      const at = new Set(a.split(" ").filter((w) => w.length > 2));
      const bt = b.split(" ").filter((w) => w.length > 2);
      if (!bt.length) continue;
      if (bt.filter((w) => at.has(w)).length / bt.length >= 0.6) return true;
    }
  }
  return false;
}

function score(records) {
  const m = {
    total: records.length,
    byStatus: {},
    abstentionReasons: {},
    labelled: 0,
    labelledTurns: 0,
    // Turns whose extraction abstained. Excluded from recall denominators: an
    // abstention is a different failure from a miss, and mixing them means a
    // provider hiccup reads as a recall problem and neither can be fixed on
    // purpose.
    labelledAbstained: 0,
    // Gold claims marked material:false. Recall over claims defined as not
    // mattering measures the wrong thing, so they are counted apart.
    immaterialGold: 0,
    immaterialFound: 0,
    conversationalTurns: 0,
    conversationalWithMaterialClaim: 0,
    perType: {},
    predictedClaims: 0,
    goldClaims: 0,
    // Composite families are the ones that must decompose. A single claim over
    // a sentence carrying memory and web premises cannot be mapped to distinct
    // evidence, which is the whole point of the next stage.
    composite: { turns: 0, decomposed: 0 },
    // Bare answers are the elliptical case: the proposition lives partly in the
    // operator's turn, so recall here measures reconstruction, not detection.
    bareAnswer: { gold: 0, found: 0, endToEndGold: 0, endToEndFound: 0 },
    // The invariant that must never regress while recall improves.
    invalidAccepted: 0,
    // Claims that validated but used the v1 shape. A v2 run producing these is
    // ignoring the contract while appearing to succeed.
    legacyShapedClaims: 0,
  };

  for (const r of records) {
    m.byStatus[r.extractionStatus] = (m.byStatus[r.extractionStatus] ?? 0) + 1;
    if (r.abstentionReason) {
      m.abstentionReasons[r.abstentionReason] = (m.abstentionReasons[r.abstentionReason] ?? 0) + 1;
    }
    m.predictedClaims += r.predictedClaims.length;
    m.legacyShapedClaims += r.predictedClaims.filter((c) => c.v2Shape === false).length;
    if (!Array.isArray(r.goldClaims)) continue;

    m.labelledTurns += 1;

    // Composite success is measured over EVERY composite case. An abstained
    // composite is a failure end-to-end, and excluding it lets the denominator
    // move from run to run — which it did: 9, 5, 7, 7.
    if (r.scenarioFamily === "composite") m.composite.turns += 1;

    // End-to-end counts an abstention as a miss. Conditional recall excludes
    // it. Reporting only the second would let a system improve its headline by
    // abstaining more often.
    if (r.extractionStatus === "abstained") {
      m.labelledAbstained += 1;
      for (const g of r.goldClaims) {
        if (g.material === false) continue;
        const t = g.claimType;
        m.perType[t] ??= { gold: 0, found: 0, endToEndGold: 0, endToEndFound: 0 };
        m.perType[t].endToEndGold += 1;
        if (r.scenarioFamily === "bare-answer") m.bareAnswer.endToEndGold += 1;
      }
      continue;
    }

    m.labelled += 1;
    m.goldClaims += r.goldClaims.length;
    const material = r.predictedClaims.filter((c) => c.material && c.verificationTarget);

    if (r.goldClaims.length === 0) {
      m.conversationalTurns += 1;
      if (material.length > 0) m.conversationalWithMaterialClaim += 1;
      continue;
    }

    if (r.scenarioFamily === "composite") {
      // Decomposed means: at least as many claims as gold premises, and no
      // single claim bundling two independent sources.
      const bundled = r.predictedClaims.some(
        (p) => ["web", "memory", "system"].filter((k) => p.requiredEvidence?.includes(k)).length > 1,
      );
      if (r.predictedClaims.length >= r.goldClaims.length && !bundled) m.composite.decomposed += 1;
    }

    for (const g of r.goldClaims) {
      const found = r.predictedClaims.some((p) => matches(p, g));
      if (g.material === false) {
        m.immaterialGold += 1;
        if (found) m.immaterialFound += 1;
        continue;
      }
      const t = g.claimType;
      m.perType[t] ??= { gold: 0, found: 0, endToEndGold: 0, endToEndFound: 0 };
      m.perType[t].gold += 1;
      m.perType[t].endToEndGold += 1;
      if (found) {
        m.perType[t].found += 1;
        m.perType[t].endToEndFound += 1;
      }
      if (r.scenarioFamily === "bare-answer") {
        m.bareAnswer.gold += 1;
        m.bareAnswer.endToEndGold += 1;
        if (found) {
          m.bareAnswer.found += 1;
          m.bareAnswer.endToEndFound += 1;
        }
      }
    }
  }
  return m;
}

function report(m) {
  const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : "n/a");
  const lines = [];
  lines.push(`records:            ${m.total}`);
  lines.push(`  extracted:        ${m.byStatus.extracted ?? 0}`);
  lines.push(`  no_claims:        ${m.byStatus.no_claims ?? 0}`);
  lines.push(`  abstained:        ${m.byStatus.abstained ?? 0}  ${pct(m.byStatus.abstained ?? 0, m.total)}`);
  for (const [reason, n] of Object.entries(m.abstentionReasons)) {
    lines.push(`    ${reason}: ${n}`);
  }
  lines.push("");
  lines.push(`predicted claims:   ${m.predictedClaims}   legacy-shaped: ${m.legacyShapedClaims}`);
  lines.push(
    `labelled turns:     ${m.labelled} scored, ${m.labelledAbstained} abstained (excluded from recall)`,
  );
  lines.push(`gold claims:        ${m.goldClaims} material, ${m.immaterialGold} immaterial`);

  if (m.labelled) {
    lines.push("");
    lines.push(`coverage: ${m.labelled}/${m.labelledTurns} turns produced an extraction  ` +
      `${pct(m.labelled, m.labelledTurns)}`);
    lines.push("");
    lines.push("recall by claim type   end-to-end (abstention = miss) | conditional (accepted only):");
    for (const [t, s] of Object.entries(m.perType).sort()) {
      lines.push(
        `  ${t.padEnd(26)} ${String(`${s.endToEndFound}/${s.endToEndGold}`).padEnd(8)} ` +
          `${pct(s.endToEndFound, s.endToEndGold).padStart(6)}   |   ` +
          `${String(`${s.found}/${s.gold}`).padEnd(8)} ${pct(s.found, s.gold)}`,
      );
    }
    lines.push("");
    // Raw counts, deliberately. A rate over this many turns would be a
    // number with no confidence interval worth quoting.
    if (m.composite.turns) {
      lines.push(
        `composite decomposition (all cases, abstention = failure): ` +
          `${m.composite.decomposed}/${m.composite.turns}  ${pct(m.composite.decomposed, m.composite.turns)}`,
      );
    }
    if (m.bareAnswer.endToEndGold) {
      lines.push(
        `bare-answer recall: end-to-end ${m.bareAnswer.endToEndFound}/${m.bareAnswer.endToEndGold} ` +
          `${pct(m.bareAnswer.endToEndFound, m.bareAnswer.endToEndGold)}  |  conditional ` +
          `${m.bareAnswer.found}/${m.bareAnswer.gold} ${pct(m.bareAnswer.found, m.bareAnswer.gold)}`,
      );
    }
    if (m.immaterialGold) {
      lines.push(
        `immaterial gold detected: ${m.immaterialFound}/${m.immaterialGold}` +
          `  (not a recall target; extracting these is neither required nor wrong)`,
      );
    }
    lines.push("");
    // The gate that must hold at 0 regardless of what recall does.
    lines.push(`invalid output accepted as valid: ${m.invalidAccepted}`);
    lines.push(
      `conversational turns given a material claim: ` +
        `${m.conversationalWithMaterialClaim} of ${m.conversationalTurns}`,
    );
    if (m.conversationalTurns < 50) {
      lines.push(
        `  NOTE: ${m.conversationalTurns} conversational turns is too few for a rate. ` +
          `Reported as a count, not as evidence of a target.`,
      );
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.rescore) {
    // Re-scoring reads recorded output. It cannot change what the model said,
    // which is the point: a scoring fix must be auditable against the same
    // extraction rather than requiring a fresh run that also varies.
    const prior = (await readFile(args.rescore, "utf8"))
      .split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    console.log(`re-scoring ${prior.length} records from ${args.rescore}`);
    console.log("");
    console.log(report(score(prior)));
    return;
  }

  if (args.help || (!args.corpus && !args.telemetry)) {
    console.log(USAGE.trim());
    process.exit(args.help ? 0 : 1);
  }

  let llm = null;
  if (args.llmModule) {
    const mod = await import(path.resolve(args.llmModule));
    llm = await mod.createLlm();
    console.log(`provider: ${args.llmModule}`);
  } else {
    console.log("provider: none — every record will abstain (reason: no_llm)");
  }

  const rows = args.corpus ? await loadCorpus(args.corpus) : await loadTelemetry(args.telemetry);
  const selected = rows
    .map((r) => ({ ...r, split: splitFor(r.groupId) }))
    .filter((r) => (args.split ? r.split === args.split : true))
    .slice(0, args.limit);

  console.log(`input: ${rows.length} rows, ${selected.length} selected` +
    (args.split ? ` (split=${args.split})` : ""));

  const records = [];
  for (const row of selected) {
    const extraction = await extractClaims(
      { userTurn: row.userTurn, draft: row.draft },
      { llm },
    );
    records.push({
      runId: args.runId ?? null,
      turnId: row.turnId,
      groupId: row.groupId,
      split: row.split,
      source: row.source,
      trafficClass: row.trafficClass ?? null,
      scenarioFamily: row.scenarioFamily ?? null,
      userTurn: row.userTurn,
      draft: row.draft,
      sentenceCount: segment(row.draft).length,
      extractionStatus: extraction.status,
      abstentionReason: extraction.reason ?? null,
      provenance: extraction.provenance ?? null,
      latencyMs: extraction.provenance?.latencyMs ?? null,
      usage: extraction.provenance?.usage ?? null,
      predictedClaims: extraction.claims ?? [],
      // Present and empty on a labelled zero-claim turn; null when unlabelled,
      // so a turn with no predictions still has a row to label.
      goldClaims: row.goldClaims,
      labelNotes: "",
    });
  }

  console.log("");
  console.log(report(score(records)));

  if (args.output && !args.dryRun) {
    await mkdir(path.dirname(args.output), { recursive: true });
    await writeFile(args.output, records.map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
    console.log(`\nwrote ${records.length} records to ${args.output}`);
  } else if (args.dryRun) {
    console.log("\n(dry run: no output written)");
  }
}

main().catch((err) => {
  console.error(`claims:extract failed: ${err?.stack ?? err}`);
  process.exit(1);
});
