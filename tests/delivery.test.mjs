// The five-action decision table.
//
// This is the whole of "what ships", so every branch is asserted here rather
// than only through the hooks. A lane that renders the wrong thing is a bug in
// one caller; a wrong decision here is a bug in all four at once.

import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveDelivery } from "../src/delivery.js";
import { FAIL_CLOSED_TEXT, FACT_FAIL_CLOSED_TEXT } from "../src/contract.js";
import { claimsPersistence } from "../src/persistence.js";

/** An eligible correction whose durable write did not land. */
const FAILED = {
  factEligible: true,
  factKind: "correct",
  factUnambiguous: true,
  factTransactionAllowed: true,
  factCalls: 1,
  factOutcome: { ok: false },
  correctionScope: "user_owned_fact",
  persistenceClaimRevisions: 0,
};

const PROPOSAL = {
  operation: "correct",
  subject: "CAR",
  property: "chassis code",
  newValue: "RX60",
  previousValue: "RX40",
};

const CLEAN_DRAFT = "Correct. RX60, not RX40.";
const CLAIMING_DRAFT = "Got it, I've saved that: RX60.";

test("an ordinary turn passes through untouched", () => {
  const d = resolveDelivery({ entry: { factEligible: false }, draft: "Ha. I'll take it." });
  assert.equal(d.action, "pass");
  assert.equal(d.text, "Ha. I'll take it.");
  assert.equal(d.persistenceFailureNoted, false);
});

test("a committed write ships the answer with no note", () => {
  const d = resolveDelivery({ entry: { ...FAILED, factOutcome: { ok: true } }, draft: CLEAN_DRAFT });
  assert.equal(d.action, "pass");
  assert.equal(d.text, CLEAN_DRAFT);
  assert.equal(d.persistenceOutcome, "committed");
  assert.equal(d.persistenceFailureNoted, false);
});

test("grounding fail-closed outranks a persistence failure", () => {
  // The operator is not told about the vault on this turn. Annotating a reply
  // that could not be grounded would imply the answer was fine.
  const d = resolveDelivery({ entry: { ...FAILED, failClosed: true }, draft: CLEAN_DRAFT });
  assert.equal(d.action, "replace");
  assert.equal(d.text, FAIL_CLOSED_TEXT);
  assert.equal(d.persistenceFailureNoted, false);
  // ...but the combined case stays visible in the corpus.
  assert.equal(d.persistenceOutcome, "failed");
});

test("a clean draft is annotated, keeping the answer", () => {
  const d = resolveDelivery({ entry: FAILED, draft: CLEAN_DRAFT });
  assert.equal(d.action, "annotate");
  assert.match(d.text, /RX60/);
  assert.match(d.text, /not RX40/);
  assert.match(d.text, /failed/i);
  assert.equal(d.persistenceFailureNoted, true);
  assert.equal(d.correctionAppliedToResponse, true);
});

test("a substantive answer survives annotation intact", () => {
  const draft = "You're right, it's an RX60. That means two exterior belt mouldings, one per door.";
  const d = resolveDelivery({ entry: FAILED, draft });
  assert.equal(d.action, "annotate");
  assert.match(d.text, /two exterior belt mouldings/);
});

test("the stronger wording waits for an active overlay", () => {
  const without = resolveDelivery({ entry: FAILED, draft: CLEAN_DRAFT });
  const with_ = resolveDelivery({ entry: FAILED, draft: CLEAN_DRAFT, overlayActive: true });
  assert.doesNotMatch(without.text, /this conversation/);
  assert.match(with_.text, /this conversation/);
});

test("a draft claiming the write succeeded gets one bounded repair", () => {
  const d = resolveDelivery({ entry: FAILED, draft: CLAIMING_DRAFT });
  assert.equal(d.action, "revise");
  assert.equal(d.responsePolicy, "repair_false_persistence_claim");
  assert.ok(d.instruction);
  assert.equal(d.text, undefined, "a revision has no terminal text");
});

test("a still-claiming draft after the budget is rebuilt, not annotated", () => {
  // The critical case: appending "the update failed" to "I've saved that"
  // would knowingly ship a contradiction.
  const d = resolveDelivery({
    entry: { ...FAILED, persistenceClaimRevisions: 1 },
    draft: CLAIMING_DRAFT,
    structuredFact: PROPOSAL,
    overlayActive: true,
  });
  assert.equal(d.action, "safe_fallback");
  assert.equal(d.text, "Correct. RX60, not RX40. The durable record update failed; the correction remains active for this conversation only.");
  assert.doesNotMatch(d.text, /saved/i, "the contradictory draft must not survive");
  assert.equal(d.persistenceFailureNoted, true);
});

test("the fallback for a plain statement states the record rather than inventing prose", () => {
  const d = resolveDelivery({
    entry: { ...FAILED, factKind: "state", persistenceClaimRevisions: 1 },
    draft: "I've stored that.",
    structuredFact: { operation: "set", subject: "CAR", property: "chassis code", newValue: "RX60" },
  });
  assert.equal(d.action, "safe_fallback");
  assert.match(d.text, /^Understood: CAR chassis code is RX60\./);
  // The note legitimately contains "not stored that correction"; what must be
  // gone is the draft asserting the write happened.
  assert.equal(claimsPersistence(d.text), false);
  assert.doesNotMatch(d.text, /I.ve stored/i);
});

test("a claim with no captured proposal falls back to the fixed sentence", () => {
  // The model can claim to have saved something it never proposed. There is no
  // value we are entitled to state, so nothing is stated.
  const d = resolveDelivery({
    entry: { ...FAILED, factCalls: 0, factOutcome: null, persistenceClaimRevisions: 1 },
    draft: CLAIMING_DRAFT,
    structuredFact: null,
  });
  assert.equal(d.action, "safe_fallback");
  assert.equal(d.text, FACT_FAIL_CLOSED_TEXT);
  assert.equal(d.correctionAppliedToResponse, false);
});

test("an ambiguous correction clarifies rather than annotating or refusing", () => {
  const d = resolveDelivery({
    entry: { ...FAILED, correctionScope: "ambiguous" },
    draft: "Which part did I get wrong?",
  });
  assert.equal(d.action, "pass");
  assert.equal(d.responsePolicy, "clarify");
  assert.equal(d.text, "Which part did I get wrong?");
  assert.equal(d.persistenceFailureNoted, false);
});

test("a disabled transaction produces no note", () => {
  const d = resolveDelivery({
    entry: { ...FAILED, factTransactionAllowed: false, factCalls: 0, factOutcome: null },
    draft: CLEAN_DRAFT,
  });
  assert.equal(d.action, "pass");
  assert.equal(d.persistenceOutcome, "skipped");
});

test("an eligible turn that never called the tool is still disclosed", () => {
  const d = resolveDelivery({
    entry: { ...FAILED, factCalls: 0, factOutcome: null },
    draft: CLEAN_DRAFT,
  });
  assert.equal(d.action, "annotate");
  assert.equal(d.persistenceOutcome, "failed");
});

test("the decision is a pure function of its inputs", () => {
  const a = resolveDelivery({ entry: FAILED, draft: CLEAN_DRAFT, overlayActive: true });
  const b = resolveDelivery({ entry: FAILED, draft: CLEAN_DRAFT, overlayActive: true });
  assert.deepEqual(a, b);
  assert.equal(FAILED.persistenceClaimRevisions, 0, "input must not be mutated");
});

test("an empty draft still carries the note", () => {
  const d = resolveDelivery({ entry: FAILED, draft: "" });
  assert.equal(d.action, "annotate");
  assert.ok(d.text.trim().length > 0);
});
