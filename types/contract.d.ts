import { FAIL_CLOSED_TEXT } from "./classify.js";
export { FAIL_CLOSED_TEXT };
/**
 * Static guidance, prepended to the system prompt so providers can cache it.
 * Injected once per turn regardless of classification.
 */
export declare const CORRECTION_RULE: string;
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
export declare const VOICE_CODA: string;
export declare const SELF_DESCRIPTION_RULE = "This is a question about the agent, not a request to inspect the system. Answer in character about role, temperament, or practical capability. Do not read workspace files, control files, memory, or tools unless the operator explicitly asks how the system works.";
/**
 * Per-turn requirement text. Only emitted when grounding is required.
 *
 * @param {"web"|"memory"|string|null} kind
 * @returns {string} empty for any kind that binds no retrieval tier
 */
export declare function requirementText(kind: "web" | "memory" | string | null): string;
/**
 * Bounded revision instruction handed to the finalize gate.
 *
 * @param {"web"|"memory"|string|null} kind
 * @param {string} userTurn restated so the model does not have to guess what
 *   it was meant to look up
 * @returns {string}
 */
export declare function revisionInstruction(kind: "web" | "memory" | string | null, userTurn: string): string;
/**
 * Static guidance for the guarded fact transaction, injected only for agents
 * that actually have the tool. Kept on the cacheable system surface.
 */
export declare const FACT_RULE: string;
/**
 * Bounded revision instruction for a turn that stated a durable fact and then
 * did not record it. One pass only — the reply still ships either way, because
 * a missed capture must never cost the operator their answer.
 */
export declare function factRevisionInstruction(kind: any): string;
/**
 * The exact reply for an eligible fact turn whose transaction did not succeed.
 *
 * An eligible turn is one where the operator stated or corrected a durable fact. If
 * the transaction did not commit, a normal-sounding acknowledgement is a lie
 * about the state of record — "got it, the car is an M2" when nothing was
 * written is worse than saying nothing, because he will believe it is stored.
 * Never reword: acceptance asserts it verbatim.
 */
export declare const FACT_FAIL_CLOSED_TEXT = "I couldn't record that safely, so I've changed nothing. Tell me again and I'll retry.";
/** True when the model already produced the fact fail-closed line itself. */
export declare function isFactFailClosedText(text: any): boolean;
/** True when the model already produced the fail-closed line itself. */
export declare function isFailClosedText(text: any): boolean;
