// Claim extraction: read what the draft asserts, rather than predict it.
//
// The contract this implements is docs/claim-verification.md. Read that first —
// the schema decides everything downstream, and this file is deliberately the
// smaller half of the commit.
//
// Two properties are load-bearing and easy to lose:
//
//   * Abstention is not "no claims". A model that timed out, returned garbage,
//     or was never configured must be visible as a *failure*, not as a clean
//     conversational turn. That distinction is the difference between a metric
//     and a comforting number.
//
//   * The deterministic layer does not classify. It normalises, segments,
//     bounds and redacts. It does not drop questions or quotations, because
//     "The current version is 2.1, correct?" carries a material claim and
//     removing content before the model sees it is how semantic judgement gets
//     smuggled back into a regex.
//
// Offline only in this commit: nothing here is wired into a hook.

import { looksSecret } from "./values.js";

/** Where the truth of a claim comes from. Epistemic source, not subject. */
export const CLAIM_TYPES = Object.freeze([
  "current_external",
  "stored_personal",
  "conversation_supplied",
  "calculated",
  "stable_general",
  "system_or_runtime_state",
  "opinion_or_recommendation",
  "non_factual",
]);

/** How the proposition is presented. Does not decide whether it is checkable. */
export const MODALITIES = Object.freeze([
  "asserted",
  "hedged",
  "attributed",
  "quoted",
  "hypothetical",
  "interrogative",
  "imperative",
]);

/** Evidence kinds. Multi-label: one claim may need several. */
export const EVIDENCE_KINDS = Object.freeze([
  "web",
  "memory",
  "conversation",
  "calculation",
  "system",
  "none",
]);

export const ABSTENTION_REASONS = Object.freeze([
  "no_llm",
  "timeout",
  "malformed_output",
  "low_confidence",
  "oversized",
  "empty_draft",
  // A claim that bundles several independently checkable propositions cannot
  // be mapped to distinct evidence, which is the entire purpose of extraction.
  // Abstaining makes that failure measurable; repairing it would hide the one
  // thing worth measuring.
  "non_atomic_claims",
]);

export const SCHEMA_VERSION = "claims-v2";
export const PROMPT_VERSION = "claims-v2";

/**
 * Whether a claim was produced in the v2 shape.
 *
 * The parser accepts v1 so the frozen baseline can still be replayed, but a v2
 * run that quietly emits legacy-shaped claims would score as a success while
 * having ignored the contract. Counted rather than assumed.
 */
export function isV2Shape(raw) {
  return Boolean(
    raw &&
      typeof raw.surfaceText === "string" && raw.surfaceText.trim() &&
      typeof raw.proposition === "string" && raw.proposition.trim() &&
      Number.isInteger(raw.sourceStart) && Number.isInteger(raw.sourceEnd),
  );
}

/** Bounds. An unbounded extractor is an unbounded failure surface. */
const MAX_CLAIMS = 24;
const MAX_CLAIM_CHARS = 400;
const MAX_DRAFT_CHARS = 12000;
const DEFAULT_TIMEOUT_MS = 20000;
// Sized for a reasoning model, not for the answer. A model that thinks before
// it writes spends this budget first, and a limit sized for the JSON alone
// returns empty content — which arrives as malformed_output and reads as a
// prompt failure. Observed: 19 of 92 dev turns abstained this way.
const DEFAULT_MAX_TOKENS = 16000;

// ---------------------------------------------------------------------------
// Deterministic preprocessing — segmentation and redaction only
// ---------------------------------------------------------------------------

/**
 * Split a draft into sentence spans, preserving offsets.
 *
 * Offsets are what make prediction-versus-gold matching deterministic later,
 * so they are carried rather than recomputed. Questions and quotations are
 * segmented like anything else and deliberately not removed.
 */
export function segment(draft) {
  const text = String(draft ?? "");
  const spans = [];
  // Scanned rather than regex-split, because a period between digits is not a
  // sentence boundary and claims are full of them: "version 2.1", "$4,000.50",
  // "1.5 GHz". Splitting those produces fragments that can never match a gold
  // claim, which would show up as poor recall rather than as a parsing bug.
  const isDigit = (c) => c >= "0" && c <= "9";
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c !== "." && c !== "!" && c !== "?" && c !== "\n") continue;
    if (c === "." && isDigit(text[i - 1]) && isDigit(text[i + 1])) continue;
    // Consume a run of terminators ("?!", "...").
    let end = i + 1;
    while (end < text.length && ".!?".includes(text[end])) end += 1;
    const next = text[end];
    if (c !== "\n" && next !== undefined && !/\s/.test(next)) continue;
    pushSpan(spans, text, start, end);
    start = end;
    i = end - 1;
    if (spans.length >= 200) return spans;
  }
  if (start < text.length) pushSpan(spans, text, start, text.length);
  return spans;
}

