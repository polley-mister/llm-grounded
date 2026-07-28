/**
 * Normalize for comparison: fold case, unify quotes and dashes, and reduce
 * every run of non-alphanumeric characters to a single space.
 *
 * Alphanumeric runs are preserved intact, so `TC20` normalizes to `tc20` and
 * never splits into `e` and `92`. That is what makes `2` fail against `TC20`.
 */
export function normalizeForMatch(value: any): string;
/** Normalized token sequence. Empty input yields an empty array. */
export function tokenize(value: any): string[];
/**
 * Whether two values are the same value, allowing only case, punctuation, and
 * whitespace differences.
 */
export function valuesEquivalent(a: any, b: any): boolean;
/**
 * Whether `haystack` actually states `value` — the value's whole token sequence
 * appearing contiguously, on token boundaries.
 *
 * Multi-word values are matched as phrases, so "MikroTik CCR2004" is not
 * satisfied by a message that mentions MikroTik somewhere and CCR2004
 * somewhere else.
 */
export function statesValue(haystack: any, value: any): boolean;
/** True when text looks like it carries a credential. */
export function looksSecret(text: any): boolean;
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
export const SECRETISH: RegExp[];
