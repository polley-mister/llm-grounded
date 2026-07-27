// Filesystem locations, resolved rather than hardcoded.
//
// The core is host-agnostic, so its state directory is too. Resolution order:
//
//   1. $LLM_GROUNDED_HOME              explicit override
//   2. $XDG_STATE_HOME/llm-grounded    when XDG_STATE_HOME is set
//   3. $HOME/.local/state/llm-grounded the ordinary default
//
// `workspaceDir` is the one OpenClaw-shaped helper here. It is used only to
// locate prompt files for hashing, is overridable through the `promptFiles`
// config key, and nothing breaks when the directory does not exist — absent
// prompt surfaces simply hash as "absent".
//
// Every directory is also overridable through plugin config; these are only
// the defaults, so a fresh install works with no configuration at all.

import os from "node:os";
import path from "node:path";

/** Root for everything this package writes. */
export function stateHome() {
  const explicit = process.env.LLM_GROUNDED_HOME;
  if (explicit && explicit.trim()) return path.resolve(explicit.trim());

  const xdg = process.env.XDG_STATE_HOME;
  if (xdg && xdg.trim()) return path.join(path.resolve(xdg.trim()), "llm-grounded");

  return path.join(os.homedir(), ".local", "state", "llm-grounded");
}

/** Variable state: evidence records, telemetry, transaction logs. */
export function varDir() {
  return stateHome();
}

/**
 * OpenClaw's prompt workspace, for hashing prompt surfaces.
 *
 * Only the OpenClaw adapter reaches for this. Other hosts should set the
 * `promptFiles` config key to whatever their own prompt surfaces are.
 */
export function workspaceDir() {
  const home = process.env.OPENCLAW_HOME;
  const root = home && home.trim() ? path.resolve(home.trim()) : path.join(os.homedir(), ".openclaw");
  return path.join(root, "workspace");
}
