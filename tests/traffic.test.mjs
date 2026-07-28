// Traffic classification: from host metadata, never from turn content.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  resolveTrafficClass,
  isResolvedTraffic,
  isTrafficClass,
  TRAFFIC_CLASSES,
} from "../src/traffic.js";

/** The rules this installation actually needs, from the observed corpus. */
const RULES = {
  bySessionPrefix: {
    "mc-chat": "human",
    "ops-triage": "scheduled_automation",
  },
  byAgent: {
    "chat": "human",
    main: "heartbeat",
  },
  default: "system",
};

test("a Mission Control chat session is human", () => {
  const r = resolveTrafficClass(
    { sessionId: "mc-chat-main-20260726-2312", agentId: "chat" }, RULES,
  );
  assert.equal(r.trafficClass, "human");
  assert.equal(r.reason, "session-prefix:mc-chat");
});

test("an isolated heartbeat run is not human", () => {
  // The exact shape that polluted the Phase 0 corpus: agent main, a fresh
  // session id per run because heartbeat.isolatedSession is true.
  const r = resolveTrafficClass(
    { sessionId: "dada6c92-a1ed-4807-8e8e-cd0616ba916f", agentId: "main" }, RULES,
  );
  assert.equal(r.trafficClass, "heartbeat");
  assert.equal(r.reason, "agent:main");
});

test("session identity outranks agent identity", () => {
  // One agent serves several kinds of traffic. `main` answers both the
  // scheduled heartbeat and a named operations run, and only the session
  // distinguishes them.
  const r = resolveTrafficClass({ sessionId: "ops-triage-2026-07-27", agentId: "main" }, RULES);
  assert.equal(r.trafficClass, "scheduled_automation");
});

test("test traffic is recognised without configuration", () => {
  for (const [id, reason] of [["synthetic-failclosed-1", "builtin-prefix:synthetic-"],
                              ["smoke-1785132739", "builtin-prefix:smoke-"]]) {
    const r = resolveTrafficClass({ sessionId: id, agentId: "chat" }, RULES);
    assert.equal(r.trafficClass, "synthetic_test", id);
    assert.equal(r.reason, reason);
  }
});

test("a longer configured prefix wins regardless of declaration order", () => {
  const rules = { bySessionPrefix: { "mc": "system", "mc-chat": "human" }, default: "system" };
  assert.equal(resolveTrafficClass({ sessionId: "mc-chat-1" }, rules).trafficClass, "human");
});

test("the session key is consulted as well as the session id", () => {
  const r = resolveTrafficClass({ sessionKey: "mc-chat-main-1", agentId: "x" }, RULES);
  assert.equal(r.trafficClass, "human");
});

test("an unknown agent falls to the configured default", () => {
  // A written default is the operator's answer for a turn that carries identity
  // and matches no rule. That is a decision, so it resolves.
  const r = resolveTrafficClass({ sessionId: "abc", agentId: "market-research" }, RULES);
  assert.equal(r.status, "resolved");
  assert.equal(r.trafficClass, "system");
  assert.equal(r.reason, "default");
});

test("a turn with no identity at all is unresolved, never the default", () => {
  // The whole defect in one case. The tool-result middleware sees no session
  // and no agent; with a configured `default: "system"` the old code answered
  // "system", which is a real class, so every consumer downstream believed the
  // turn had been identified. Missing metadata now has its own answer.
  const r = resolveTrafficClass({}, RULES);
  assert.equal(r.status, "unresolved");
  assert.equal(r.trafficClass, null);
  assert.equal(r.reason, "identity_unavailable");
});

test("no rules at all is a configuration fault, not a class", () => {
  const r = resolveTrafficClass({ sessionId: "x", agentId: "y" });
  assert.equal(r.status, "unresolved");
  assert.equal(r.trafficClass, null);
  assert.equal(r.reason, "configuration_unresolved:unset");
});

test("a misconfigured class never becomes a new category", () => {
  // Label drift is what makes a corpus unqueryable. An invalid value is refused
  // rather than admitted under a fallback name, and the offending value stays
  // in the reason so the misconfiguration is visible in the data.
  const r = resolveTrafficClass({ agentId: "main" }, { byAgent: { main: "Human Traffic" } });
  assert.equal(r.status, "unresolved");
  assert.equal(r.trafficClass, null);
  assert.match(r.reason, /invalid\(Human Traffic\)/);
  assert.ok(!isTrafficClass(r.trafficClass));
});

test("the raw signals travel with the verdict", () => {
  // So a turn can be re-scored when the rules change, instead of being
  // stranded the way the first corpus was.
  const r = resolveTrafficClass({ sessionId: "s", sessionKey: "k", agentId: "a" }, RULES);
  assert.deepEqual(r.signals, { sessionId: "s", sessionKey: "k", agentId: "a" });
});

test("turn content is never consulted", () => {
  // The heartbeat prompt is a string a human could type. Passing it changes
  // nothing, because it is not read.
  const a = resolveTrafficClass({ sessionId: "mc-chat-1", agentId: "chat" }, RULES);
  const b = resolveTrafficClass(
    { sessionId: "mc-chat-1", agentId: "chat", turn: "Read HEARTBEAT.md if it exists" }, RULES,
  );
  assert.deepEqual(a, b);
});

test("every emitted class is in the enum, and only resolved verdicts emit one", () => {
  const cases = [
    { sessionId: "mc-chat-1" }, { agentId: "main" }, { sessionId: "smoke-1" },
    { sessionId: "ops-triage-x" }, {}, { agentId: "nope" },
  ];
  for (const c of cases) {
    const r = resolveTrafficClass(c, RULES);
    const label = JSON.stringify(c);
    if (r.status === "resolved") {
      assert.ok(TRAFFIC_CLASSES.includes(r.trafficClass), label);
    } else {
      // No class at all, so nothing can read one off an unresolved turn by
      // accident. That is the property, not merely "the value is in the enum".
      assert.equal(r.trafficClass, null, label);
    }
  }
});

test("the signals travel with an unresolved verdict too", () => {
  // An unresolved turn is still re-scorable once the rules change; it is not
  // stranded the way the first corpus was.
  const r = resolveTrafficClass({ sessionId: "x", agentId: "y" });
  assert.deepEqual(r.signals, { sessionId: "x", sessionKey: null, agentId: "y" });
});

test("isResolvedTraffic accepts only a verdict naming a real class", () => {
  assert.ok(isResolvedTraffic(resolveTrafficClass({ sessionId: "mc-chat-1" }, RULES)));
  assert.ok(!isResolvedTraffic(resolveTrafficClass({}, RULES)));
  assert.ok(!isResolvedTraffic(null));
  // A hand-made object claiming to be resolved without a real class is refused.
  assert.ok(!isResolvedTraffic({ status: "resolved", trafficClass: "Human Traffic" }));
});
