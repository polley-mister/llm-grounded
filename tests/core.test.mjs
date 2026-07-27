// The core must stay framework-independent.
//
// This is a structural test, not a behavioural one. The claim in
// docs/INTEGRATION.md — "import the core and write your own adapter" — is only
// true while nothing reachable from src/core.js reaches back into the OpenClaw
// adapter or a host package. That is easy to break with one convenience import
// and impossible to notice by reading, so it is asserted here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

/**
 * Source with comments removed.
 *
 * Required, not tidiness: this file is heavily commented and the prose quotes
 * things. `// ...different thing from "use whatever the session last did"`
 * reads as an import specifier to any regex naive enough to scan raw text.
 */
function code(file) {
  return readFileSync(path.join(SRC, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** Relative specifiers imported by a source file. */
function localImports(file) {
  return [...code(file).matchAll(/from\s+"(\.\/[^"]+)"/g)].map((m) => m[1].replace(/^\.\//, ""));
}

/** Everything reachable from an entry point, following relative imports only. */
function reachable(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const dep of localImports(file)) if (!seen.has(dep)) queue.push(dep);
  }
  return seen;
}

test("the core never reaches the OpenClaw adapter", () => {
  const closure = reachable("core.js");
  assert.equal(
    closure.has("index.js"),
    false,
    "src/core.js transitively imports the adapter — the seam is gone",
  );
});

test("nothing reachable from the core imports a host package", () => {
  for (const file of reachable("core.js")) {
    const bare = [...code(file).matchAll(/from\s+"([^".][^"]*)"/g)]
      .map((m) => m[1])
      .filter((spec) => !spec.startsWith("node:"));
    assert.deepEqual(bare, [], `src/${file} imports a non-node package: ${bare.join(", ")}`);
  }
});

test("the core decision path opens no sockets and spawns no processes", () => {
  // evidence.js and telemetry.js write JSONL and are exported deliberately;
  // case-audit.js spawns the audit and is NOT part of the core. Neither of the
  // writers may reach the network, and nothing in the closure may spawn.
  for (const file of reachable("core.js")) {
    const text = code(file);
    assert.equal(/from "node:(net|http|https|dgram|tls)"/.test(text), false, `src/${file} opens sockets`);
    assert.equal(/from "node:child_process"/.test(text), false, `src/${file} spawns a process`);
  }
});

test("every core export resolves", async () => {
  const mod = await import("../src/core.js");
  const missing = Object.entries(mod).filter(([, v]) => v === undefined);
  assert.deepEqual(missing.map(([k]) => k), []);
  // A barrel that silently shrinks is a broken published API, so hold a floor.
  assert.ok(Object.keys(mod).length >= 50, `core exports ${Object.keys(mod).length}, expected >= 50`);
});

test("the barrel does not omit a module the adapter treats as core", () => {
  // If a new src/*.js appears, it is either part of the core surface or
  // deliberately host-only. Listing the host-only set here forces that to be a
  // decision rather than an oversight.
  const HOST_ONLY = new Set(["index.js", "core.js", "facts-tool.js", "facts-overlay.js", "vault-txn.js", "case-audit.js"]);
  const modules = readdirSync(SRC).filter((f) => f.endsWith(".js"));
  const closure = reachable("core.js");
  const orphaned = modules.filter((f) => !HOST_ONLY.has(f) && !closure.has(f));
  assert.deepEqual(orphaned, [], `unreachable from the core barrel: ${orphaned.join(", ")}`);
});
