// Claim extraction: schema, abstention, isolation, and the deterministic layer.
//
// The model is stubbed throughout. What is under test is the contract around
// it — that off-schema output abstains rather than half-parsing, that a broken
// model never reads as a clean turn, and that the preprocessing does not make
// semantic decisions on the model's behalf.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  checkAtomicity,
  extractClaims,
  parseExtraction,
  validateClaim,
  segment,
  redact,
  verificationTargets,
  CLAIM_TYPES,
  MODALITIES,
  PROMPT_VERSION,
} from "../src/claims.js";

/** A model returning exactly what it was told to return. */
function stub(text, extra = {}) {
  const calls = [];
  return {
    calls,
    complete: async (req) => {
      calls.push(req);
      if (typeof text === "function") return text(req);
      return { text, provider: "stub", model: "stub-1", ...extra };
    },
  };
}

const claim = (over = {}) => ({
  id: "c1",
  text: "The card currently costs $4,000.",
  sourceStart: 0,
  sourceEnd: 32,
  sentenceIndex: 0,
  claimType: "current_external",
  modality: "asserted",
  factual: true,
  material: true,
  verificationTarget: true,
  requiredEvidence: ["web"],
  confidence: 0.95,
  ...over,
});

const payload = (claims) => JSON.stringify({ claims });

// ---------------------------------------------------------------------------
// Abstention is not "no claims"
// ---------------------------------------------------------------------------

test("no model abstains rather than reporting a clean turn", async () => {
  // The distinction the whole metric rests on: a missing extractor must be
  // visible as a failure, not as an answer with nothing to check.
  const r = await extractClaims({ draft: "The card costs $4,000." }, {});
  assert.equal(r.status, "abstained");
  assert.equal(r.reason, "no_llm");
  assert.notEqual(r.status, "no_claims");
});

test("malformed output abstains", async () => {
  const r = await extractClaims({ draft: "x" }, { llm: stub("not json at all") });
  assert.equal(r.status, "abstained");
  assert.equal(r.reason, "malformed_output");
});

test("an off-schema claim abstains the whole extraction", async () => {
  // Partial acceptance would ship a claim set that is not what the model said.
  for (const bad of [
    claim({ claimType: "vibes" }),
    claim({ modality: "shouted" }),
    claim({ requiredEvidence: ["telepathy"] }),
    claim({ confidence: 4 }),
    claim({ text: "" }),
  ]) {
    const r = await extractClaims({ draft: "The card costs $4,000." }, { llm: stub(payload([bad])) });
    assert.equal(r.status, "abstained", JSON.stringify(bad).slice(0, 60));
    assert.equal(r.reason, "malformed_output");
  }
});

test("too many claims abstains as oversized", async () => {
  const many = Array.from({ length: 40 }, (_, i) => claim({ id: `c${i}` }));
  const r = await extractClaims({ draft: "x." }, { llm: stub(payload(many)) });
  assert.equal(r.status, "abstained");
  assert.equal(r.reason, "oversized");
});

test("an aborted call abstains as a timeout", async () => {
  const llm = { complete: async () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; } };
  const r = await extractClaims({ draft: "x." }, { llm });
  assert.equal(r.status, "abstained");
  assert.equal(r.reason, "timeout");
});

test("an empty draft abstains rather than claiming cleanliness", async () => {
  const r = await extractClaims({ draft: "   " }, { llm: stub(payload([])) });
  assert.equal(r.status, "abstained");
  assert.equal(r.reason, "empty_draft");
});

test("a confidence floor abstains rather than dropping claims", async () => {
  // Silently dropping low-confidence claims would look identical to the model
  // saying the draft was clean.
  const r = await extractClaims(
    { draft: "The card currently costs $4,000." },
    { llm: stub(payload([claim({ confidence: 0.3 })])), minConfidence: 0.7 },
  );
  assert.equal(r.status, "abstained");
  assert.equal(r.reason, "low_confidence");
});

test("a genuinely empty claim list is no_claims, not abstained", async () => {
  const r = await extractClaims({ draft: "Goodnight." }, { llm: stub(payload([])) });
  assert.equal(r.status, "no_claims");
  assert.deepEqual(r.claims, []);
  assert.equal(r.provenance.promptVersion, PROMPT_VERSION);
});

// ---------------------------------------------------------------------------
// Isolation
// ---------------------------------------------------------------------------

test("the extractor requests no tools, memory, workspace or persona", async () => {
  // Asserted rather than assumed. An extractor that can see the agent's persona
  // is being asked to reason about its own output as a character.
  const llm = stub(payload([]));
  await extractClaims({ userTurn: "hi", draft: "Hello." }, { llm });
  const req = llm.calls[0];
  assert.deepEqual(req.tools, []);
  assert.equal(req.memory, false);
  assert.equal(req.workspaceContext, false);
  assert.equal(req.persona, false);
  assert.equal(req.temperature, 0);
  assert.equal(req.purpose, "claim-extraction");
});

