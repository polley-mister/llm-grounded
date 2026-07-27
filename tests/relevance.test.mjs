import assert from "node:assert/strict";
import test from "node:test";

import { queryIsUnrelated } from "../src/state.js";

import "./_vocabulary.mjs";

test("a search about a different subject does not ground the turn", () => {
  // The observed failure: asked to change its own humor setting, the model ran
  // a web_search about the horsepower figures discussed several turns earlier
  // and the answer was accepted because a search had happened.
  assert.equal(
    queryIsUnrelated("Are you able to change your Humor setting to 100?", {
      query: "N55 JB4 map 5 wheel horsepower dyno",
    }),
    true,
  );
});

test("a search on the asked subject grounds the turn", () => {
  assert.equal(
    queryIsUnrelated("What is the latest Proxmox release?", {
      query: "Proxmox VE latest release version",
    }),
    false,
  );
});

test("paraphrase and narrowing still count as related", () => {
  // One shared content word is enough. The gate exists to catch a wholly
  // different subject, not to police query wording.
  assert.equal(
    queryIsUnrelated("how bad is the adguard exporter CVE situation", {
      query: "adguard exporter vulnerabilities 2026",
    }),
    false,
  );
});

test("too little to judge is never treated as unrelated", () => {
  // Fail open when there is nothing to compare: a short question, a missing
  // query, or a query of stopwords must not fail a turn closed.
  assert.equal(queryIsUnrelated("why?", { query: "anything at all here" }), false);
  assert.equal(queryIsUnrelated("what are the open ports on gateway-01", {}), false);
  assert.equal(
    queryIsUnrelated("what are the open ports on gateway-01", { query: "the and of" }),
    false,
  );
  assert.equal(queryIsUnrelated("", { query: "unrelated words entirely" }), false);
});

test("the agent's own name is not shared subject matter", () => {
  // "Atlas" is a stopword here: it appears in nearly every turn, so counting it
  // as overlap would let any search ground any question.
  assert.equal(
    queryIsUnrelated("Atlas, what is your verbosity set to?", {
      query: "the agent a film robot design",
    }),
    true,
  );
});
