// ---------------------------------------------------------------------------
// Voice gate.
//
// The grounding contract asks "is this true?". This asks "does this sound like
// the agent?" — and only in the ways a machine can judge without opinion.
//
// Why a gate rather than more prompt: measured across 73 recent replies the
// median was 21 words, which is fine. The mean was 35 and the p90 was 72, with
// a maximum of 209. There is no verbosity problem in the middle of the
// distribution; there is a tail that runs away roughly one turn in three, and
// those are the turns that read as un-the agent. Prompt rules have not bounded that
// tail across a 38k-character instruction stack, and a tail is exactly what a
// deterministic check is good at.
//
// Deliberately narrow. Every rule here is objective — a count, or a literal
// pattern that the voice rules already forbid in prose. Nothing here judges
// wit, tone or word choice; those stay with SOUL.md and its worked examples,
// where a model can actually act on them.
//
// The thresholds target the egregious tail rather than the median. Each
// violation costs one extra model pass, so a gate tuned to fire on 29% of
// turns would put a second round trip on nearly every third reply. That is a
// poor trade on a voice loop where latency is already the weak point.
// ---------------------------------------------------------------------------

/** Words above which a reply is long by any reading of Verbosity 35. */
export const DEFAULT_MAX_WORDS = 90;

/**
 * Turns where length is the point. Depth that the operator asked for must never be
 * clipped — a gate that punishes an explanation he requested is worse than no
 * gate, because it teaches him not to ask.
 */
const DEPTH_REQUESTED = [
  /\b(?:explain|walk me through|talk me through|elaborate|in detail|deep dive|write up|summari[sz]e|compare|contrast|pros and cons|step by step|how (?:do|does|would) (?:i|we|you))\b/i,
  // Narrowed from "(why|how) (did|does|is|are...)": that also matched "how are
  // we doing?", a status question, and suspended the length rule on exactly the
  // casual turns the gate exists for. "why" genuinely asks for explanation;
  // bare "how are/is" does not.
  /\bwhy (?:did|does|do|is|are|was|were)\b/i,
  /\b(?:full|complete|comprehensive|detailed|long)\s+(?:answer|explanation|breakdown|list|rundown)\b/i,
  /\b(?:draft|write|compose|plan|design|outline)\b/i,
];

/** Announcing configuration nobody asked about, as an opener. */
const SETTINGS_PREAMBLE =
  /^\s*(?:honesty|humor|humour|verbosity|initiative|interruptibility|discretion)\s+(?:setting|level)\b/i;

/**
 * The same disclosure anywhere in the reply, not just at the front.
 *
 * Observed: "I'm not supposed to joke at a sixty-five percent cap. But you
 * asked directly, and that overrides the cap." The preamble rule missed it
 * because it did not open the sentence, yet it is the same failure — telling
 * the operator how the reply was manufactured.
 */
const SETTINGS_MENTION =
  /\b(?:humor|humour|honesty|verbosity|initiative|interruptibility)\b[^.!?]{0,40}\b(?:cap|setting|percent|%)|\b(?:\d{1,3}|ten|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|sixty-five|seventy-five)[\s-]?percent\b[^.!?]{0,25}\b(?:cap|setting)/i;

/** True when the operator asked about the settings, making disclosure correct. */
function settingsWereAsked(userMessage) {
  return /\b(?:setting|settings|humor|humour|honesty|verbosity|initiative|cap)\b/i.test(
    String(userMessage ?? ""),
  );
}

