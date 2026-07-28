/**
 * Compute the observation numbers.
 *
 * @param {object[]} turns telemetry records
 * @param {Map<string, object>|null} extractions extraction records by id, when the store was read
 * @param {{eligible?: string[], pricing?: {inputPerMillion: number, outputPerMillion: number, currency?: string}}} [opts]
 */
export function shadowMetrics(turns: object[], extractions?: Map<string, object> | null, opts?: {
    eligible?: string[];
    pricing?: {
        inputPerMillion: number;
        outputPerMillion: number;
        currency?: string;
    };
}): {
    overall: any;
    byTraffic: {
        [k: string]: any;
    };
    basis: {
        eligibleClasses: string[];
        extractionStoreRead: boolean;
        pricingSupplied: boolean;
        infrastructureAbstentions: string[];
    };
};
/**
 * A stratified review sample.
 *
 * Stratified rather than random because the interesting groups are rare: an
 * all-material extraction and a stored-personal claim would each appear once or
 * twice in fifty random turns, and those are the two the materiality judge is
 * most likely to be wrong about.
 *
 * Deterministic given the same input and seed, so a review can be repeated and
 * a second reviewer sees the same fifty turns.
 */
export function reviewSample(turns: any, extractions: any, opts?: {}): {
    sample: {};
    requested: any;
    found: any;
    poolSize: number;
};