test("the extractor is never handed the legacy verdict", async () => {
  const llm = stub(payload([]));
  await extractClaims(
    // Even if a caller passes them, they must not reach the model.
    { draft: "Hello.", legacyVerdict: "web", features: { proper: true } },
    { llm },
  );
  const sent = JSON.stringify(llm.calls[0].messages);
  assert.doesNotMatch(sent, /legacyVerdict|"web"/);
});

test("secrets are redacted before the draft reaches the model", async () => {
  const llm = stub(payload([]));
  await extractClaims({ draft: "The key is sk-abcdefghijklmnop and it works." }, { llm });
  const sent = JSON.stringify(llm.calls[0].messages);
  assert.doesNotMatch(sent, /sk-abcdefghijklmnop/);
  assert.match(sent, /redacted/);
});

// ---------------------------------------------------------------------------
// The deterministic layer does not classify
// ---------------------------------------------------------------------------

test("questions and quotations are segmented, not dropped", () => {
  // Both carry material content despite their syntax. Removing them before the
  // model sees them is how semantic judgement gets smuggled into a regex.
  const draft = '"The update is already installed," according to the service log. The current version is 2.1, correct?';
  const spans = segment(draft);
  assert.equal(spans.length, 2);
  assert.match(spans[0].text, /already installed/);
  assert.match(spans[1].text, /2\.1, correct\?/);
});

test("segmentation preserves offsets into the draft", () => {
  const draft = "First one. Second one here. Third.";
  for (const s of segment(draft)) {
    assert.equal(draft.slice(s.start, s.end), s.text);
  }
});

test("redaction only removes, never reclassifies", () => {
  assert.equal(redact("plain words stay"), "plain words stay");
  assert.match(redact("token sk-abcdefghijklmnop here"), /\[redacted\]/);
});

// ---------------------------------------------------------------------------
// Claim semantics
// ---------------------------------------------------------------------------

test("hedged and attributed claims remain verification targets", async () => {
  // Hedging must not be an exemption, or a model learns that "probably" buys it
  // out of the contract and the gate decays into a style filter.
  const draft = "The card probably costs around $4,000. NVIDIA says it has 48 GB.";
  const r = await extractClaims({ draft }, {
    llm: stub(payload([
      claim({ id: "c1", text: "The card probably costs around $4,000.", modality: "hedged", sourceStart: 0, sourceEnd: 38 }),
      claim({ id: "c2", text: "NVIDIA says it has 48 GB.", modality: "attributed", sourceStart: 39, sourceEnd: 64, claimType: "stable_general" }),
    ])),
  });
  assert.equal(r.status, "extracted");
  assert.equal(verificationTargets(r).length, 2);
});

test("a factual but immaterial claim does not enter the ladder", async () => {
  const r = await extractClaims({ draft: "That is a common approach, but I would use a state machine." }, {
    llm: stub(payload([
      claim({ id: "c1", text: "That is a common approach.", claimType: "stable_general", material: false, verificationTarget: false, sourceStart: 0, sourceEnd: 26, requiredEvidence: ["none"] }),
      claim({ id: "c2", text: "I would use a state machine.", claimType: "opinion_or_recommendation", factual: false, material: false, verificationTarget: false, sourceStart: 31, sourceEnd: 59, requiredEvidence: ["none"] }),
    ])),
  });
  assert.equal(r.status, "extracted");
  assert.equal(verificationTargets(r).length, 0);
});

test("a composite sentence decomposes into atomic claims with multi-label evidence", async () => {
  // The exclusive-class problem must not reappear one level down.
  const draft = "Your $3,500 budget is not enough for the card's current $4,000 price.";
  const r = await extractClaims({ draft }, {
    llm: stub(payload([
      claim({ id: "c1", text: "Your budget is $3,500.", claimType: "stored_personal", requiredEvidence: ["memory"], sourceStart: 0, sourceEnd: 20 }),
      claim({ id: "c2", text: "The card currently costs $4,000.", claimType: "current_external", requiredEvidence: ["web"], sourceStart: 21, sourceEnd: 50 }),
      claim({ id: "c3", text: "$3,500 is less than $4,000.", claimType: "calculated", requiredEvidence: ["calculation", "claim:c1", "claim:c2"], sourceStart: 51, sourceEnd: 68 }),
    ])),
  });
  assert.equal(r.status, "extracted");
  assert.equal(r.claims.length, 3);
  assert.deepEqual(r.claims.map((c) => c.claimType), ["stored_personal", "current_external", "calculated"]);
  assert.deepEqual(r.claims[2].requiredEvidence, ["calculation", "claim:c1", "claim:c2"]);
});