/** Assistant-register openers the voice rules already forbid. */
const STOCK_OPENERS = [
  /^\s*(?:great|good|excellent|interesting)\s+question\b/i,
  /^\s*(?:i'?d be happy to|happy to help|certainly[,!.]|of course[,!.]|absolutely[,!.])/i,
  /^\s*(?:sure thing|no problem)[,!.]/i,
];

/**
 * Closing instructions about how to feel or what to do with the evening.
 *
 * This is the specific failure that started the audit: a two-word answer
 * followed by three paragraphs ending "You have room to breathe. Take it."
 *
 * Restricted to the final sentence AND to permission/reassurance language.
 * An earlier version matched any closing "you should…", which flagged
 * "You should prune the old snapshots before Friday" — a practical next step
 * and exactly the kind of useful closing line that must survive. The target is
 * being told how to feel, not being told what to do.
 */
const CLOSING_EXHORTATION =
  new RegExp(
    "(?:^|[.!?]\\s)(?:" +
      // Permission and reassurance about how to feel.
      "you (?:have|deserve|'?ve earned)[^.!?]{0,40}\\b(?:room|time|space|breathe|break|rest|evening|night)\\b" +
      "|take (?:it|the (?:evening|night|day|win|time))\\b" +
      "|enjoy\\b|relax\\b|unwind\\b" +
      "|don'?t (?:worry|overthink|stress)\\b" +
    ")[^.!?]*[.!?]?\\s*$",
    "i",
  );

/** Structure that a short conversational answer has no use for. */
const HEADINGS_OR_BULLETS = /^\s*(?:#{1,6}\s|\s*[-*]\s|\d+\.\s)/m;

function wordCount(text) {
  return String(text ?? "").trim().split(/\s+/).filter(Boolean).length;
}

/** True when the operator asked for something that legitimately runs long. */
export function depthWasRequested(userMessage) {
  const text = String(userMessage ?? "");
  if (!text.trim()) return false;
  return DEPTH_REQUESTED.some((re) => re.test(text));
}

/**
 * Assess one reply against the objective half of the voice rules.
 *
 * @returns {{ok: boolean, violations: string[], instruction: string}}
 */
export function assessVoice(replyText, options = {}) {
  const text = String(replyText ?? "").trim();
  const violations = [];
  if (!text) return { ok: true, violations, instruction: "" };

  const maxWords = Number.isInteger(options.maxWords) ? options.maxWords : DEFAULT_MAX_WORDS;
  const words = wordCount(text);
  const depth = depthWasRequested(options.userMessage);

  // Length is the only rule depth suspends. The patterns below are wrong at
  // any length: a stock opener does not become acceptable in a long answer.
  if (!depth && words > maxWords) {
    violations.push(`length:${words}`);
  }
  if (SETTINGS_PREAMBLE.test(text)) {
    violations.push("settings-preamble");
  } else if (!settingsWereAsked(options.userMessage) && SETTINGS_MENTION.test(text)) {
    // Answering "what is your humor setting?" must stay legal; volunteering
    // the number in an unrelated reply must not.
    violations.push("settings-mention");
  }
  if (STOCK_OPENERS.some((re) => re.test(text))) {
    violations.push("stock-opener");
  }
  if (CLOSING_EXHORTATION.test(text)) {
    violations.push("closing-exhortation");
  }
  if (!depth && words > 60 && HEADINGS_OR_BULLETS.test(text)) {
    violations.push("structure-in-conversation");
  }

  return {
    ok: violations.length === 0,
    violations,
    instruction: violations.length ? revisionText(violations, words, maxWords) : "",
  };
}

/**
 * The correction handed back to the model.
 *
 * Names the measured fact and the target. "Be more concise" is advice; "that
 * was 118 words, answer in under 90" is an instruction, and a model can act on
 * the second without guessing what it did wrong.
 */
export function revisionText(violations, words, maxWords) {
  const parts = [];
  if (violations.some((v) => v.startsWith("length:"))) {
    parts.push(
      `That answer was ${words} words. Say the same thing in under ${maxWords}. Give the answer, then stop.`,
    );
  }
  if (violations.includes("settings-preamble")) {
    parts.push("Do not open by stating your settings. Nobody asked for them.");
  }
  if (violations.includes("settings-mention")) {
    parts.push(
      "Remove the reference to your settings or cap. Answer the request without explaining what you are permitted to do.",
    );
  }
  if (violations.includes("stock-opener")) {
    parts.push("Cut the opening pleasantry and start with the answer.");
  }
  if (violations.includes("closing-exhortation")) {
    parts.push("Delete the closing line telling the operator how to feel or what to do with his evening.");
  }
  if (violations.includes("structure-in-conversation")) {
    parts.push("Drop the headings and bullets; this is a conversation, not a document.");
  }
  parts.push("Keep every fact you already had right. Change only the delivery.");
  return parts.join(" ");
}
