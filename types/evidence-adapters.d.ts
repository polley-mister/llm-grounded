/** Search results: one evidence item per hit. */
export declare function extractSearchEvidence(result: any, { maxItems }?: {
    maxItems?: number | undefined;
}): {
    title: null;
    source: null;
    excerpt: string;
}[];
export declare const extractWebSearchEvidence: (r: any, o: any) => {
    title: null;
    source: null;
    excerpt: string;
}[];
export declare const extractMemorySearchEvidence: (r: any, o: any) => {
    title: null;
    source: null;
    excerpt: string;
}[];
export declare const extractWikiSearchEvidence: (r: any, o: any) => {
    title: null;
    source: null;
    excerpt: string;
}[];
/** A single fetched document: one item, titled and sourced where possible. */
export declare function extractWebFetchEvidence(result: any): {
    title: null;
    source: null;
    excerpt: string;
}[];
/** A page or record retrieved by id. */
export declare function extractWikiGetEvidence(result: any): {
    title: null;
    source: null;
    excerpt: string;
}[];
/**
 * Runtime and status tools.
 *
 * Deliberately narrow: rendered text only, no structured passthrough. Runtime
 * payloads are the most likely of any category to carry hostnames, paths,
 * tokens and internal identifiers, and there is no general shape to allowlist.
 */
export declare function extractRuntimeEvidence(result: any): {
    title: null;
    source: null;
    excerpt: string;
}[];
/** Tool name to adapter. Absence means the tool is not capturable. */
export declare const ADAPTERS: Readonly<{
    web_search: typeof extractWebSearchEvidence;
    web_fetch: typeof extractWebFetchEvidence;
    memory_search: typeof extractMemorySearchEvidence;
    wiki_search: typeof extractWikiSearchEvidence;
    wiki_get: typeof extractWikiGetEvidence;
}>;
/**
 * Extract evidence items for one tool result.
 *
 * Returns an empty array for an unknown tool: the adapter table is an
 * allowlist, and a tool nobody has written an adapter for is not captured
 * "generically".
 */
export declare function extractEvidenceItems(tool: any, result: any, opts?: {}): any;