test("a claim reference in requiredEvidence is accepted; a bogus kind is not", () => {
  const draft = "x";
  const spans = segment(draft);
  assert.ok(validateClaim(claim({ text: "x", requiredEvidence: ["claim:c1"], sourceStart: 0, sourceEnd: 1 }), { draft, spans }));
  assert.equal(validateClaim(claim({ text: "x", requiredEvidence: ["tea-leaves"] }), { draft, spans }), null);
});

test("verificationTarget is derived when the model omits it", () => {
  const draft = "The card costs $4,000.";
  const spans = segment(draft);
  const hypo = validateClaim(
    { ...claim({ text: draft, modality: "hypothetical", sourceStart: 0, sourceEnd: draft.length }), verificationTarget: undefined },
    { draft, spans },
  );
  assert.equal(hypo.verificationTarget, false, "a hypothetical is not checked");

  const asserted = validateClaim(
    { ...claim({ text: draft, sourceStart: 0, sourceEnd: draft.length }), verificationTarget: undefined },
    { draft, spans },
  );
  assert.equal(asserted.verificationTarget, true);
});

test("invented offsets are recovered from the draft rather than trusted", () => {
  // A model that hallucinates spans would silently break gold matching.
  const draft = "Nothing here. The card costs $4,000.";
  const spans = segment(draft);
  const c = validateClaim(
    claim({ text: "The card costs $4,000.", sourceStart: 9999, sourceEnd: 10005 }),
    { draft, spans },
  );
  assert.equal(draft.slice(c.sourceStart, c.sourceEnd), "The card costs $4,000.");
});

test("a fenced JSON block is tolerated", () => {
  const draft = "The card currently costs $4,000.";
  const out = parseExtraction("```json\n" + payload([claim({ text: draft, sourceStart: 0, sourceEnd: draft.length })]) + "\n```", {
    draft, spans: segment(draft),
  });
  assert.equal(out.ok, true);
  assert.equal(out.claims.length, 1);
});

test("the enums are the contract", () => {
  assert.ok(CLAIM_TYPES.includes("current_external"));
  assert.ok(CLAIM_TYPES.includes("stored_personal"));
  assert.ok(MODALITIES.includes("hedged"));
  assert.equal(CLAIM_TYPES.length, 8);
  assert.equal(MODALITIES.length, 7);
});

test("verificationTargets is empty for any non-extracted status", async () => {
  assert.deepEqual(verificationTargets(await extractClaims({ draft: "x." }, {})), []);
  assert.deepEqual(verificationTargets(await extractClaims({ draft: "x." }, { llm: stub(payload([])) })), []);
});

// ---------------------------------------------------------------------------
// surfaceText / proposition / dependsOn  (schema v2)
// ---------------------------------------------------------------------------

test("proposition may reconstruct what the draft leaves out", async () => {
  // "Four hundred and eight." is not a proposition on its own. The subject and
  // the operation live in the operator's turn, and evidence matching needs the
  // complete form — so proposition is deliberately not required to be a
  // substring of the draft.
  const draft = "Four hundred and eight.";
  const r = await extractClaims({ userTurn: "What is 17 * 24?", draft }, {
    llm: stub(payload([claim({
      surfaceText: draft,
      proposition: "17 multiplied by 24 equals 408.",
      text: undefined,
      claimType: "calculated",
      requiredEvidence: ["calculation"],
      sourceStart: 0,
      sourceEnd: draft.length,
    })])),
  });
  assert.equal(r.status, "extracted");
  assert.equal(r.claims[0].surfaceText, draft);
  assert.equal(r.claims[0].proposition, "17 multiplied by 24 equals 408.");
  assert.equal(r.claims[0].sourceStart, 0, "the surface form still locates in the draft");
});

test("proposition defaults to the surface form when absent", async () => {
  const draft = "The card currently costs $4,000.";
  const r = await extractClaims({ draft }, {
    llm: stub(payload([claim({ text: draft, sourceStart: 0, sourceEnd: draft.length })])),
  });
  assert.equal(r.status, "extracted");
  assert.equal(r.claims[0].proposition, draft);
});

test("the legacy text field still validates", async () => {
  // v1 prompts predate surfaceText. Accepting both keeps the frozen baseline
  // comparable rather than forcing a prompt change into a schema commit.
  const draft = "Water boils at 100°C.";
  const r = await extractClaims({ draft }, {
    llm: stub(payload([claim({
      text: draft, claimType: "stable_general", requiredEvidence: ["none"],
      sourceStart: 0, sourceEnd: draft.length,
    })])),
  });
  assert.equal(r.status, "extracted");
  assert.equal(r.claims[0].surfaceText, draft);
});

