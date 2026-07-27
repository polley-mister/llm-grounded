// ---------------------------------------------------------------------------
// Pre-tool block for searches that would locate private personal information.
//
// Independent of the routing work and stays in force after the classifier
// becomes advisory. Routing decides whether a tool is compelled; this decides
// whether a particular query may run at all. Those are different questions and
// the second one does not stop mattering when the first is relaxed.
//
// Observed in the baseline: a playful identity claim — "What if I told you
// that I am Marlowe Vance?" — produced a web_search for that person's
// current residence. The routing false positive is one defect; a tool planner
// that turns banter into a search for someone's home address is another, and
// the second one has consequences outside this house.
//
// Deliberately narrow. It blocks the *purpose* of locating a person, not the
// mention of a person, and exempts the technical senses of "address" that a
// homelab talks about constantly.
// ---------------------------------------------------------------------------

/** Technical senses of otherwise-loaded words. Checked first. */
const TECHNICAL_CONTEXT =
  /\b(?:ip|ipv4|ipv6|mac|memory|bus|base|network|email|smtp|http|url|bind|listen|loopback|broadcast|multicast|register|virtual|physical|hardware)\s+address(?:es|ing)?\b|\baddress\s+(?:space|range|book|bar|pool|family|translation)\b|\baddressing\b/i;

/** Intent to locate or contact a specific person. */
const SENSITIVE_INTENT = [
  /\b(?:home|house|residential|street|mailing)\s+address\b/i,
  /\b(?:current\s+)?(?:residence|whereabouts)\b/i,
  /\bwhere\s+(?:does|do|did|is)\s+\w[\w'.\- ]{0,40}\s*(?:live|living|reside|residing|based)\b/i,
  /\b(?:lives?|living|resides?|residing)\s+(?:in|at|near|on)\b/i,
  /\b(?:phone|cell|mobile|telephone)\s+number\b/i,
  /\b(?:personal|private|home)\s+(?:email|number|contact|phone)\b/i,
  /\b(?:contact\s+(?:details|info|information))\b/i,
  /\b(?:date\s+of\s+birth|social\s+security|passport\s+number|driver'?s?\s+licen[cs]e\s+number)\b/i,
  /\b(?:real\s+name|legal\s+name)\s+of\b/i,
];

/**
 * A capitalised multi-word name, or an explicit person reference.
 *
 * Requiring this keeps "what is the mailing address for support" and
 * "residential solar pricing" out of the block. The target is a query aimed at
 * a person.
 */
const LIKELY_PERSON =
  /\b\p{Lu}\p{L}+\s+\p{Lu}\p{L}+\b|\b(?:he|she|they|his|her|their|someone|somebody|this person|the actor|the director|the ceo)\b/u;

/** Tools whose arguments are a free-text query we should inspect. */
const QUERY_TOOLS = new Set(["web_search", "web_fetch", "search", "browser", "wiki_search"]);

function queryText(params) {
  if (!params || typeof params !== "object") return "";
  return ["query", "q", "search", "text", "url", "prompt"]
    .map((k) => (typeof params[k] === "string" ? params[k] : ""))
    .join(" ")
    .trim();
}

/**
 * Decide whether a proposed tool call is looking for private personal data.
 *
 * @returns {{blocked: boolean, reason?: string, matched?: string}}
 */
export function assessToolSafety(toolName, params) {
  if (!QUERY_TOOLS.has(toolName)) return { blocked: false };
  const text = queryText(params);
  if (!text) return { blocked: false };

  // Technical usage wins outright: a homelab discusses IP and MAC addresses
  // constantly and none of it is personal data.
  if (TECHNICAL_CONTEXT.test(text)) return { blocked: false };

  const intent = SENSITIVE_INTENT.find((re) => re.test(text));
  if (!intent) return { blocked: false };

  // Intent alone is not enough — it must be aimed at a person.
  if (!LIKELY_PERSON.test(text)) return { blocked: false };

  return {
    blocked: true,
    reason: "sensitive_personal_information",
    matched: String(intent).slice(0, 60),
  };
}

/** Message returned to the model in place of results. */
export function blockMessage() {
  // States the boundary without inviting a reformulation that evades it.
  return (
    "groundskeeper: refused — this search would look up private personal " +
    "information (residence, contact details, or identity by location). " +
    "Answer without it, or ask the operator what he actually wants to know."
  );
}
