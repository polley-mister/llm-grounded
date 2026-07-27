// The narrow bridge to the Vault Tools fact-transaction writer.
//
// Vault Tools owns every deterministic guarantee — path validation, locking,
// compare-and-swap, before-images, atomic replacement, the append-only journal,
// the lint gate, and rollback. This file's entire job is to hand it one JSON
// document and read one JSON document back.
//
// Two properties matter more than anything else here:
//
//   1. No shell. The child is started with an argv array, never a command
//      string, so there is nothing to quote or escape and nothing a crafted
//      value could break out of.
//   2. No model-supplied paths. The interpreter, the script, and `--vault` all
//      come from operator config. The only model-influenced data travels as
//      typed fields inside the JSON body, and every one of them is re-validated
//      on the Python side.
//
// ---------------------------------------------------------------------------
// SECURITY NOTE — read before changing this file.
//
// OpenClaw's install-time code-safety scanner flags any line matching
// `spawn(` in a file that mentions `child_process` as a *critical*
// `dangerous-exec` finding, which blocks `openclaw plugins install`. That is a
// true positive: this file really does start a subprocess. It is not spelled
// around, and it must not be. `scripts/build-check.mjs` therefore carries one
// declared exception naming this exact file and rule; every other finding in
// the repository still fails the build.
//
// Consequence, recorded for the reviewer: this plugin is loaded through
// `plugins.load.paths` and deployed by a Gateway restart, so the install audit
// is not on the deployment path today. A future `openclaw plugins install` of
// this package will report one critical finding and must be re-adjudicated —
// either by accepting it explicitly, by porting the writer to JavaScript (which
// would move the deterministic guarantees out of Vault Tools), or by running
// the writer as a local service. Do not resolve it with
// `--dangerously-force-unsafe-install`.
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";

export const DEFAULT_TIMEOUT_MS = 20000;
const MAX_OUTPUT_BYTES = 256 * 1024;

/**
 * Run one fact transaction.
 *
 * Never throws for a transaction problem: a refusal is data, and the caller
 * turns it into a tool result the model can read.
 *
 * @returns {Promise<{ok: boolean, code: string, [key: string]: unknown}>}
 */
export function commitFactTransaction(request, options = {}) {
  const python = options.pythonPath || "python3";
  const script = options.scriptPath;
  const vault = options.vaultPath;
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const runner = options.spawnFn ?? spawn;

  if (!script || !vault) {
    return Promise.resolve({
      ok: false,
      code: "not-configured",
      message: "factsCliPath and vaultPath must both be configured",
    });
  }

  const body = JSON.stringify(request);

  return new Promise((resolve) => {
    let child;
    try {
      // argv array, no shell, fixed argument shape.
      child = runner(python, [script, "--vault", vault], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C.UTF-8" },
      });
    } catch (err) {
      resolve({ ok: false, code: "spawn-failed", message: String(err?.message ?? err) });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let overflowed = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* the process is already gone */
      }
      finish({ ok: false, code: "transaction-timeout", message: `no result within ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      if (stdout.length + chunk.length > MAX_OUTPUT_BYTES) {
        overflowed = true;
        return;
      }
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 4096) stderr += chunk;
    });

    child.on("error", (err) => {
      finish({ ok: false, code: "spawn-failed", message: String(err?.message ?? err) });
    });

    child.on("close", (code) => {
      if (overflowed) {
        finish({ ok: false, code: "oversized-response", message: "writer produced too much output" });
        return;
      }
      const text = stdout.trim();
      if (!text) {
        finish({
          ok: false,
          code: "no-response",
          message: `writer exited ${code} without a response${stderr ? `: ${stderr.trim().slice(0, 300)}` : ""}`,
        });
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        finish({ ok: false, code: "malformed-response", message: "writer response was not JSON" });
        return;
      }
      if (!parsed || typeof parsed !== "object" || typeof parsed.ok !== "boolean") {
        finish({ ok: false, code: "malformed-response", message: "writer response had no ok field" });
        return;
      }
      finish(parsed);
    });

    try {
      child.stdin?.end(body, "utf8");
    } catch (err) {
      finish({ ok: false, code: "write-failed", message: String(err?.message ?? err) });
    }
  });
}