function pushSpan(spans, text, from, to) {
  const raw = text.slice(from, to);
  const body = raw.trim();
  if (!body) return;
  const lead = raw.length - raw.trimStart().length;
  spans.push({ index: spans.length, text: body, start: from + lead, end: from + lead + body.length });
}

/**
 * Replace anything that looks like a credential before it reaches a model.
 *
 * Redaction is the one semantic-ish thing the deterministic layer does, and it
 * only ever removes; it never reclassifies.
 */
export function redact(text) {
  const s = String(text ?? "");
  if (!s) return s;
  return s
    .split(/(\s+)/)
    .map((tok) => (tok.trim() && looksSecret(tok) ? "[redacted]" : tok))
    .join("");
}

// ---------------------------------------------------------------------------
// Result constructors — abstention is a first-class outcome
// ---------------------------------------------------------------------------

function abstain(reason, detail) {
  return {
    status: "abstained",
    reason: ABSTENTION_REASONS.includes(reason) ? reason : "malformed_output",
    detail: detail ? String(detail).slice(0, 200) : undefined,
    claims: [],
  };
}

function noClaims(provenance) {
  return { status: "no_claims", provenance, claims: [] };
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

/**
 * Validate one claim against the contract.
 *
 * Returns null for anything off-schema. The caller abstains rather than
 * repairing: a half-understood claim is worse than none, because it enters the
 * ladder with authority it has not earned.
 */
export function validateClaim(raw, { draft, spans }) {
  if (!raw || typeof raw !== "object") return null;
  const v2Shape = isV2Shape(raw);

  // `surfaceText` is what appears in the draft and must locate against
  // offsets. `text` is accepted as its legacy name so a prompt that predates
  // this field still validates and the baseline stays comparable.
  const surfaceText =
    typeof raw.surfaceText === "string" && raw.surfaceText.trim()
      ? raw.surfaceText.trim()
      : typeof raw.text === "string"
        ? raw.text.trim()
        : "";
  if (!surfaceText || surfaceText.length > MAX_CLAIM_CHARS) return null;

  // `proposition` is the atomic, truth-evaluable form. A draft may answer with
  // a fragment — "Four hundred and eight." — whose subject and operation live
  // in the operator's turn. Evidence matching needs the complete proposition,
  // so it is deliberately NOT required to be a substring of the draft.
  const proposition =
    typeof raw.proposition === "string" && raw.proposition.trim()
      ? raw.proposition.trim()
      : surfaceText;
  if (proposition.length > MAX_CLAIM_CHARS) return null;
  const text = surfaceText;

  if (!CLAIM_TYPES.includes(raw.claimType)) return null;
  if (!MODALITIES.includes(raw.modality)) return null;

  const required = Array.isArray(raw.requiredEvidence) ? raw.requiredEvidence : [];
  for (const kind of required) {
    if (typeof kind !== "string") return null;
    // "claim:c1" references another claim in this extraction, which is how a
    // derived claim declares that it inherits its predecessors' evidence.
    if (kind.startsWith("claim:")) continue;
    if (!EVIDENCE_KINDS.includes(kind)) return null;
  }

  // Claims this one is derived from. A calculated conclusion that does not
  // name its premises forces the next stage to reverse-engineer them.
  const dependsOn = Array.isArray(raw.dependsOn) ? raw.dependsOn : [];
  if (dependsOn.some((d) => typeof d !== "string" || !d)) return null;

  const confidence = Number(raw.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;

  // Offsets are trusted only when they actually locate the claim's text in the
  // draft. A model that invents spans would silently break gold matching.
  let start = Number.isInteger(raw.sourceStart) ? raw.sourceStart : -1;
  let end = Number.isInteger(raw.sourceEnd) ? raw.sourceEnd : -1;
  if (start < 0 || end <= start || end > draft.length) {
    const found = draft.indexOf(text);
    start = found;
    end = found >= 0 ? found + text.length : -1;
  }

  const sentenceIndex = Number.isInteger(raw.sentenceIndex)
    ? raw.sentenceIndex
    : spans.findIndex((s) => start >= s.start && start < s.end);

  const factual = Boolean(raw.factual);
  const material = Boolean(raw.material);

  return {
    id: typeof raw.id === "string" && raw.id ? raw.id.slice(0, 16) : null,
    surfaceText,
    proposition,
    // Retained so existing consumers and the scorer keep working; always equal
    // to surfaceText.
    text,
    dependsOn,
    sourceStart: start,
    sourceEnd: end,
    sentenceIndex: sentenceIndex >= 0 ? sentenceIndex : null,
    claimType: raw.claimType,
    modality: raw.modality,
    factual,
    material,
    // Stated explicitly rather than recomputed by each consumer, so the
    // decision is inspectable. Derived when the model omits it.
    verificationTarget:
      typeof raw.verificationTarget === "boolean"
        ? raw.verificationTarget
        : factual && material && !["hypothetical", "interrogative", "imperative"].includes(raw.modality),
    requiredEvidence: required.length ? [...required] : ["none"],
    confidence,
    // Whether the model actually used the v2 contract, as opposed to legacy
    // output that happened to validate.
    v2Shape,
  };
}

/**
 * Evidence kinds that come from genuinely different places.
 *
 * A single claim needing two of these is bundling two propositions: whatever
 * the memory supports and whatever the web supports cannot be the same
 * assertion.
 */
const INDEPENDENT_SOURCES = ["web", "memory", "system"];

/**
 * Reject a claim set that is not atomic.
 *
 * Only the cases decidable *mechanically* are checked. A third rule was
 * considered and rejected — "the proposition contains several truth-evaluable
 * clauses" cannot be decided without parsing meaning, and a regex that tried
 * would be the same mistake as the classifier: a heuristic making a semantic
 * judgement it is not equipped to make. Non-atomicity of that kind shows up in
 * scoring instead, where a human can see it.
 *
 * @returns {string|null} a reason, or null when the set is acceptable
 */
export function checkAtomicity(claims) {
  const factualTypes = new Set(["stored_personal", "current_external", "system_or_runtime_state"]);
  const hasFactualPeers = claims.some((c) => factualTypes.has(c.claimType));

  for (const claim of claims) {
    const kinds = claim.requiredEvidence.filter((k) => INDEPENDENT_SOURCES.includes(k));
    const references = claim.requiredEvidence.some((k) => k.startsWith("claim:")) || claim.dependsOn.length > 0;

    // Two independent sources in one claim, with nothing saying it is derived
    // from other claims: this is a compound sentence wearing one label.
    if (kinds.length > 1 && !references) return "non_atomic_claims";

    // A conclusion that depends on facts must name them, or the evidence stage
    // has to guess which premises it is standing on.
    if (claim.claimType === "calculated" && hasFactualPeers && !references) {
      return "non_atomic_claims";
    }
  }
  return null;
}

/**
 * Parse and validate a whole extraction payload.
 *
 * Exported so the offline harness can replay recorded model output without a
 * live model.
 */
export function parseExtraction(text, { draft, spans }) {
  let parsed;
  try {
    // Tolerate a fenced block, which models produce despite instructions.
    const cleaned = String(text ?? "")
      .replace(/^\s*```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/i, "")
      .trim();
    parsed = JSON.parse(cleaned);
  } catch {
    return { ok: false, reason: "malformed_output" };
  }

  if (!parsed || typeof parsed !== "object") return { ok: false, reason: "malformed_output" };
  const rawClaims = Array.isArray(parsed.claims) ? parsed.claims : null;
  if (!rawClaims) return { ok: false, reason: "malformed_output" };
  if (rawClaims.length > MAX_CLAIMS) return { ok: false, reason: "oversized" };

  const claims = [];
  for (const raw of rawClaims) {
    const claim = validateClaim(raw, { draft, spans });
    // One bad claim abstains the whole extraction. Partial acceptance would
    // mean shipping a claim set that does not match what the model produced.
    if (!claim) return { ok: false, reason: "malformed_output" };
    claims.push({ ...claim, id: claim.id ?? `c${claims.length + 1}` });
  }

  const atomicity = checkAtomicity(claims);
  if (atomicity) return { ok: false, reason: atomicity };

  return { ok: true, claims };
}

// ---------------------------------------------------------------------------
// The model call
// ---------------------------------------------------------------------------

const SYSTEM = [
  "You extract atomic factual claims from a draft reply. You do not judge whether they are true.",
  "",
  "Return ONLY JSON: {\"claims\":[...]}. No prose, no code fence.",
  "",
  "== WHAT A CLAIM IS ==",
  "One independently truth-evaluable proposition that materially supports the answer.",
  "Do not manufacture claims from social language, tone, uncertainty, or recommendations.",
  "",
  "== SURFACE vs PROPOSITION ==",
  "The draft may be a short answer whose subject, operation or comparison appears only in",
  "the operator's turn. Reconstruct a complete proposition using the turn, while anchoring",
  "surfaceText only to the draft. Never add facts absent from both the turn and the draft.",
  "",
  "  turn:  What is 17 x 24?",
  "  draft: Four hundred and eight.",
  "    surfaceText: \"Four hundred and eight.\"",
  "    proposition: \"17 x 24 equals 408.\"     claimType: calculated",
  "",
  "  turn:  What is my saved chassis code?",
  "  draft: RX60.",
  "    surfaceText: \"RX60.\"",
  "    proposition: \"The operator\u2019s saved chassis code is RX60.\"   claimType: stored_personal",
  "",
  "  turn:  Is the service running?",
  "  draft: Yes.",
  "    surfaceText: \"Yes.\"",
  "    proposition: \"The service is currently running.\"   claimType: system_or_runtime_state",
  "",
  "Do not discard a bare number, date, name, setting, yes/no answer or short noun phrase",
  "merely because the draft is not a complete standalone sentence.",
  "",
  "== ATOMIC DECOMPOSITION ==",
  "Split compound answers. Each claim must be checkable on its own.",
  "",
  "  WRONG - one composite claim:",
  "    \"Your budget is $3,500 and the current price is $4,000, so it is insufficient.\"",
  "  CORRECT - three atomic claims:",
  "    c1 proposition \"The operator\u2019s budget is $3,500.\"   stored_personal   requiredEvidence [memory]",
  "    c2 proposition \"The product currently costs $4,000.\"  current_external  requiredEvidence [web]",
  "    c3 proposition \"$3,500 is less than $4,000.\"          calculated",
  "       dependsOn [c1,c2]   requiredEvidence [calculation,claim:c1,claim:c2]",
  "",
  "A derived conclusion MUST declare dependsOn. A single claim must never require two of",
  "web, memory and system unless it declares dependsOn.",
  "surfaceText spans may overlap when several atomic claims come from one sentence.",
  "",
  "== NOT CLAIMS ==",
  "These produce {\"claims\":[]}:",
  "  \"Good one.\"  \"Goodnight.\"  \"That was a terrible joke.\"  \"Later.\"",
  "  \"I couldn\u2019t confirm a current price, so I won\u2019t quote one.\"",
  "The last one asserts uncertainty, NOT the missing price. Do not extract the price.",
  "",
  "A short reply that PERFORMS a social act is not a report about the system:",
  "  turn \"Forget I asked.\"    draft \"Forgotten.\"              -> no claims; it drops the request",
  "  turn \"You are in a mood.\" draft \"Diagnostic, not moody.\"  -> no claims; banter",
  "  turn \"You there?\"        draft \"Here.\"                   -> no claims; presence, not status",
  "Only emit system_or_runtime_state when the operator asked about the system, a",
  "service, a file, a setting or a process. Ask: is the operator being told a",
  "checkable fact, or simply being answered?",
  "",
  "== FIELDS ==",
  "  surfaceText       exact text from the draft",
  "  proposition       complete truth-evaluable form (may reconstruct from the turn)",
  "  sourceStart/End   character offsets of surfaceText into the draft",
  "  sentenceIndex     0-based sentence number",
  `  claimType         one of: ${CLAIM_TYPES.join(", ")}`,
  `  modality          one of: ${MODALITIES.join(", ")}`,
  "  factual           is this a proposition about the world at all",
  "  material          does the answer turn on it (incidental asides are factual, not material)",
  "  verificationTarget whether it should be checked against evidence",
  `  requiredEvidence  array from: ${EVIDENCE_KINDS.join(", ")}; or \"claim:<id>\" to inherit`,
  "  dependsOn         array of claim ids this one is derived from",
  "  confidence        0..1",
  "",
  "== CLAIM TYPE IS ABOUT WHERE THE TRUTH COMES FROM ==",
  "  current_external        the world right now, outside this system",
  "  stored_personal         something the operator told us previously",
  "  conversation_supplied   stated in this conversation",
  "  calculated              arithmetic or derivation from other claims",
  "  stable_general          durable public knowledge",
  "  system_or_runtime_state this system\u2019s own configuration or state",
  "  opinion_or_recommendation a judgement, not a fact",
  "  non_factual             greeting, acknowledgement, banter, style",
  "",
  "== MODALITY DOES NOT ERASE FACTUALITY ==",
  "  \"The package probably costs about $4,000.\"  -> hedged, verificationTarget TRUE",
  "  \"The vendor says the package is fixed.\"     -> attributed; the attribution is checkable",
  "Hypotheticals and questions are ordinarily not verification targets, unless the answer",
  "itself asserts a proposition.",
  "",
  "If the draft asserts nothing checkable, return {\"claims\":[]}.",
].join("\n");

/**
 * Extract claims from one draft.
 *
 * Provider-neutral, mirroring `runCaseAudit` in case-audit.js: the model is
 * injected, a model problem is an outcome rather than an exception, and the
 * result is discriminated.
 *
 * The request deliberately carries no tools, no memory, no workspace context
 * and no persona. That isolation is asserted by test — a claim extractor that
 * can see the agent's persona is being asked to reason about its own output as
 * a character, which is not the question.
 *
 * @param {{userTurn?: string, draft?: string, conversationFacts?: string[]}} input
 * @param {{llm?: object, timeoutMs?: number, maxTokens?: number, signal?: object,
 *          minConfidence?: number}} [opts]
 */
export async function extractClaims(input = {}, opts = {}) {
  const draft = String(input.draft ?? "");
  if (!draft.trim()) return abstain("empty_draft");
  if (draft.length > MAX_DRAFT_CHARS) return abstain("oversized", `${draft.length} chars`);

  const llm = opts.llm;
  if (!llm || typeof llm.complete !== "function") return abstain("no_llm");

  const spans = segment(draft);
  const facts = Array.isArray(input.conversationFacts) ? input.conversationFacts.slice(0, 20) : [];

  const user = [
    input.userTurn ? `OPERATOR TURN:\n${redact(String(input.userTurn)).slice(0, 2000)}` : "",
    facts.length ? `CONTEXT SUPPLIED THIS CONVERSATION:\n${facts.map((f) => `- ${redact(String(f)).slice(0, 300)}`).join("\n")}` : "",
    `DRAFT REPLY:\n${redact(draft)}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller
    ? setTimeout(() => controller.abort(), Math.max(1000, Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS))
    : null;
  opts.signal?.addEventListener?.("abort", () => controller?.abort(), { once: true });

  let result;
  const startedAt = Date.now();
  try {
    result = await llm.complete({
      purpose: "claim-extraction",
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: user },
      ],
      temperature: 0,
      maxTokens: Number(opts.maxTokens) || DEFAULT_MAX_TOKENS,
      // Isolation, stated in the request rather than assumed from context.
      tools: [],
      memory: false,
      workspaceContext: false,
      persona: false,
      signal: controller?.signal,
    });
  } catch (err) {
    const aborted = /abort/i.test(String(err?.name ?? err?.message ?? ""));
    return abstain(aborted ? "timeout" : "malformed_output", err?.message ?? err);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (result && result.latencyMs == null) result.latencyMs = Date.now() - startedAt;

  const provenance = {
    provider: result?.provider ?? null,
    model: result?.model ?? null,
    schemaVersion: SCHEMA_VERSION,
    promptVersion: PROMPT_VERSION,
    // Token counts confirm whether the budget is headroom or regularly spent,
    // which is the difference between "16000 is ample" and "16000 is the next
    // silent truncation".
    usage: result?.usage ?? null,
    latencyMs: result?.latencyMs ?? null,
  };

  const parsed = parseExtraction(result?.text, { draft, spans });
  if (!parsed.ok) return abstain(parsed.reason);

  const floor = Number.isFinite(opts.minConfidence) ? opts.minConfidence : 0;
  if (floor > 0 && parsed.claims.some((c) => c.confidence < floor)) {
    // The whole extraction abstains rather than silently dropping the claims
    // below the floor: dropping them would look like the model said the draft
    // was clean.
    return abstain("low_confidence");
  }

  if (parsed.claims.length === 0) return noClaims(provenance);
  return { status: "extracted", provenance, claims: parsed.claims };
}

/** Material claims that should be checked. The ladder's input. */
export function verificationTargets(extraction) {
  if (extraction?.status !== "extracted") return [];
  return extraction.claims.filter((c) => c.material && c.verificationTarget);
}
