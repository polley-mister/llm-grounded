/** Root for everything this package writes. */
export declare function stateHome(): any;
/** Variable state: evidence records, telemetry, transaction logs. */
export declare function varDir(): any;
/**
 * OpenClaw's prompt workspace, for hashing prompt surfaces.
 *
 * Only the OpenClaw adapter reaches for this. Other hosts should set the
 * `promptFiles` config key to whatever their own prompt surfaces are.
 */
export declare function workspaceDir(): any;
