// Filesystem locations, resolved rather than hardcoded.
//
// Every path this plugin writes to lives under the OpenClaw home directory.
// That directory is discovered in this order:
//
//   1. $OPENCLAW_HOME          — explicit override, used by tests and by
//                                deployments that place state outside $HOME
//   2. $HOME/.openclaw         — the ordinary installation
//
// Individual directories remain overridable through plugin config; these are
// only the defaults, so a fresh install works with no configuration at all.

import os from "node:os";
import path from "node:path";

/** Root of the OpenClaw installation state. */
export function openclawHome() {
  const explicit = process.env.OPENCLAW_HOME;
  if (explicit && explicit.trim()) return path.resolve(explicit.trim());
  return path.join(os.homedir(), ".openclaw");
}

/** Per-plugin variable state: evidence records, telemetry, transaction logs. */
export function pluginVarDir() {
  return path.join(openclawHome(), "var", "groundskeeper");
}

/** Prompt surfaces whose wording changes behaviour without touching code. */
export function workspaceDir() {
  return path.join(openclawHome(), "workspace");
}
