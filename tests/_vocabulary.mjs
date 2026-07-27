// Installation vocabulary for the test suite.
//
// The classifier ships with nobody's private world compiled in, so the tests
// supply a fictional one. Importing this module configures it as a side effect;
// `node --test` runs each file in its own process, so a file that does not
// import it sees an unconfigured classifier — which is itself worth testing.
//
// Atlas is the agent. Sam Rivera is the operator, and owns a car, a parts
// catalogue, and an on-call rotation.

import { configureAgentNames, configurePersonalTerms } from "../src/classify.js";

export const AGENT = "Atlas";
export const OPERATOR = "Sam";

export const PERSONAL_TERMS = [
  "sam",
  "rivera",
  "parts catalogue",
  "on-call weekend",
];

export const AGENT_NAMES = ["atlas"];

configureAgentNames(AGENT_NAMES);
configurePersonalTerms(PERSONAL_TERMS);
