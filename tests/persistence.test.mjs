// The seven invariants for a failed durable write.
//
// The governing rule: persistence failure prevents a claim of persistence, not
// a truthful answer using the operator's correction. Everything below is a
// consequence of that sentence, and each test names which half it protects.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  resolveOutcomes,
  persistenceNote,
  composeWithNote,
  claimsPersistence,
} from "../src/persistence.js";
import { createSessionOverlay, mergeOverlays } from "../src/session-overlay.js";
import { overlayText } from "../src/facts-overlay.js";

/** A turn where the operator corrected a fact and the write did not land. */
const FAILED = {
  factEligible: true,
  factKind: "correct",
  factUnambiguous: true,
  factTransactionAllowed: true,
  factCalls: 1,
  factOutcome: { ok: false },
  correctionScope: "user_owned_fact",
};

// ---------------------------------------------------------------------------
// The two outcomes are independent
// ---------------------------------------------------------------------------

test("a failed write does not make the correction itself false", () => {
  const r = resolveOutcomes(FAILED);
  assert.equal(r.correctionOutcome, "accepted");
  assert.equal(r.persistenceOutcome, "failed");
  assert.equal(r.responsePolicy, "answer_with_persistence_note");
});

test("a successful write needs no disclosure", () => {
  const r = resolveOutcomes({ ...FAILED, factOutcome: { ok: true } });
  assert.equal(r.correctionOutcome, "accepted");
  assert.equal(r.persistenceOutcome, "committed");
  assert.equal(r.responsePolicy, "answer");
});

test("a disabled transaction is skipped, not failed", () => {
  // Nothing went wrong, so a note on every turn would be noise that trains the
  // operator to ignore the one that matters.
  const r = resolveOutcomes({
    ...FAILED,
    factTransactionAllowed: false,
    factCalls: 0,
    factOutcome: null,
  });
  assert.equal(r.persistenceOutcome, "skipped");
  assert.equal(r.responsePolicy, "answer");
});

test("an eligible turn that never reached the tool is a failure to disclose", () => {
  // The durable record does not reflect what the operator just said. How it got
  // that way does not change what they need to be told.
  const r = resolveOutcomes({ ...FAILED, factCalls: 0, factOutcome: null });
  assert.equal(r.persistenceOutcome, "failed");
  assert.equal(r.responsePolicy, "answer_with_persistence_note");
});

test("an ambiguous correction asks rather than writes or refuses", () => {
  const r = resolveOutcomes({ ...FAILED, correctionScope: "ambiguous" });
  assert.equal(r.correctionOutcome, "ambiguous");
  assert.equal(r.persistenceOutcome, "skipped");
  assert.equal(r.responsePolicy, "clarify");
});

test("an ordinary turn is not a fact turn", () => {
  const r = resolveOutcomes({ factEligible: false, factKind: null });
  assert.equal(r.correctionOutcome, "not_applicable");
  assert.equal(r.responsePolicy, "answer");
});

// ---------------------------------------------------------------------------
// Invariant: the corrected fact is used, and the reply never sounds saved
// ---------------------------------------------------------------------------

test("the corrected fact is used in the accepted response", () => {
  const answer = "Correct. RX60, not RX40.";
  const { text, refused } = composeWithNote(answer, persistenceNote());
  assert.equal(refused, false);
  assert.match(text, /RX60/);
  assert.match(text, /not RX40/);
});

test("a substantive answer survives the failure intact", () => {
  // The whole point: a persistence failure must not discard reasoning the
  // operator asked for.
  const answer = "You're right, it's an RX60. That means two exterior belt mouldings, one per door.";
  const { text } = composeWithNote(answer, persistenceNote());
  assert.match(text, /two exterior belt mouldings/);
  assert.match(text, /failed/i);
});

test("the response does not say saved, stored, remembered or updated", () => {
  const { text } = composeWithNote("Correct. RX60, not RX40.", persistenceNote());
  assert.equal(claimsPersistence(text), false, text);
  for (const word of ["saved", "stored", "remembered", "updated"]) {
    // The note's own negated forms are allowed to contain these stems; a bare
    // positive claim is not.
    assert.doesNotMatch(text, new RegExp(`\\bI(?:'ve| have)? ${word}\\b`, "i"));
  }
});

test("both note forms pass their own persistence check", () => {
  // A disclosure that trips the detector would be unshippable, and the regex
  // is easy to over-tighten.
  assert.equal(claimsPersistence(persistenceNote()), false);
  assert.equal(claimsPersistence(persistenceNote({ overlayActive: true })), false);
});

test("a draft that already claims the write succeeded is refused, not rewritten", () => {
  // Annotating "I've saved that" with "the update failed" ships a
  // self-contradiction. Rewriting it is the surface where a renderer starts
  // altering meaning, so this goes back through the revision budget instead.
  const { refused } = composeWithNote("Got it, I've saved that: RX60.", persistenceNote());
  assert.equal(refused, true);
});

