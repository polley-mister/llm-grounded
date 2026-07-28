/** Root for everything this package writes. */
export function stateHome(): any;
/** Variable state: evidence records, telemetry, transaction logs. */
export function varDir(): any;
/**
 * OpenClaw's prompt workspace, for hashing prompt surfaces.
 *
 * Only the OpenClaw adapter reaches for this. Other hosts should set the
 * `promptFiles` config key to whatever their own prompt surfaces are.
 */
export function workspaceDir(): any;
