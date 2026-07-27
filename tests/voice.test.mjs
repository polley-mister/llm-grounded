import assert from "node:assert/strict";
import test from "node:test";

import { assessVoice, depthWasRequested, DEFAULT_MAX_WORDS } from "../src/voice.js";

const long = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");

test("a short answer passes untouched", () => {
  const v = assessVoice("Eleven, across five images. The AdGuard exporter owns five.");
  assert.equal(v.ok, true);
  assert.deepEqual(v.violations, []);
});

test("the runaway tail is caught, with the measurement in the instruction", () => {
  const v = assessVoice(long(140), { userMessage: "anything worth worrying about tonight?" });
  assert.equal(v.ok, false);
  assert.ok(v.violations.some((x) => x.startsWith("length:")));
  // The correction must name the number; "be concise" is not actionable.
  assert.match(v.instruction, /140 words/);
  assert.match(v.instruction, new RegExp(`under ${DEFAULT_MAX_WORDS}`));
});

test("requested depth is never clipped", () => {
  // A gate that punishes an explanation the operator asked for teaches him not to ask.
  for (const ask of [
    "explain how the UPS shutdown ordering works",
    "walk me through the grounding contract",
    "why did the scrape duration regress?",
    "compare faster-whisper and whisper.cpp",
    "draft a runbook section for this",
  ]) {
    assert.equal(depthWasRequested(ask), true, ask);
    const v = assessVoice(long(200), { userMessage: ask });
    assert.equal(
      v.violations.some((x) => x.startsWith("length:")),
      false,
      `${ask} must not trip the length rule`,
    );
  }
});

test("a settings preamble is wrong at any length", () => {
  const v = assessVoice("Honesty setting: ninety percent. Humor setting: sixty-five percent. Why did the engineer quit?");
  assert.ok(v.violations.includes("settings-preamble"));
  assert.match(v.instruction, /settings/i);
});

test("stock assistant openers are caught", () => {
  for (const opener of [
    "Great question. The answer is eleven.",
    "I'd be happy to help with that.",
    "Of course, here is what I found.",
  ]) {
    assert.ok(assessVoice(opener).violations.includes("stock-opener"), opener);
  }
});

test("closing exhortations are caught, mid-answer advice is not", () => {
  // The failure that started the audit.
  const bad = assessVoice("No alerts, no conflicts. Quiet. You have room to breathe. Take it.");
  assert.ok(bad.violations.includes("closing-exhortation"));

  // A practical next step that happens to be second person must survive.
  const good = assessVoice("Disk is at 91 percent. You should prune the old snapshots before Friday, then re-check.");
  assert.equal(good.violations.includes("closing-exhortation"), false);
});

test("structure is allowed when depth was asked for, and in short replies", () => {
  const bulleted = `Here is the state of things:\n- one\n- two\n- three\n${long(70)}`;
  assert.ok(
    assessVoice(bulleted, { userMessage: "how are we doing?" })
      .violations.includes("structure-in-conversation"),
  );
  assert.equal(
    assessVoice(bulleted, { userMessage: "explain how we are doing" })
      .violations.includes("structure-in-conversation"),
    false,
  );
  // Short answers may use a list without it being a document.
  assert.equal(
    assessVoice("- one\n- two").violations.includes("structure-in-conversation"),
    false,
  );
});

test("an empty reply is not a voice violation", () => {
  // Grounding owns that failure; this gate must not double-report it.
  assert.equal(assessVoice("").ok, true);
  assert.equal(assessVoice(null).ok, true);
});

test("the cap is not disclosed unless the operator asked about settings", () => {
  // Observed on Flash: "I am not supposed to joke at a sixty-five percent cap."
  // The preamble rule missed it because it did not open the sentence.
  const volunteered = assessVoice(
    "I am not supposed to joke at a sixty-five percent cap. But you asked, so here it is.",
    { userMessage: "tell me a joke" },
  );
  assert.ok(volunteered.violations.includes("settings-mention"));

  // Asked directly, disclosure is the correct answer.
  const asked = assessVoice("Sixty-five percent.", { userMessage: "what is your humor setting?" });
  assert.equal(asked.ok, true);

  const askedCap = assessVoice("Humor is capped at sixty-five percent.", {
    userMessage: "what is your humor cap right now?",
  });
  assert.equal(askedCap.ok, true);
});
