// The benchmark must be present, tracked, and unchanged in shape.
//
// A .gitignore rule intended for telemetry (`*.jsonl`) silently excluded the
// corpus fixture from the previous commit. The package shipped an extractor and
// a harness without the data they run on, and nothing failed — because no test
// loaded the fixture. This is that test.
//
// The counts are asserted exactly. If the corpus grows, these numbers change in
// the same commit as the corpus, which is the point: a benchmark that can drift
// silently is not a benchmark.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CLAIM_TYPES, MODALITIES, EVIDENCE_KINDS } from "../src/claims.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = path.join(ROOT, "tests", "fixtures");

const SPLITS = {
  "claims-corpus-dev.jsonl": 92,
  "claims-corpus-validation.jsonl": 8,
  "claims-corpus-test-v2.jsonl": 17,
};
const BASELINE = "claims-corpus-baseline-v1.jsonl";

function load(name) {
  return readFileSync(path.join(FIXTURES, name), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

const all = Object.keys(SPLITS).flatMap((f) => load(f).map((r) => ({ ...r, __file: f })));

test("every corpus file is tracked by git", () => {
  // The failure this whole file exists for: present on disk, absent from the
  // package, invisible to the suite.
  for (const name of [...Object.keys(SPLITS), BASELINE]) {
    assert.doesNotThrow(
      () => execFileSync("git", ["ls-files", "--error-unmatch", `tests/fixtures/${name}`], {
        cwd: ROOT, stdio: "pipe",
      }),
      `tests/fixtures/${name} is not tracked`,
    );
  }
});

test("the v2 corpus has the committed shape", () => {
  assert.equal(all.length, 117, "turns");
  assert.equal(all.reduce((n, r) => n + r.goldClaims.length, 0), 101, "gold claims");
  assert.equal(new Set(all.map((r) => r.groupId)).size, 50, "groups");
  assert.equal(new Set(all.map((r) => r.scenarioFamily)).size, 18, "families");
});

test("each split has its committed size", () => {
  for (const [file, expected] of Object.entries(SPLITS)) {
    assert.equal(load(file).length, expected, file);
  }
});

test("no group spans two splits", () => {
  // Paraphrases of one scenario landing in different splits would credit the
  // extractor with generalisation it never demonstrated.
  const where = new Map();
  for (const r of all) {
    const key = `${r.scenarioFamily}::${r.groupId}`;
    const seen = where.get(key);
    assert.ok(seen === undefined || seen === r.__file, `${key} appears in ${seen} and ${r.__file}`);
    where.set(key, r.__file);
  }
});

test("every family is represented in dev", () => {
  // Stratification exists so the families that need prompt work are tunable.
  // Pure group hashing left bare-answer with three gold claims in dev.
  const dev = new Set(load("claims-corpus-dev.jsonl").map((r) => r.scenarioFamily));
  const missing = [...new Set(all.map((r) => r.scenarioFamily))].filter((f) => !dev.has(f));
  assert.deepEqual(missing, [], "families absent from dev");
});

test("gold labels are on-schema", () => {
  for (const r of all) {
    for (const c of r.goldClaims) {
      assert.ok(CLAIM_TYPES.includes(c.claimType), `${r.id}: ${c.claimType}`);
      assert.ok(MODALITIES.includes(c.modality), `${r.id}: ${c.modality}`);
      for (const e of c.requiredEvidence) {
        assert.ok(EVIDENCE_KINDS.includes(e) || e.startsWith("claim:"), `${r.id}: ${e}`);
      }
      assert.ok(c.surfaceText && c.proposition, `${r.id}: v2 fields required`);
    }
    // Premises are facts the answer requires but never states. They carry no
    // span by definition — that is the whole reason they are not claims — so a
    // premise with a surfaceText would mean the correction had been undone.
    for (const premise of r.goldPremises ?? []) {
      assert.ok(CLAIM_TYPES.includes(premise.sourceType), `${r.id}: ${premise.sourceType}`);
      assert.ok(premise.proposition, `${r.id}: a premise needs a proposition`);
      assert.equal(premise.surfaceText, undefined, `${r.id}: a premise must not claim a span`);
      for (const e of premise.requiredEvidence) {
        assert.ok(EVIDENCE_KINDS.includes(e), `${r.id}: ${e}`);
      }
    }
  }
});

test("implicit-premise cases are labelled as one claim plus premises", () => {
  // The case that failed in five of five runs. Gold demanded three
  // draft-anchored claims for a sentence that states only the comparison, which
  // is not expressible: there is no span to anchor the premises to.
  const implicit = all.filter((r) => (r.goldPremises ?? []).length > 0);
  assert.ok(implicit.length >= 3, "expected the corrected composite cases");
  for (const r of implicit) {
    assert.equal(r.goldClaims.length, 1, `${r.id}: the draft asserts one thing`);
    assert.ok(r.goldClaims[0].dependsOnPremises?.length >= 2, `${r.id}: premises must be referenced`);
    assert.ok(r.goldRationale, `${r.id}: the correction needs a recorded reason`);
  }
});

test("conversational turns are labelled with zero claims", () => {
  // The population the false-positive rate is computed over. If one of these
  // acquired a gold claim, the metric would quietly stop meaning anything.
  const conversational = new Set(["acknowledgement", "greeting", "signoff", "dismissal", "uncertainty"]);
  for (const r of all.filter((x) => conversational.has(x.scenarioFamily))) {
    assert.equal(r.goldClaims.length, 0, `${r.id} (${r.scenarioFamily}) should have no gold claims`);
  }
});

test("the frozen v1 baseline is unchanged", () => {
  const v1 = load(BASELINE);
  assert.equal(v1.length, 24, "baseline turns");
  assert.equal(v1.reduce((n, r) => n + r.goldClaims.length, 0), 21, "baseline gold claims");
});