test("claimsPersistence catches the phrasings that matter", () => {
  for (const s of [
    "I've stored that.",
    "Noted and saved.",
    "I'll remember that.".replace("I'll remember", "I have remembered"),
    "Updated the vault record.",
    "Added to my memory.",
  ]) {
    assert.equal(claimsPersistence(s), true, s);
  }
  for (const s of [
    "Correct. RX60, not RX40.",
    "I could not store that.",
    "The vault update failed, so I have not stored that correction.",
    "That didn't save.",
  ]) {
    assert.equal(claimsPersistence(s), false, s);
  }
});

// ---------------------------------------------------------------------------
// Invariant: the conversation does not forget what the durable record missed
// ---------------------------------------------------------------------------

test("the stronger note is only legal once an overlay is holding the value", () => {
  // "remains active for this conversation" is a promise about the next turn.
  assert.doesNotMatch(persistenceNote({ overlayActive: false }), /this conversation/);
  assert.match(persistenceNote({ overlayActive: true }), /this conversation/);
});

test("a held correction corrects a later retrieval in the same session", () => {
  const overlay = createSessionOverlay();
  overlay.hold({
    sessionKey: "s1",
    factKey: "vehicle.model",
    subject: "the car",
    property: "model",
    currentValue: "RX60",
    supersededValues: ["RX40"],
  });
  assert.equal(overlay.active("s1"), true);

  // A retrieval that still returns the stale value, as the vault legitimately will.
  const merged = mergeOverlays({ facts: {} }, overlay.snapshot("s1"));
  const out = overlayText(merged, "Your stored RX40 has four exterior mouldings.");
  assert.equal(out.changed, true);
  assert.match(out.text, /RX60/);
  assert.match(out.text, /superseded/);
});

test("the session overlay wins over a stale durable record", () => {
  const durable = {
    facts: { "vehicle.model": { subject: "the car", property: "model", currentValue: "RX40", supersededValues: [], revision: 3 } },
  };
  const overlay = createSessionOverlay();
  overlay.hold({ sessionKey: "s1", factKey: "vehicle.model", currentValue: "RX60", supersededValues: ["RX40"] });
  const merged = mergeOverlays(durable, overlay.snapshot("s1"));
  assert.equal(merged.facts["vehicle.model"].currentValue, "RX60");
});

test("a later successful commit releases the overlay", () => {
  const overlay = createSessionOverlay();
  overlay.hold({ sessionKey: "s1", factKey: "vehicle.model", currentValue: "RX60" });
  assert.equal(overlay.active("s1"), true);
  assert.equal(overlay.release({ sessionKey: "s1", factKey: "vehicle.model" }), true);
  assert.equal(overlay.active("s1"), false);
});

test("one session cannot read another's corrections", () => {
  const overlay = createSessionOverlay();
  overlay.hold({ sessionKey: "s1", factKey: "vehicle.model", currentValue: "RX60" });
  assert.equal(overlay.active("s2"), false);
  assert.deepEqual(overlay.snapshot("s2"), { facts: {} });
});

test("the overlay is bounded per session and across sessions", () => {
  const overlay = createSessionOverlay({ maxPerSession: 2, maxSessions: 2 });
  for (const k of ["a", "b", "c"]) {
    overlay.hold({ sessionKey: "s1", factKey: k, currentValue: `v-${k}` });
  }
  assert.deepEqual(Object.keys(overlay.snapshot("s1").facts), ["b", "c"]);

  overlay.hold({ sessionKey: "s2", factKey: "a", currentValue: "v" });
  overlay.hold({ sessionKey: "s3", factKey: "a", currentValue: "v" });
  assert.equal(overlay.size, 2);
  assert.equal(overlay.active("s1"), false, "the oldest session is evicted first");
});

test("re-stating a correction refreshes it rather than aging it out", () => {
  const overlay = createSessionOverlay({ maxPerSession: 2 });
  overlay.hold({ sessionKey: "s1", factKey: "a", currentValue: "1" });
  overlay.hold({ sessionKey: "s1", factKey: "b", currentValue: "2" });
  overlay.hold({ sessionKey: "s1", factKey: "a", currentValue: "1" }); // restated
  overlay.hold({ sessionKey: "s1", factKey: "c", currentValue: "3" });
  assert.deepEqual(Object.keys(overlay.snapshot("s1").facts), ["a", "c"]);
});

test("an overlay holds nothing without a session key or a value", () => {
  const overlay = createSessionOverlay();
  assert.equal(overlay.hold({ sessionKey: "", factKey: "a", currentValue: "1" }), null);
  assert.equal(overlay.hold({ sessionKey: "s1", factKey: "a", currentValue: "" }), null);
  assert.equal(overlay.active("s1"), false);
});

test("merging an empty session overlay returns the durable one unchanged", () => {
  const durable = { facts: { x: { currentValue: "1" } } };
  assert.equal(mergeOverlays(durable, { facts: {} }), durable);
});
