// Value equivalence and containment for fact transactions.
//
// The first version of this used plain substring containment, which is wrong in
// a way that matters: `"2"` is a substring of `"M2"`, so a model could propose
// the new value `2`, have it "found" in the operator's message about an M2, and get
// it committed. Substring matching also fails the other way — it would accept
// `"E9"` or `"92"` as evidence of `"M2"`.
//
// The replacement is token-sequence matching over a normalized form. Case,
// punctuation, quote style, and whitespace runs are all equivalence-preserving;
// nothing else is. A value matches a message only when its whole token sequence
// appears contiguously in the message's token sequence.
//
// Deliberately *not* fuzzy: no stemming, no synonyms, no edit distance. This is
// the check that decides whether the operator actually said something.

/** Curly quotes and dashes normalize to their plain forms; nothing else does. */
const QUOTE_MAP = new Map([
  ["‘", "'"], ["’", "'"], ["‛", "'"],
  ["“", '"'], ["”", '"'], ["‟", '"'],
  ["–", "-"], ["—", "-"], ["−", "-"],
]);

/** Longest value we will tokenize. Bounds the work and the blast radius. */
const MAX_NORMALIZE_CHARS = 4000;

/**
 * Normalize for comparison: fold case, unify quotes and dashes, and reduce
 * every run of non-alphanumeric characters to a single space.
 *
 * Alphanumeric runs are preserved intact, so `M2` normalizes to `m2` and
 * never splits into `e` and `92`. That is what makes `2` fail against `M2`.
 */
export function normalizeForMatch(value) {
  const raw = String(value ?? "").slice(0, MAX_NORMALIZE_CHARS);
  let folded = "";
  for (const ch of raw) folded += QUOTE_MAP.get(ch) ?? ch;
  return folded
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Normalized token sequence. Empty input yields an empty array. */
export function tokenize(value) {
  const normalized = normalizeForMatch(value);
  return normalized ? normalized.split(" ") : [];
}

/**
 * Whether two values are the same value, allowing only case, punctuation, and
 * whitespace differences.
 */
export function valuesEquivalent(a, b) {
  const left = tokenize(a);
  const right = tokenize(b);
  if (left.length === 0 || left.length !== right.length) return false;
  return left.every((token, i) => token === right[i]);
}

/**
 * Whether `haystack` actually states `value` — the value's whole token sequence
 * appearing contiguously, on token boundaries.
 *
 * Multi-word values are matched as phrases, so "MikroTik CCR2004" is not
 * satisfied by a message that mentions MikroTik somewhere and CCR2004
 * somewhere else.
 */
export function statesValue(haystack, value) {
  const needle = tokenize(value);
  if (needle.length === 0) return false;
  const tokens = tokenize(haystack);
  if (tokens.length < needle.length) return false;
  for (let i = 0; i + needle.length <= tokens.length; i++) {
    let hit = true;
    for (let j = 0; j < needle.length; j++) {
      if (tokens[i + j] !== needle[j]) {
        hit = false;
        break;
      }
    }
    if (hit) return true;
  }
  return false;
}

/**
 * Credential shapes that must never be persisted, checked against whole
 * messages as well as individual values.
 *
 * This is the plugin-side half of a deliberate belt-and-braces pair: the Vault
 * Tools writer applies an equivalent check to every value and to the source
 * quotation it is asked to store. A message carrying a benign fact *and* a
 * secret is refused outright rather than partially recorded, because the exact
 * user message is what gets persisted as `sourceQuote`.
 *
 * Mirrors `_SECRETISH` in vault_tools/facts.py; `tests/values.test.mjs` keeps
 * the two lists in step.
 */
export const SECRETISH = [
  /\b(?:password|passwd|api[_ -]?key|secret|token|bearer|private[_ -]?key)\b/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9]{16,}/,
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/,
];

/** True when text looks like it carries a credential. */
export function looksSecret(text) {
  const value = String(text ?? "");
  return SECRETISH.some((pattern) => pattern.test(value));
}
