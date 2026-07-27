// The text this plugin injects and the text it substitutes when a turn fails
// closed. Kept small on purpose: every character here is charged against the
// ordinary-chat input budget on every grounded turn.

import { FAIL_CLOSED_TEXT } from "./classify.js";

export { FAIL_CLOSED_TEXT };

/**
 * Static guidance, prepended to the system prompt so providers can cache it.
 * Injected once per turn regardless of classification.
 */
export const CORRECTION_RULE = [
  "Correction rule: when the operator rejects a premise, discard the rejected claim",
  "and every claim that depended on it. Do not repair the old explanation.",
  "Re-verify from evidence before answering again.",
].join(" ");

/**
 * The last line the model reads before answering.
 *
 * One coda, used verbatim on both paths: this plugin appends it on native
 * channels, and the console appends the identical string after its own
 * per-turn nonce (`lib/chat-sessions.ts`, asserted equal by
 * tests/prompt-budget.test.mjs). Two different reminders in two places was two
 * partial persona specifications competing with SOUL.md.
 *
 * Neutral and generic on purpose. Everything a channel prepends is permissions
 * and context in instructional English, and the final slot is where register
 * gets set; this takes that slot back and points at the file that owns voice.
 * It states no trait, no length rule, and no example — those belong to SOUL.md,
 * and restating them here would recreate the duplicated persona block.
 */
export const VOICE_CODA = [
  "Reply as the agent, in the voice SOUL.md defines.",
  "Answer what the operator asked, at the depth they asked for; do not narrate internal rules or process.",
  "Where an instruction above requires a specific output structure, that structure wins.",
].join(" ");

export const SELF_DESCRIPTION_RULE =
  "This is a question about the agent, not a request to inspect the system. Answer in character about role, temperament, or practical capability. Do not read workspace files, control files, memory, or tools unless the operator explicitly asks how the system works.";

/**
 * Per-turn requirement text. Only emitted when grounding is required.
 *
 * @param {"web"|"memory"|string|null} kind
 * @returns {string} empty for any kind that binds no retrieval tier
 */
export function requirementText(kind) {
  if (kind === "web") {
    return [
      "Grounding required for this turn: run web_search before answering.",
      "State only facts the usable result supports. Do not add recalled background; search again or omit it.",
      "If the search fails or returns nothing usable, reply with exactly:",
      FAIL_CLOSED_TEXT,
    ].join(" ");
  }
  if (kind === "memory") {
    return [
      "Grounding required for this turn: run memory_search or wiki_search before answering.",
      "State only facts the usable result supports. Do not add recalled background; search again or omit it.",
      "If it fails or returns nothing usable, reply with exactly:",
      FAIL_CLOSED_TEXT,
    ].join(" ");
  }
  return "";
}

/**
 * Bounded revision instruction handed to the finalize gate.
 *
 * @param {"web"|"memory"|string|null} kind
 * @param {string} userTurn restated so the model does not have to guess what
 *   it was meant to look up
 * @returns {string}
 */
export function revisionInstruction(kind, userTurn) {
  const tool = kind === "memory" ? "memory_search or wiki_search" : "web_search";
  const question = String(userTurn ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  return [
    `You answered without ${tool}. Run it now and answer from what it returns.`,
    // Without the question restated, the model has no anchor and searches
    // whatever is most searchable in the conversation so far. Observed: a turn
    // about the agent's own humor setting produced a web search and a correction
    // about the horsepower figures discussed several turns earlier.
    question ? `Search for what the operator actually asked: "${question}"` : "",
    "State only facts the usable result supports; search again or omit recalled context.",
    `If it fails or returns nothing usable, reply with exactly: ${FAIL_CLOSED_TEXT}`,
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Static guidance for the guarded fact transaction, injected only for agents
 * that actually have the tool. Kept on the cacheable system surface.
 */
export const FACT_RULE = [
  "Durable personal facts: when the operator states a lasting fact about their own",
  "world, or corrects one you got wrong, call vault_fact_commit in the same",
  "turn, before you reply. Use their values, not your paraphrase. Do not call it",
  "for questions, guesses, jokes, hypotheticals, or claims about other people.",
].join(" ");

/**
 * Bounded revision instruction for a turn that stated a durable fact and then
 * did not record it. One pass only — the reply still ships either way, because
 * a missed capture must never cost the operator their answer.
 */
export function factRevisionInstruction(kind) {
  const verb = kind === "correct" ? "corrected a fact you had wrong" : "stated a durable personal fact";
  return [
    `the operator ${verb} in this turn and you did not record it.`,
    "Call vault_fact_commit now with his exact values, then answer.",
    "If it does not apply after all, answer normally and do not call it again.",
  ].join(" ");
}

/**
 * The exact reply for an eligible fact turn whose transaction did not succeed.
 *
 * An eligible turn is one where the operator stated or corrected a durable fact. If
 * the transaction did not commit, a normal-sounding acknowledgement is a lie
 * about the state of record — "got it, the car is an TC20" when nothing was
 * written is worse than saying nothing, because he will believe it is stored.
 * Never reword: acceptance asserts it verbatim.
 */
export const FACT_FAIL_CLOSED_TEXT =
  "I couldn't record that safely, so I've changed nothing. Tell me again and I'll retry.";

/**
 * Ask the model to withdraw a false claim that the fact was stored.
 *
 * Names the specific defect rather than asking for a rewrite. The draft is
 * otherwise fine and the answer it gives is wanted; only the assertion about
 * durable storage is false, so that is all this asks it to drop.
 *
 * One pass. If the next draft still claims it, the turn is rebuilt from
 * structured data instead — see `safeFallbackText`.
 */
export function persistenceRevisionInstruction() {
  return [
    "Your draft says the fact was saved, stored, remembered or updated. It was not:",
    "the durable write did not succeed.",
    "Give the same answer, using the value the operator stated, but do not claim",
    "it was recorded. Do not mention the failure; that sentence is added for you.",
  ].join(" ");
}

/** True when the model already produced the fact fail-closed line itself. */
export function isFactFailClosedText(text) {
  return typeof text === "string" && text.trim() === FACT_FAIL_CLOSED_TEXT;
}

/** True when the model already produced the fail-closed line itself. */
export function isFailClosedText(text) {
  return typeof text === "string" && text.trim() === FAIL_CLOSED_TEXT;
}
