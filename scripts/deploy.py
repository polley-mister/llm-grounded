#!/usr/bin/env python3
"""Deploy a packed llm-grounded artifact, and roll back if it does not come up.

The invariant this exists to enforce:

    a successful gateway restart is not a successful plugin deployment

0.3.0 was deployed by writing the config, watching the gateway restart cleanly,
and calling it done. The gateway did start cleanly. It started with the plugin
absent — registration threw — so grounding, the voice contract and evidence
capture were all silently off, and the only sign was one line in a log nobody
was tailing. A gateway that comes up without llm-grounded is a failed
deployment even though the process is healthy.

Two checks, protecting different boundaries:

  preflight       registers the packed artifact against the exact config about
                  to be written, in this process, before anything is changed.
                  Catches deterministic registration and configuration faults.

  post-restart    asks the running host what it actually loaded. Catches
                  host-loader and runtime integration faults that no amount of
                  in-process checking can see.

Anything the post-restart gate does not like restores the previous artifact path
and the previous config keys in a single write.

Usage:

    python3 scripts/deploy.py \\
      --artifact /home/ai/deploy/llm-grounded-<commit> \\
      --version 0.3.2 \\
      --epoch v0.3.2-operational-measurement \\
      [--config ~/.openclaw/openclaw.json] \\
      [--set claimExtractionEnabled=true] \\
      [--timeout 180] [--dry-run]
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

PLUGIN_ID = "llm-grounded"


def log(message):
    print(f"[deploy] {message}", flush=True)


def fail(message):
    print(f"[deploy] FAILED: {message}", file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

def read_config(path):
    return json.loads(Path(path).read_text())


def write_config(path, document):
    """Atomic, mode-preserving, and parsed before it replaces anything."""
    target = Path(path)
    tmp = target.with_suffix(".json.deploy-tmp")
    tmp.write_text(json.dumps(document, indent=2) + "\n")
    json.loads(tmp.read_text())
    shutil.copymode(target, tmp)
    tmp.replace(target)


def snapshot(document):
    """Everything this script may change, so a rollback is one write."""
    entry = document["plugins"]["entries"][PLUGIN_ID]
    return {
        "paths": list(document["plugins"]["load"]["paths"]),
        "config": json.loads(json.dumps(entry["config"])),
    }


def restore(document, saved):
    document["plugins"]["load"]["paths"] = list(saved["paths"])
    document["plugins"]["entries"][PLUGIN_ID]["config"] = json.loads(json.dumps(saved["config"]))
    return document


def coerce(raw):
    """--set values are JSON when they parse as JSON, and strings otherwise."""
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return raw


# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

PREFLIGHT = """
import { createPlugin } from "%s/src/index.js";
const config = JSON.parse(process.env.LG_PREFLIGHT_CONFIG);
const errors = [];
const p = createPlugin({});
p.register({
  on: () => {},
  registerTool: () => {},
  registerAgentToolResultMiddleware: () => {},
  logger: { info: () => {}, warn: () => {}, error: (m) => errors.push(String(m)), debug: () => {} },
  config: { plugins: { entries: { "llm-grounded": { enabled: true, config } } } },
});
if (typeof p.handlers.before_prompt_build !== "function") {
  console.error("registered without hooks");
  process.exit(1);
}
if (errors.length) {
  console.error(errors.join("; "));
  process.exit(1);
}
console.log("ok");
"""


def preflight(artifact, config):
    """Register the packed artifact against the exact config, before writing it."""
    env = dict(os.environ, LG_PREFLIGHT_CONFIG=json.dumps(config))
    result = subprocess.run(
        ["node", "--input-type=module", "-e", PREFLIGHT % artifact],
        capture_output=True, text=True, env=env,
    )
    if result.returncode != 0:
        return False, (result.stderr or result.stdout).strip()
    return True, "registered cleanly"


# ---------------------------------------------------------------------------
# Post-restart verification
# ---------------------------------------------------------------------------

def inspect_runtime():
    """What the running host says it loaded. None while it is restarting."""
    result = subprocess.run(
        ["openclaw", "plugins", "inspect", PLUGIN_ID, "--runtime", "--json"],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        return None
    try:
        return json.loads(result.stdout).get("plugin")
    except json.JSONDecodeError:
        return None


def user_env():
    """
    An environment in which `systemctl --user` and `journalctl --user` work.

    Both need a session bus, and under `su -` there is none. Supplied here in
    one place because fixing it for one of the two and not the other is exactly
    what happened the first time: the service check was corrected, the journal
    check was not, and the next deployment failed on the half that was missed.
    """
    env = dict(os.environ)
    uid = os.getuid()
    env.setdefault("XDG_RUNTIME_DIR", f"/run/user/{uid}")
    env.setdefault("DBUS_SESSION_BUS_ADDRESS", f"unix:path=/run/user/{uid}/bus")
    return env


def gateway_state():
    """
    'active', 'inactive', or 'unknown'.

    The three are not two. `systemctl --user` needs a session bus, and under
    `su - user` there is none — the first run of this gate could not consult the
    service at all, read that as "not running", and rolled back a perfectly good
    deployment. A check that cannot tell "I can't see it" from "it's down" will
    reject every deployment it is asked about.

    XDG_RUNTIME_DIR is supplied when absent so the usual case simply works; an
    environment where it still cannot be reached reports 'unknown', and the
    caller falls back to what the host itself says it loaded.
    """
    try:
        result = subprocess.run(
            ["systemctl", "--user", "is-active", "openclaw-gateway.service"],
            capture_output=True, text=True, env=user_env(),
        )
    except OSError:
        return "unknown"
    state = result.stdout.strip()
    if state == "active":
        return "active"
    # `failed` and `inactive` are real answers. Anything else — a bus error, an
    # empty reply, `activating` mid-restart — is not a verdict.
    if state in ("inactive", "failed"):
        return "inactive"
    if "Failed to connect" in (result.stderr or ""):
        return "unknown"
    return "unknown"


def epoch_state(epoch, since):
    """
    'confirmed', 'absent', or 'unknown'.

    The plugin's own startup line is the only direct evidence that it read the
    config we wrote rather than a cached one. Three-valued for the same reason
    the service check is: a journal that cannot be read is not a journal that
    says no.
    """
    try:
        result = subprocess.run(
            ["journalctl", "--user", "-u", "openclaw-gateway.service", "--since", since, "--no-pager"],
            capture_output=True, text=True, env=user_env(),
        )
    except OSError:
        return "unknown"
    if result.returncode != 0:
        return "unknown"
    if f"behaviorEpoch={epoch}" in result.stdout:
        return "confirmed"
    # The journal is readable and the line is not there yet. That may simply be
    # timing, so the caller keeps waiting rather than failing here.
    return "absent"


def verify(artifact, version, epoch, since, timeout):
    """
    Every condition, or a named failure.

    Polled rather than slept-on: the watcher restart takes a variable few
    seconds and a fixed sleep is either too short to be reliable or long enough
    to be annoying on every deploy.

    The invariant, stated because it would otherwise only be emergent from the
    order of the checks below:

        an unreadable signal may abstain, but success requires positive
        evidence from at least one authoritative runtime source

    Making `systemctl` and `journalctl` three-valued was right — a check that
    cannot be read is not a check that says no, and treating it as one rejected
    two healthy deployments. The failure mode on the other side is worse and
    quieter: if every signal degrades to "unknown", abstention all the way down
    reads as success, and the gate reports a deployment it never observed.

    So the host's own report of what it loaded is not permitted to abstain.
    `inspect_runtime()` returning nothing keeps the loop waiting and eventually
    fails; it never passes. Everything positively observed is counted and
    returned, so the caller can say what the verdict rests on.
    """
    deadline = time.time() + timeout
    last = "the gateway never reported the new artifact"
    warned_unknown = False
    warned_journal = False
    while time.time() < deadline:
        time.sleep(3)
        state = gateway_state()
        if state == "inactive":
            last = "the gateway service is not active"
            continue
        if state == "unknown" and not warned_unknown:
            # Said once, not every three seconds. The host's own report of what
            # it loaded is the stronger signal anyway.
            log("note: the service state could not be read; relying on the host's plugin report")
            warned_unknown = True
        plugin = inspect_runtime()
        if plugin is None:
            last = "the host could not be asked what it loaded"
            continue
        if plugin.get("rootDir") != artifact:
            # Still serving the old artifact: the restart has not happened yet.
            last = f"the host is still running {plugin.get('rootDir')}"
            continue

        # From here on a mismatch is a real failure, not impatience.
        #
        # Everything checked below comes from the host's own report, which is
        # the authoritative source the invariant requires. Reaching this point
        # at all means it was read.
        observed = ["artifact path"]
        if plugin.get("status") != "loaded":
            return False, f"plugin status is {plugin.get('status')!r}, not 'loaded'"
        if not plugin.get("activated"):
            return False, "plugin loaded but was not activated"
        observed.append("status=loaded")
        observed.append("activated")
        if plugin.get("version") != version:
            return False, f"plugin reports version {plugin.get('version')}, expected {version}"
        observed.append(f"version={version}")

        state = epoch_state(epoch, since)
        if state == "absent":
            # The right artifact and version are loaded; only the epoch line has
            # not appeared. Keep waiting — the plugin logs it during startup and
            # the host may not have flushed it yet.
            last = f"loaded {version}, but no startup line reporting behaviorEpoch={epoch} yet"
            continue
        if state == "unknown" and not warned_journal:
            log("note: the journal could not be read; the epoch line cannot be confirmed")
            warned_journal = True
        if state == "confirmed":
            observed.append(f"epoch={epoch}")

        # The invariant, enforced rather than assumed. Unreachable as written —
        # `observed` always holds the artifact path by now — and kept because
        # the thing it guards against is a future edit that lets one more signal
        # abstain, one at a time, until nothing is actually checked.
        if not observed:
            return False, "no runtime signal could be positively observed"

        return True, (
            f"{PLUGIN_ID} {version} loaded from {artifact}"
            f" [observed: {', '.join(observed)}]"
        )
    return False, last


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="Deploy llm-grounded with a health gate.")
    ap.add_argument("--artifact", required=True, help="packed artifact directory")
    ap.add_argument("--version", required=True, help="version the artifact must report")
    ap.add_argument("--epoch", required=True, help="behaviorEpoch to set and then verify")
    ap.add_argument("--config", default=str(Path.home() / ".openclaw/openclaw.json"))
    ap.add_argument("--set", action="append", default=[], metavar="KEY=VALUE",
                    help="additional plugin config key, JSON-valued where it parses")
    ap.add_argument("--timeout", type=int, default=180, help="seconds to wait for a healthy load")
    ap.add_argument("--dry-run", action="store_true", help="preflight only; change nothing")
    args = ap.parse_args()

    artifact = str(Path(args.artifact).resolve())
    manifest = Path(artifact) / "openclaw.plugin.json"
    if not manifest.exists():
        fail(f"{artifact} does not look like a packed artifact")
        return 1
    packed_version = json.loads(manifest.read_text())["version"]
    if packed_version != args.version:
        fail(f"artifact declares {packed_version}, --version says {args.version}")
        return 1

    document = read_config(args.config)
    saved = snapshot(document)
    log(f"current artifact: {saved['paths'][0]}")
    log(f"current epoch:    {saved['config'].get('behaviorEpoch')}")

    prospective = json.loads(json.dumps(saved["config"]))
    prospective["behaviorEpoch"] = args.epoch
    for pair in args.set:
        key, _, raw = pair.partition("=")
        prospective[key] = coerce(raw)

    ok, detail = preflight(artifact, prospective)
    if not ok:
        fail(f"preflight: {detail}")
        log("nothing was changed")
        return 1
    log(f"preflight: {detail}")

    if args.dry_run:
        log("dry run: stopping before any change")
        return 0

    backup = Path(args.config).with_suffix(
        f".json.bak.pre-{args.version}-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
    )
    shutil.copy2(args.config, backup)
    log(f"backup: {backup}")

    since = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    document["plugins"]["load"]["paths"][0] = artifact
    document["plugins"]["entries"][PLUGIN_ID]["config"] = prospective
    write_config(args.config, document)
    log(f"wrote artifact and {len(args.set) + 1} config key(s); waiting for the watcher")

    ok, detail = verify(artifact, args.version, args.epoch, since, args.timeout)
    if ok:
        log(f"verified: {detail}")
        return 0

    fail(detail)
    log("rolling back artifact path and config keys in one write")
    write_config(args.config, restore(read_config(args.config), saved))

    # The config keys go back too, not just the path. The previous build does
    # not know the new keys and refuses a config carrying them, so restoring the
    # artifact alone would swap one failed deployment for another.
    #
    # Version and epoch are not re-asserted on the way back: the previous
    # artifact is whatever it was, and demanding a version here would turn a
    # successful rollback into a reported failure after a typo in --version.
    deadline = time.time() + args.timeout
    while time.time() < deadline:
        time.sleep(3)
        plugin = inspect_runtime()
        if plugin and plugin.get("rootDir") == saved["paths"][0] and plugin.get("status") == "loaded":
            log(f"rolled back to {saved['paths'][0]}")
            return 1
    fail("ROLLBACK DID NOT COME UP — the gateway needs a human")
    return 2


if __name__ == "__main__":
    sys.exit(main())
