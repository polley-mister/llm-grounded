// Only one place in this package may decide what a turn is.
//
// A source-level test, which is unusual here and deliberate. The traffic bug
// was not a wrong answer; both answers were correct given what each caller
// could see. It was a second caller. No behavioural test can fail on "a third
// seam started classifying for itself" until that seam happens to be reached
// with metadata that differs — which, for the tool-result middleware, took four
// releases and a production telemetry query to notice.
//
// So the invariant is asserted where it actually lives: in the import graph.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

/** Where the resolver is defined, and where it is deliberately re-exported. */
const DEFINES = "traffic.js";
const REEXPORTS = "core.js";
/** The one module allowed to call it: the turn-initialization path. */
const AUTHORITY = "index.js";

const read = async (f) => readFile(path.join(SRC, f), "utf8");
const sources = async () => (await readdir(SRC)).filter((f) => f.endsWith(".js"));

test("the resolver is invoked from exactly one place", async () => {
  const s = await read(AUTHORITY);
  const calls = s.match(/resolveTrafficClass\s*\(/g) ?? [];
  assert.equal(
    calls.length,
    1,
    `${AUTHORITY} must call resolveTrafficClass once — at before_prompt_build, where the ` +
      `host supplies full identity — and pass the stored decision everywhere else. Found ${calls.length}.`,
  );
});

test("no other module imports the resolver", async () => {
  // The check aliasing cannot slip past: a module that wanted to classify would
  // have to import the function before it could rename it.
  for (const file of await sources()) {
    if (file === DEFINES || file === REEXPORTS || file === AUTHORITY) continue;
    const s = await read(file);
    assert.ok(
      !/\bresolveTrafficClass\b/.test(s),
      `src/${file} references resolveTrafficClass. Read the turn's decision from ` +
        "entry.traffic instead; classifying a second time is the 0.2.0–0.2.4 defect.",
    );
  }
});

test("the consumers read stored state rather than deriving it", async () => {
  const index = await read(AUTHORITY);
  const telemetry = await read("telemetry.js");

  // The evidence path.
  assert.match(
    index,
    /const traffic = entry\?\.traffic \?\? null;/,
    "evidence capture must read the turn's stored decision",
  );
  // Terminal telemetry.
  assert.match(index, /traffic: entry\?\.traffic \?\? null,/, "telemetry must copy the stored decision");
  // And nothing may reinstate a class for a turn that never had one.
  assert.doesNotMatch(
    telemetry,
    /trafficClass: extra\.traffic\?\.trafficClass \?\? "system"/,
    'buildTurnRecord must not default an unresolved turn to "system"',
  );
});

test("the reference to the retired second call site is really gone", async () => {
  // The exact shape of the old middleware-side classification, so a revert or a
  // bad merge that restores it fails here rather than in production telemetry.
  const index = await read(AUTHORITY);
  assert.doesNotMatch(
    index,
    /sessionId: event\?\.sessionId \?\? ctx\?\.sessionId \?\? entry\?\.sessionKey/,
    "the middleware must not reassemble identity signals of its own",
  );
});
