/** Search results: one evidence item per hit. */
export function extractSearchEvidence(result: any, { maxItems }?: {
    maxItems?: number;
}): {
    title: any;
    source: any;
    excerpt: string;
}[];
/** A single fetched document: one item, titled and sourced where possible. */
export function extractWebFetchEvidence(result: any): {
    title: any;
    source: any;
    excerpt: string;
}[];
/** A page or record retrieved by id. */
export function extractWikiGetEvidence(result: any): {
    title: any;
    source: any;
    excerpt: string;
}[];
/**
 * Runtime and status tools.
 *
 * Deliberately narrow: rendered text only, no structured passthrough. Runtime
 * payloads are the most likely of any category to carry hostnames, paths,
 * tokens and internal identifiers, and there is no general shape to allowlist.
 */
export function extractRuntimeEvidence(result: any): {
    title: any;
    source: any;
    excerpt: string;
}[];
/**
 * Extract evidence items for one tool result.
 *
 * Returns an empty array for an unknown tool: the adapter table is an
 * allowlist, and a tool nobody has written an adapter for is not captured
 * "generically".
 */
export function extractEvidenceItems(tool: any, result: any, opts?: {}): any;
/**
 * The same extraction, and how much it had to leave behind.
 *
 * The per-call cap used to be applied by the adapter and then again by a
 * `slice`, and neither said anything. A search returning six usable hits under
 * a cap of two produced two excerpts and a turn that read `complete` — true of
 * what was stored, misleading about what was seen. A cap that cannot be
 * observed is indistinguishable from there being nothing more to capture.
 *
 * The adapter is asked for everything so the excess is an exact count rather
 * than "at least one more". The work is bounded by the tool result already in
 * memory; the expensive part, writing records, still happens only for the items
 * that survive the cap.
 */
export function extractEvidenceItemsBounded(tool: any, result: any, opts?: {}): {
    items: any;
    dropped: number;
};
export function extractWebSearchEvidence(r: any, o: any): {
    title: any;
    source: any;
    excerpt: string;
}[];
export function extractMemorySearchEvidence(r: any, o: any): {
    title: any;
    source: any;
    excerpt: string;
}[];
export function extractWikiSearchEvidence(r: any, o: any): {
    title: any;
    source: any;
    excerpt: string;
}[];
/** Tool name to adapter. Absence means the tool is not capturable. */
export const ADAPTERS: Readonly<{
    web_search: (r: any, o: any) => {
        title: any;
        source: any;
        excerpt: string;
    }[];
    web_fetch: typeof extractWebFetchEvidence;
    memory_search: (r: any, o: any) => {
        title: any;
        source: any;
        excerpt: string;
    }[];
    wiki_search: (r: any, o: any) => {
        title: any;
        source: any;
        excerpt: string;
    }[];
    wiki_get: typeof extractWikiGetEvidence;
}>;