test("dependsOn is carried and must be strings", async () => {
  const draft = "So no.";
  const good = await extractClaims({ draft }, {
    llm: stub(payload([
      claim({ id: "c1", text: "budget", claimType: "stored_personal", requiredEvidence: ["memory"], sourceStart: 0, sourceEnd: 2 }),
      claim({ id: "c2", text: "price", claimType: "current_external", requiredEvidence: ["web"], sourceStart: 3, sourceEnd: 5 }),
      claim({ id: "c3", text: "so", claimType: "calculated", requiredEvidence: ["calculation"], dependsOn: ["c1", "c2"], sourceStart: 0, sourceEnd: 2 }),
    ])),
  });
  assert.equal(good.status, "extracted");
  assert.deepEqual(good.claims[2].dependsOn, ["c1", "c2"]);

  const bad = await extractClaims({ draft }, {
    llm: stub(payload([claim({ text: "x", dependsOn: [7], sourceStart: 0, sourceEnd: 1 })])),
  });
  assert.equal(bad.status, "abstained");
});

test("overlapping source spans are legal", async () => {
  // One sentence can carry several atomic claims, so two claims pointing into
  // the same span is correct rather than a conflict.
  const draft = "Your $3,500 budget is short of the $4,000 price.";
  const r = await extractClaims({ draft }, {
    llm: stub(payload([
      claim({ id: "c1", text: "Your $3,500 budget", claimType: "stored_personal", requiredEvidence: ["memory"], sourceStart: 0, sourceEnd: 18 }),
      claim({ id: "c2", text: "the $4,000 price", claimType: "current_external", requiredEvidence: ["web"], sourceStart: 31, sourceEnd: 47 }),
      claim({ id: "c3", text: "is short of", claimType: "calculated", requiredEvidence: ["calculation"], dependsOn: ["c1", "c2"], sourceStart: 0, sourceEnd: 47 }),
    ])),
  });
  assert.equal(r.status, "extracted");
  assert.equal(r.claims.length, 3);
});

// ---------------------------------------------------------------------------
// Atomicity
// ---------------------------------------------------------------------------

test("a claim bundling two independent sources abstains as non-atomic", async () => {
  // Whatever memory supports and whatever the web supports cannot be the same
  // assertion. Bundling them is a compound sentence wearing one label, and it
  // cannot be mapped to distinct evidence.
  const draft = "Your $3,500 budget is not enough for the current $4,000 price.";
  const r = await extractClaims({ draft }, {
    llm: stub(payload([claim({ text: draft, requiredEvidence: ["memory", "web"], sourceStart: 0, sourceEnd: draft.length })])),
  });
  assert.equal(r.status, "abstained");
  assert.equal(r.reason, "non_atomic_claims");
});

test("a calculated claim with factual peers must name its dependencies", async () => {
  const draft = "So it is not enough.";
  const r = await extractClaims({ draft }, {
    llm: stub(payload([
      claim({ id: "c1", text: "budget", claimType: "stored_personal", requiredEvidence: ["memory"], sourceStart: 0, sourceEnd: 2 }),
      claim({ id: "c2", text: "not enough", claimType: "calculated", requiredEvidence: ["calculation"], sourceStart: 3, sourceEnd: 13 }),
    ])),
  });
  assert.equal(r.status, "abstained");
  assert.equal(r.reason, "non_atomic_claims");
});

test("a bundled claim that declares dependencies is accepted", () => {
  // Multi-source is legal once the claim says it is derived: the evidence stage
  // then knows which premises it stands on.
  assert.equal(checkAtomicity([
    { claimType: "calculated", requiredEvidence: ["memory", "web"], dependsOn: ["c1", "c2"] },
  ]), null);
});

test("a lone calculated claim needs no dependencies", () => {
  // Pure arithmetic stands on nothing external.
  assert.equal(checkAtomicity([
    { claimType: "calculated", requiredEvidence: ["calculation"], dependsOn: [] },
  ]), null);
});

test("atomicity is not decided by parsing prose", () => {
  // A third rule was considered — "the proposition contains several clauses" —
  // and rejected: it cannot be decided without parsing meaning, and a regex
  // that tried would be the classifier's mistake in a new place.
  assert.equal(checkAtomicity([
    { claimType: "current_external", requiredEvidence: ["web"], dependsOn: [],
      proposition: "It costs $4,000 and ships on Friday." },
  ]), null);
});
