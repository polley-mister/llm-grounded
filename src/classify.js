// Deterministic grounding classification for the agent turns.
//
// No LLM call, no network, no filesystem. Pure string analysis so the same
// rules can be mirrored byte-for-byte in the console and asserted against
// one shared vector file.
//
// Kinds:
//   "web"    — current information; named external people/works/events/products/
//              places; mixed fact-plus-emotion; corrections to external facts.
//   "memory" — the operator, preferences, prior decisions, projects, personal dates,
//              stored workspace context.
//   null     — "direct": arithmetic, transformations, creative work, casual
//              conversation, or opinion with no external factual premise.
//
// Precedence (from the accepted work package):
//   current web  >  personal/project memory  >  named external fact  >  direct

/**
 * Signals that the answer depends on information that changes over time.
 *
 * Deliberately narrow. A bare "price"/"version"/"update" hit sent ordinary
 * project questions ("where did we land on the the parts catalogue pricing tiers") to the
 * web tier, which the precedence rule would then never let memory reclaim.
 */
const CURRENT_INFO = [
  /\b(today|tonight|tomorrow|yesterday)\b/i,
  /\b(currently|right now|at the moment|as of now|as of today)\b/i,
  /\bcurrent (?:price|version|state of|status of|president|ceo|weather|score)\b/i,
  /\b(latest|newest|most recent)\b/i,
  /\brecently\b/i,
  /\bthis (?:week|month|year)\b/i,
  /\blast (?:week|month|year)\b/i,
  /\b(news|headlines?|breaking)\b/i,
  /\b(stock price|share price|market cap|exchange rate|price of)\b/i,
  /\bhow much (?:does|do|is|are)\b[^?]{0,40}\bcost\b/i,
  /\b(weather|forecast)\b/i,
  /\b(final score|standings|who won)\b/i,
  /\b(release date|changelog)\b/i,
  /\bjust (?:released|shipped|launched)\b/i,
  /\bwho is the (?:current )?(?:president|prime minister|ceo|chair(?:man|woman)?)\b/i,
  /\bstill (?:alive|running|supported|maintained)\b/i,
];

/**
 * Signals that the answer lives in the operator's own stored context.
 *
 * These are deliberately generic: possessives, shared-history vocabulary, and
 * product names that any self-hosted operator might run. Anything that
 * identifies a *particular* operator — their name, their projects, their
 * hardware, their vehicle — belongs in `personalTerms` config instead, so this
 * file carries no one's private world. See `configurePersonalTerms` below.
 */
const MEMORY_TERMS = [
  // Possessives and shared history.
  /\bmy\b/i,
  /\bmine\b/i,
  /\bour\b/i,
  /\bwe (?:decide[ds]?|agree[ds]?|chose|choose|pick(?:ed)?|settle[ds]?|discuss(?:ed)?|talk(?:ed)? about|said|land(?:ed)? on)\b/i,
  /\byou (?:said|told me|recorded|remembered|noted)\b/i,
  /\blast time\b/i,
  /\bremember\b/i,
  // A first-person assertion is the operator telling us about himself, so a
  // correction shaped this way belongs to memory rather than the web.
  /\bi (?:never|always|don'?t|do not|didn'?t|did not|use|used|prefer|like|hate|want|need|own|drive|run)\b/i,
  /\bdo you (?:know|recall)\b/i,
  /\bprefer(?:ence|ences|red|s)?\b/i,
  // Self-hosted infrastructure the operator is likely to be asking about.
  // Product names only — nothing here names a person or an installation.
  /\bopenclaw\b/i,
  /\bhomelab\b/i,
  /\bopnsense\b/i,
  /\bmikrotik\b/i,
  /\btruenas\b/i,
  /\bproxmox\b/i,
  // Personal dates and schedule.
  /\b(birthday|anniversary|my calendar|my schedule)\b/i,
  /\b(coursework|my classes|my degree)\b/i,
];

// ---------------------------------------------------------------------------
// Operator-specific vocabulary.
//
// The classifier needs to know which proper nouns belong to the operator's
// private world, because those route to memory rather than the web. That list
// is inherently personal, so it is supplied through config rather than
// committed here.
//
// Empty is a safe default. With no terms configured the classifier simply
// never treats a proper noun as personally owned, which under advisory routing
// costs a slightly worse suggestion and nothing more.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Agent-name templates.
//
// Several rules need the agent's own name inside them — "what model is <name>
// running on" is a question about live state, not about the outside world.
// The name is installation-specific, so those patterns are written against a
// sentinel and compiled when `configureAgentNames` runs.
//
// With no names configured the sentinel compiles to `(?!)`, which matches
// nothing. The second-person half of every rule still works, so an
// unconfigured install degrades to "you"/"your" rather than misfiring.
// ---------------------------------------------------------------------------

const AGENT_SENTINEL = "__agent__";

/** Alternation of configured agent names; never-matching when there are none. */
let agentAlternation = "(?!)";

function withAgent(re) {
  return new RegExp(re.source.replaceAll(AGENT_SENTINEL, agentAlternation), re.flags);
}

let personalPatterns = [];
let personalNouns = new Set();
let agentNouns = new Set();
let agentPatterns = [];

/**
 * Register the operator's own names, projects, hosts, and schedule vocabulary.
 *
 * Called once at plugin load from resolved config. Terms are matched
 * case-insensitively on word boundaries, and each is also treated as a
 * personally-owned proper noun so it cannot be mistaken for an external entity.
 *
 * @param {string[]} terms
 */
export function configurePersonalTerms(terms) {
  const clean = (Array.isArray(terms) ? terms : [])
    .map((t) => String(t ?? "").trim().toLowerCase())
    .filter(Boolean);
  personalNouns = new Set(clean.flatMap((t) => t.split(/\s+/)));
  personalPatterns = clean.map(
    (t) => new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"),
  );
}

/** Read back what is configured. Exported for tests and for describeFeatures. */
export function personalTermCount() {
  return personalPatterns.length;
}

/**
 * Self-referential questions that are really about runtime state.
 *
 * "What are you running on", "what did we change", "what's your current config"
 * are not character questions: the answer is stored operational state and it
 * changes, so it stays grounded. Checked ahead of every self-description rule
 * below, which is what keeps "who are you" direct without also making "what is
 * your current config" direct.
 *
 * CURRENT_INFO does not cover these. It looks for markers of the outside world
 * moving on — today, latest, news — and "your current status" carries none.
 */
/**
 * the agent's own Live Settings. These are answered from SOUL.md, which is injected
 * into every session, so they need no search at all.
 *
 * Two separate paths sent these to the web tier before this existed:
 *   - The setting names are capitalised ("your Humor setting"), so
 *     hasNamedExternalEntity() read "Humor" as a proper noun and classified the
 *     turn as a named external fact.
 *   - "what is your humor setting right now" matches CURRENT_INFO on
 *     "right now".
 * The observed result was a web_search on a question about the agent's own
 * configuration, an unrelated answer accepted as grounded, and a fail-closed
 * reply on a question the prompt could already answer. This check runs before
 * both, because neither can be right for this shape of question.
 */
/**
 * Short conversational reactions — acknowledgements, thanks, appreciation.
 *
 * These carry no external premise and can never be grounded by a search, so
 * routing one to a tier means it fails closed. Observed: "Good one" answered
 * with the fail-closed line, immediately after the agent told the joke that earned
 * it. Extending COMMON_WORDS fixes the proper-noun misread, but this branch
 * makes the class structurally safe regardless of vocabulary coverage.
 *
 * Bounded to five words. A longer turn that merely opens with "good" is a real
 * turn — "good, now check whether the backup ran" — and must classify normally.
 */
const ACKNOWLEDGEMENT_SHAPES = [
  /^(?:good|nice|great|cool|perfect|excellent|awesome|brilliant|lovely|sweet|neat|solid|clever|sharp|impressive)(?:\s+(?:one|job|work|stuff|call|point|answer))?[.!]*$/i,
  /^(?:ha|hah|haha|hahaha|heh|lol|lmao|hehe)[.!]*$/i,
  /^(?:thanks|thank you|ty|cheers|much appreciated|appreciated)[.!]*$/i,
  /^(?:ok|okay|k|right|sure|fine|got it|understood|noted|fair|fair enough|makes sense|true|agreed|exactly)[.!]*$/i,
  /^(?:yes|yeah|yep|yup|no|nope|nah)[.!]*$/i,
  /^that(?:'|’)?s\s+(?:funny|good|great|fair|true|helpful|better|right|it)[.!]*$/i,
  /^(?:well done|not bad|nicely done|good stuff|love it|wow)[.!]*$/i,
];

/** True for a brief conversational reaction with no external premise. */
export function isAcknowledgement(message) {
  const text = String(message ?? "").trim();
  if (!text) return false;
  if (text.split(/\s+/).length > 5) return false;
  return matchesAny(ACKNOWLEDGEMENT_SHAPES, text);
}

const SELF_SETTINGS_TERMS =
  /\b(?:humor|humour|honesty|verbosity|initiative|interruptibility|discretion|risk tolerance|trust|mode)\b/i;

const SELF_SETTINGS_SHAPES_TEMPLATE = [
  // "your humor setting", "__agent__'s verbosity level", "the honesty dial"
  /\b(?:your|__agent__'?s?|the)\s+(?:current\s+|live\s+)?[a-z]{4,16}\s*(?:setting|settings|level|cap|dial|percentage)\b/i,
  // "what are your settings", "report your settings"
  /\b(?:your|__agent__'?s?)\s+(?:current\s+|live\s+)?settings\b/i,
  // "set humor to 75", "dial humor up to 100", "change your humor setting"
  /\b(?:set|change|adjust|dial|turn|put|raise|lower|drop)\b[^?]{0,40}\b(?:humor|humour|honesty|verbosity|initiative|interruptibility|discretion)\b/i,
  // "can you change your humor setting to 100"
  /\b(?:humor|humour|honesty|verbosity|initiative|interruptibility)\s+(?:setting|level|cap)\b/i,
];
let SELF_SETTINGS_SHAPES = SELF_SETTINGS_SHAPES_TEMPLATE.map(withAgent);

/** True when the turn is about the agent's own Live Settings. */
export function isSelfSettingsQuestion(message) {
  const text = String(message ?? "").trim();
  if (!text) return false;
  if (!SELF_SUBJECT.test(text) && !SELF_SETTINGS_TERMS.test(text)) return false;
  return matchesAny(SELF_SETTINGS_SHAPES, text);
}

const SELF_STATE_SHAPES_TEMPLATE = [
  /\b(?:your|__agent__'?s?) (?:current |live )?(?:status|state|config|configuration|version|uptime|health|model|logs?|session|prompt|workspace)\b/i,
  /\bwhat (?:model|version) (?:are|is) (?:you|__agent__) (?:running|using|on)\b/i,
  /\bwhat(?:'s| is| are) (?:you|__agent__) (?:working on|running|doing)\b/i,
  /\bwhat (?:did|have) (?:we|you) (?:change|changed|set|configure|configured|update|updated|decide|decided)\b/i,
  /\bhow (?:are|is) (?:you|__agent__) configured\b/i,
];
let SELF_STATE_SHAPES = SELF_STATE_SHAPES_TEMPLATE.map(withAgent);

/**
 * the agent as a subject rather than as a store of the operator's context.
 *
 * The agent's own name used to sit in MEMORY_TERMS, which sent every mention of the agent's
 * own name to the memory tier. "What are you?" and "what are your settings?"
 * are then answered by searching the vault for the agent — and when that search
 * returns nothing usable, the turn fails closed on a question the injected
 * prompt files already answer completely.
 *
 * Kept as its own list so a non-question mention ("chat is broken") still
 * lands in memory, where the workspace context that would explain it lives.
 */
// Rebuilt by `configureAgentNames`; empty until an installation names its
// agent, which simply means a bare name mention carries no self signal.
let SELF_TERMS = [];

/** Second-person and self-naming subjects. Extended with the agent's names. */
let SELF_SUBJECT = /\b(?:you|your|yours|yourself)\b/i;

/**
 * Question frames whose subject is the agent itself.
 *
 * Deliberately shape-based rather than topic-based: identity, settings,
 * capability and design questions all arrive as an interrogative about "you"
 * or "the agent", and every one of them is answered from SOUL.md, IDENTITY.md and
 * AGENTS.md, which are already in context.
 */
const SELF_QUESTION_SHAPES_TEMPLATE = [
  /\b(?:who|what|which|how|why|when|where|whose)\b[^?]{0,80}\b(?:you|your|yours|yourself|__agent__)\b/i,
  /^\s*(?:are|is|was|were|do|does|did|can|could|will|would|have|has|should)\s+(?:you|__agent__)\b/i,
  /\btell me about (?:you|yourself|__agent__)\b/i,
  /\bwhat(?:'s| is| are)\s+your\b/i,
];
let SELF_QUESTION_SHAPES = SELF_QUESTION_SHAPES_TEMPLATE.map(withAgent);

/** Message shapes that are self-contained work, not external factual claims. */
const DIRECT_SHAPES = [
  // Creative production.
  /\b(write|compose|draft|invent|make up|come up with) (?:me )?(?:a|an|some)? ?(poem|story|haiku|song|limerick|joke|slogan|tagline|name|title)\b/i,
  // Transformations of text the user supplied.
  /\b(translate|rewrite|reword|rephrase|paraphrase|summari[sz]e|shorten|expand|reformat|convert|refactor|proofread|fix the grammar)\b/i,
  // Casual conversation.
  /^\s*(hi|hey|hello|yo|morning|good morning|good evening|thanks|thank you|thx|ok|okay|cool|nice|sup|howdy)\b/i,
  /\bhow are you\b/i,
  /\bare you (?:there|awake|around|up)\b/i,
];

/** Corrections stated as an explicit rejection. */
const CORRECTION_SHAPES = [
  /\b(?:that|this|it)(?:'s| is| was) (?:not right|wrong|incorrect|false|untrue|backwards)\b/i,
  /\byou(?:'re| are) wrong\b/i,
  /\byou got (?:that|it) wrong\b/i,
  /\bthat never happened\b/i,
  /\bnot (?:true|correct|right)\b/i,
  /^\s*(?:no|nope|wrong|incorrect)\b[\s,.!—-]/i,
  /^\s*actually\b[\s,]/i,
  /\bactually,? (?:it|he|she|they|that)\b/i,
  /\b(?:correction|i think you (?:mean|meant)|check (?:that|it) again)\b/i,
];

/**
 * Negations that turn a declarative into a factual counter-claim.
 *
 * Most real corrections never use the word "wrong". the operator rejects a premise by
 * asserting the opposite — "The wormhole never collapsed." — which the explicit
 * shapes above cannot see. Bare "not" is deliberately absent: "I'm not sure" is
 * not a correction.
 */
const NEGATION = /\b(?:never|didn'?t|did not|wasn'?t|was not|weren'?t|were not|isn'?t|is not|aren'?t|are not|doesn'?t|does not|hasn'?t|has not|hadn'?t|had not|no longer|not)\b/i;

/** A leading negation is an instruction ("do not deploy"), not a correction. */
const IMPERATIVE_NEGATION = /^\s*(?:do not|don'?t|never|no longer)\b/i;

/** Dismissals that use a negation without asserting a competing fact. */
const NON_CORRECTING_NEGATION = [
  /\b(?:doesn'?t|does not) matter\b/i,
  /\bno longer (?:needed|relevant|matters)\b/i,
  /\b(?:i'?m|i am|it'?s|its) not sure\b/i,
];

/**
 * A declarative counter-claim: no question mark, a negation that is not the
 * opening word, and at least one word of subject before it.
 */
export function isNegatedAssertion(message) {
  const text = String(message ?? "").trim();
  if (!text || text.includes("?")) return false;
  if (IMPERATIVE_NEGATION.test(text)) return false;
  if (NON_CORRECTING_NEGATION.some((re) => re.test(text))) return false;
  const hit = NEGATION.exec(text);
  if (!hit) return false;
  return text.slice(0, hit.index).trim().split(/\s+/).filter(Boolean).length >= 1;
}

/** Emotional-stance requests, which pair with a factual premise. */
const EMOTION_SHAPES = [
  /\bhow (?:do|did|does) (?:that|this|it) make you feel\b/i,
  /\bmake you feel\b/i,
  /\bhow (?:do|did) you feel\b/i,
  /\bwhat do you think (?:about|of)\b/i,
  /\b(?:your|any) (?:take|opinion|reaction|view)\b/i,
  /\bdoes (?:that|it) bother you\b/i,
];

/**
 * Leading bracketed metadata a transport prepends to the user's text.
 *
 * Native channels deliver turns like
 * `[Fri 2026-07-24 18:46 PDT] Hey the agent, what is 2 + 2?`. The timestamp block is
 * transport framing, not content, but because it sits at the start it defeated
 * every start-anchored rule below: the greeting/vocative strip never fired, so
 * `the agent` survived as a project term and a plain arithmetic question was
 * classified `memory`. That is the live acceptance failure.
 *
 * Bounded and leading-only, so a bracketed expression inside a message is
 * untouched.
 */
const CHANNEL_CONTEXT_PREFIX = /^\s*(?:\[[^\]\n]{0,160}\]\s*)+/;

/** Remove transport framing. Returns the original if stripping empties it. */
export function stripChannelContext(message) {
  const original = String(message ?? "");
  const stripped = original.replace(CHANNEL_CONTEXT_PREFIX, "");
  return stripped.trim() ? stripped : original;
}

/**
 * Conversational openers and vocatives, stripped after transport framing.
 *
 * "Hey the agent, what is 1 + 1?" is arithmetic, but the opener blocks the
 * arithmetic pattern (which anchors at the start) and the vocative "the agent" reads
 * as a project term. The agent name is only stripped when it is punctuated as
 * an address or follows a greeting, so "chat is broken" keeps its signal.
 */
const GREETING_PREFIX = /^\s*(?:(?:hey|hi|hello|yo|ok|okay|so|well|um|uh|please|good morning|good evening|good afternoon|morning|evening|afternoon)\b[\s,]+)+/i;
// Agent names the operator addresses directly. "Hey <name>, ..." is pure
// addressing and carries no content, so it is stripped before classification —
// otherwise a capitalised agent name reads as an external proper noun and
// routes the turn to a web search about its own name. Configured, because the
// names are installation-specific.
/** Matches nothing, so an unconfigured vocative strips nothing. */
const NEVER = /(?!)/;

let VOCATIVE_AFTER_GREETING = null;
let VOCATIVE_ADDRESS = null;
let VOCATIVE_TRAILING = null;

/**
 * Register the names this agent answers to, so being addressed by name is not
 * mistaken for a reference to something in the outside world.
 *
 * @param {string[]} names
 */
export function configureAgentNames(names) {
  const clean = (Array.isArray(names) ? names : [])
    .map((n) => String(n ?? "").trim().toLowerCase())
    .filter(Boolean)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  // An agent's own name is part of the operator's world, never an external
  // entity. Registering it here as well is what keeps a trailing vocative —
  // "what are you capable of, Atlas?" — from reading as a question about
  // something in the world that needs looking up.
  agentNouns = new Set(clean.flatMap((n) => n.split(/[\s-]+/)));
  // A mention of the agent that is not an address is a statement about the
  // operator's own installation, and SELF_TERMS below already routes it to the
  // workspace. It deliberately does NOT join the memory signal: the agent's
  // name sat in MEMORY_TERMS once, and it sent every mention of the agent —
  // including questions about the agent itself — off to look for evidence.
  agentPatterns = clean.map((n) => new RegExp(`\\b${n}\\b`, "i"));
  if (!clean.length) {
    VOCATIVE_AFTER_GREETING = null;
    VOCATIVE_ADDRESS = null;
    VOCATIVE_TRAILING = null;
    SELF_TERMS = [];
    SELF_SUBJECT = /\b(?:you|your|yours|yourself)\b/i;
    agentAlternation = "(?!)";
  SELF_SETTINGS_SHAPES = SELF_SETTINGS_SHAPES_TEMPLATE.map(withAgent);
  SELF_STATE_SHAPES = SELF_STATE_SHAPES_TEMPLATE.map(withAgent);
  SELF_QUESTION_SHAPES = SELF_QUESTION_SHAPES_TEMPLATE.map(withAgent);
    return;
  }
  const alt = clean.join("|");
  agentAlternation = `(?:${alt})`;
  // Being named is also a way of being addressed in the second person, so the
  // agent's own names join "you"/"your" as self-subjects. Without this, "what
  // should I know about Atlas?" is a question about the agent that the
  // self-reference check cannot see, and it goes looking for evidence.
  SELF_SETTINGS_SHAPES = SELF_SETTINGS_SHAPES_TEMPLATE.map(withAgent);
  SELF_STATE_SHAPES = SELF_STATE_SHAPES_TEMPLATE.map(withAgent);
  SELF_QUESTION_SHAPES = SELF_QUESTION_SHAPES_TEMPLATE.map(withAgent);
  SELF_TERMS = agentPatterns;
  SELF_SUBJECT = new RegExp(`\\b(?:you|your|yours|yourself|${alt})\\b`, "i");
  VOCATIVE_AFTER_GREETING = new RegExp(`^\\s*(?:${alt})\\b[\\s,]+`, "i");
  VOCATIVE_ADDRESS = new RegExp(`^\\s*(?:${alt})\\s*[,:]\\s*`, "i");
  // "…, Atlas?" is the same act of addressing as "Atlas, …", and leaving it in
  // place made a question about the agent itself read as a question about the
  // operator's installation. The comma is required: "what should I know about
  // Atlas?" is a question *about* the agent, not one addressed to it, and
  // stripping the name there would delete the subject. Terminal punctuation is
  // preserved so the sentence still parses as a question.
  VOCATIVE_TRAILING = new RegExp(`,\\s*(?:${alt})\\s*([?.!]*)\\s*$`, "i");
}

/**
 * Remove a leading greeting and/or vocative address. Returns the original text
 * when stripping would empty it, so a bare "hey" is still a greeting.
 */
export function stripVocative(message) {
  const original = String(message ?? "");
  let text = original;
  const hadGreeting = GREETING_PREFIX.test(text);
  if (hadGreeting) text = text.replace(GREETING_PREFIX, "");
  text = hadGreeting
    ? text.replace(VOCATIVE_AFTER_GREETING ?? NEVER, "")
    : text.replace(VOCATIVE_ADDRESS ?? NEVER, "");
  if (hadGreeting) text = text.replace(GREETING_PREFIX, "");
  text = text.replace(VOCATIVE_TRAILING ?? NEVER, "$1");
  return text.trim() ? text : original;
}

/**
 * Common English words that capitalize at the start of a sentence (or in title
 * case) without being proper nouns. Checked at every position, so it also stops
 * mid-sentence false positives. Missing a real name here fails toward "direct",
 * so the list stays limited to words that are almost never names in this
 * workspace's traffic.
 */
const COMMON_WORDS = new Set(
  (
    "a about actually add after again all also am an and any anyway are as at " +
    "be because been before being both build but by call can cannot check " +
    "amazing awesome bad better best brilliant cheers clever cool correct " +
    "excellent fair fine funny good great ha haha heh helpful hey hi huh " +
    "impressive interesting k lol lovely nah neat nice nope not ok one " +
    "perfect please really right sharp smart solid sure sweet thank thanks " +
    "true understood wow yeah yep yes " +
    "close compare compute confirm consider could count create define delete " +
    "describe did do does doing done double draft draw during each either " +
    "enable ensure every explain export few find fix for from generate get " +
    "give had has have having he help her here hers him his how however i if " +
    "imagine import in install is it its just keep last less let list load log " +
    "look make many map may maybe me merge might more most move much must my " +
    "name need neither next no nope not now of ok okay on only open or " +
    "otherwise ought our ours pick please plan pull push put read remind " +
    "remove reset restart restore review rewrite run save search send set " +
    "shall she should show since so solve some sorry sort split start still " +
    "stop suggest sure summarize tell test thanks that the their theirs them " +
    "then there these they think this those to track translate try until " +
    "update us use verify walk want was we were what when where whether which " +
    "while who whom whose why will with would write yep yes you your yours"
  ).split(" "),
);

/**
 * Proper nouns that belong to the operator's own context, not the outside
 * world. Built-ins are product names only; `configurePersonalTerms` adds the
 * installation-specific ones.
 */
const BUILTIN_PERSONAL_NOUNS = new Set([
  "openclaw", "opnsense", "mikrotik", "truenas", "proxmox",
]);

function isPersonalNoun(lower) {
  return BUILTIN_PERSONAL_NOUNS.has(lower) || personalNouns.has(lower) || agentNouns.has(lower);
}

/**
 * Ordinary nouns that appear in subject position without naming anything
 * external. Used only by the lowercase detector below, so it cannot weaken
 * capitalized proper-noun detection.
 */
const ORDINARY_NOUNS = new Set(
  (
    "agent answer bug build cache change chart code commit config console " +
    "dashboard data database deploy diff doc docs endpoint error file files " +
    "function issue job link log logs message model module note number output " +
    "package page panel patch path plan process prompt query queue report repo " +
    "request response result route schema script server service session setting " +
    "settings site step table task team thing time tool tools value vault " +
    "version view workspace"
  ).split(" "),
);

/**
 * Interrogative frames whose subject is a third party. First- and second-person
 * subjects are excluded so "how do I fix this" stays direct.
 */
const EXTERNAL_QUESTION_FRAME =
  /\b(?:who|what|when|where|how|why|whose)\s+(?:did|does|do|is|was|are|were|has|have|had)\s+(?:the\s+|a\s+|an\s+)?([a-z][\w'-]{2,})/gi;

/** "…from lord of the rings" — the work or source a claim belongs to. */
const EXTERNAL_SOURCE_REFERENCE = /\bfrom\s+(?:the\s+)?([a-z][\w'-]{3,})\b/gi;

const FIRST_OR_SECOND_PERSON = new Set([
  "i", "you", "we", "us", "me", "my", "our", "your", "yours", "mine", "ours",
]);

/**
 * Lowercase counterpart to `hasNamedExternalEntity`.
 *
 * Real questions are rarely capitalized — "how did romily die from
 * lord of the rings" names an external person and an external work with no capital
 * letter anywhere. This finds a content word in subject position after an
 * interrogative frame, or the source a claim is attributed to, and treats a
 * word that is neither ordinary English nor ours as an external referent.
 */
export function hasLowercaseExternalReference(message) {
  const text = stripCode(String(message ?? "")).replace(/"[^"]*"/g, " ");
  const unknown = (word) => {
    const lower = String(word ?? "").toLowerCase().replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
    if (lower.length < 3) return false;
    if (FIRST_OR_SECOND_PERSON.has(lower)) return false;
    if (COMMON_WORDS.has(lower)) return false;
    if (ORDINARY_NOUNS.has(lower)) return false;
    if (isPersonalNoun(lower)) return false;
    return true;
  };

  for (const re of [EXTERNAL_QUESTION_FRAME, EXTERNAL_SOURCE_REFERENCE]) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (unknown(m[1])) return true;
    }
  }
  return false;
}

/**
 * Pure arithmetic, with or without a natural-language wrapper.
 *
 * The verb alternation is written as a two-branch alternation rather than the
 * shorter optional-suffix form. Both match the same two words, but the short
 * form leaves the four letters of the dynamic-execution builtin immediately
 * followed by an open parenthesis in the source. OpenClaw's install scanner
 * matches that sequence line by line, in comments as much as in code, and
 * blocks `plugins install` on it as a critical finding
 * (`dist/scanner-CCQg3MsL.js:61-79`). Longest branch first, so "evaluate" is
 * not left with a trailing "uate". `npm run build` enforces this.
 */
const ARITHMETIC =
  /^\s*(?:what(?:'s| is)\s+|calculate\s+|compute\s+|solve\s+|(?:evaluate|eval)\s+)?[-+]?[\d\s+\-*/^%().,]+\s*\??\s*$/i;

function hasDigitAndOperator(text) {
  return /\d/.test(text) && /[+\-*/^%]/.test(text);
}

function matchesAny(patterns, text) {
  return patterns.some((re) => re.test(text));
}

/**
 * Strip fenced code blocks and inline code before proper-noun detection.
 * Capitalized identifiers inside code are not external facts.
 */
function stripCode(text) {
  return text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ");
}

/**
 * Best-effort detection of a named external person, work, event, product, or
 * place. Conservative in one direction only: when it is unsure it says "named",
 * because an unnecessary web_search costs a search while a wrong unverified
 * claim costs trust.
 */
export function hasNamedExternalEntity(message) {
  const raw = String(message ?? "");
  // A quoted title is a named work.
  if (/"[^"]{2,}"/.test(raw)) return true;
  const text = stripCode(raw).replace(/"[^"]*"/g, " ");
  // A four-digit year in a factual question is an external event marker.
  if (/\b(?:1[89]\d{2}|20\d{2})\b/.test(text)) return true;

  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    const words = sentence.trim().split(/\s+/);
    for (const word of words) {
      const token = word.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
      if (token.length < 2) continue;
      if (!/^\p{Lu}/u.test(token)) continue;
      const lower = token.toLowerCase();
      if (COMMON_WORDS.has(lower)) continue;
      // Contractions and possessives, checked against the base word.
      //
      // The strip above only removes non-letters from the ENDS of a token, so
      // an internal apostrophe survives and "There's" is looked up as
      // "there's" — absent from COMMON_WORDS even though "there" is present.
      // Every capitalised contraction therefore read as a proper noun.
      //
      // Observed: "There's a runaway trolley going down the tracks" was
      // classified as a named external fact, which forced a web search on a
      // joke and produced an encyclopedia entry about Philippa Foot.
      //
      // Normalising the token fixes the whole class at once. Two earlier
      // attempts at this bug added vocabulary instead, which only ever fixed
      // the words that had already failed.
      const base = lower.replace(/['’](?:s|re|ve|ll|d|m|t)$/u, "").replace(/['’]/gu, "");
      if (base !== lower && COMMON_WORDS.has(base)) continue;
      if (isPersonalNoun(lower)) continue;
      // Short all-caps tokens are acronyms/units, not reliable name evidence.
      if (token.length <= 3 && token === token.toUpperCase()) continue;
      return true;
    }
  }
  return false;
}

/**
 * Marker the console wraps around the operator's actual message.
 *
 * `before_prompt_build` receives the whole composed prompt, and the console
 * prepends mode permissions, a continuity bridge, attachments, and an approved
 * plan. Classifying that composite would ground almost every turn — "2 + 2"
 * would arrive alongside the words "search", "memory", and "the console".
 * The nonce is generated per turn, so user text cannot forge or truncate it.
 */
const USER_TURN_RE = /\[user-message:([0-9a-f]{6,32})\]\n([\s\S]*?)\n\[\/user-message:\1\]/g;

/**
 * Return the operator's turn from a composed prompt. Native OpenClaw channels
 * send the bare message and carry no markers, so the prompt is returned as-is.
 *
 * @param {string} prompt
 * @returns {string}
 */
export function extractUserTurn(prompt) {
  const text = String(prompt ?? "");
  let last = null;
  USER_TURN_RE.lastIndex = 0;
  for (let m = USER_TURN_RE.exec(text); m; m = USER_TURN_RE.exec(text)) last = m[2];
  return last ?? text;
}

/**
 * The per-turn nonce the console wraps around the operator's message.
 *
 * This is the only value in the run that is unique to one the console turn.
 * The OpenClaw CLI derives its run id from the session id when no `--run-id` is
 * passed (and `openclaw agent` exposes no such flag), so every turn in a chat
 * session shares one run id and one session id. Recording the nonce in the
 * evidence record is what lets the console bind a record to the exact turn
 * it is about to release, rather than to any turn in the session.
 *
 * Returns null for native channels, which carry no marker.
 *
 * @param {string} prompt
 * @returns {string|null}
 */
export function extractTurnNonce(prompt) {
  const text = String(prompt ?? "");
  let last = null;
  USER_TURN_RE.lastIndex = 0;
  for (let m = USER_TURN_RE.exec(text); m; m = USER_TURN_RE.exec(text)) last = m[1];
  return last;
}

/**
 * The most recent assistant text in a run's prepared session messages.
 *
 * This is the claim a contextual correction is correcting — "It's an TC20."
 * means nothing without it. Assistant content arrives as an array of typed
 * parts; a bare string is accepted too, because not every harness normalizes.
 * Anything unreadable yields "", which makes a correction ineligible rather
 * than guessed at.
 *
 * @param {unknown[]} messages
 * @returns {string}
 */
export function lastAssistantText(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || typeof message !== "object" || message.role !== "assistant") continue;
    const content = message.content;
    if (typeof content === "string" && content.trim()) return content.trim();
    if (Array.isArray(content)) {
      const text = content
        .filter((part) => part && typeof part === "object" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n")
        .trim();
      if (text) return text;
    }
  }
  return "";
}

/**
 * A non-current question about the agent itself.
 *
 * Answered from the prompt files that are already in context, so it needs no
 * store and no search. Two exclusions keep it honest: anything with a
 * current-information marker ("is the gateway still running", "what did you
 * just deploy") is a live-state question and stays grounded, and anything that
 * names an external entity ("are you sure Romily died first") is a factual
 * claim wearing a second-person opener.
 *
 * @param {string} message
 * @returns {boolean}
 */
export function isSelfReferenceQuestion(message) {
  const text = String(message ?? "").trim();
  if (!text) return false;
  if (!SELF_SUBJECT.test(text)) return false;
  if (matchesAny(CURRENT_INFO, text)) return false;
  // Runtime state, configuration, history and project state are stored facts,
  // not character. They stay grounded even though the subject is the agent.
  if (matchesAny(SELF_STATE_SHAPES, text)) return false;
  if (hasNamedExternalEntity(text) || hasLowercaseExternalReference(text)) return false;
  return matchesAny(SELF_QUESTION_SHAPES, text);
}

/**
 * Classify one user turn.
 *
 * @param {string} message raw user text for this turn
 * @param {{prevAssistant?: string, contextualCorrection?: boolean}} [context]
 * @returns {{kind: "web"|"memory"|null, correction: boolean, reason: string}}
 */
export function classifyGrounding(message, context = {}) {
  const raw = String(message ?? "");
  if (!raw.trim()) return { kind: null, correction: false, reason: "empty" };
  // Transport framing, then openers and vocatives: all addressing, none of it
  // content. Stripped first, and in that order, so neither can block the
  // arithmetic anchor or masquerade as a project term.
  const trimmed = stripVocative(stripChannelContext(raw)).trim();
  if (!trimmed) return { kind: null, correction: false, reason: "empty" };

  // `context.contextualCorrection` is supplied by the caller that already has
  // the previous turn — the plugin's fact detector. A bare "It's an TC20." holds
  // no correction vocabulary and no negation, so the shapes below cannot see
  // it; without this signal it read as a named external fact and demanded a
  // web_search to re-ground a fact about the operator's own car. One-argument callers
  // (the console's mirror) are unaffected.
  const correction =
    matchesAny(CORRECTION_SHAPES, trimmed) ||
    isNegatedAssertion(trimmed) ||
    context?.contextualCorrection === true;
  const personal = matchesAny(MEMORY_TERMS, trimmed) || matchesAny(personalPatterns, trimmed);

  // A correction always re-grounds. Route it to whichever store owns the claim.
  //
  // A contextual correction carries almost no words of its own — "It's an TC20."
  // names nothing personal, so on the message alone it fell to the web tier and
  // demanded a web_search to re-ground a fact about the operator's own car. The claim
  // being corrected is the one that decides ownership, so when the correction
  // itself is silent, the preceding assistant answer is consulted. This is the
  // only place the previous turn influences classification, and it can only
  // move a correction from `web` to `memory` — never the reverse, and never a
  // non-correction.
  if (correction) {
    if (personal) return { kind: "memory", correction: true, reason: "correction-personal" };
    const prior = String(context?.prevAssistant ?? "");
    if (prior.trim() && (matchesAny(MEMORY_TERMS, prior) || matchesAny(personalPatterns, prior))) {
      return { kind: "memory", correction: true, reason: "correction-personal-context" };
    }
    return { kind: "web", correction: true, reason: "correction-external" };
  }

  // Pure arithmetic is self-contained; nothing outranks it.
  if (ARITHMETIC.test(trimmed) && hasDigitAndOperator(trimmed)) {
    return { kind: null, correction: false, reason: "arithmetic" };
  }

  // A reaction to what the agent just said has no premise to ground.
  if (isAcknowledgement(trimmed)) {
    return { kind: null, correction: false, reason: "acknowledgement" };
  }

  // Before CURRENT_INFO and before named-entity detection: both misread these.
  if (isSelfSettingsQuestion(trimmed)) {
    return { kind: null, correction: false, reason: "self-settings" };
  }

  if (matchesAny(CURRENT_INFO, trimmed)) {
    return { kind: "web", correction: false, reason: "current-information" };
  }

  if (personal) {
    return { kind: "memory", correction: false, reason: "personal-or-project" };
  }

  // the agent's own runtime state, configuration, and history are stored facts. The
  // subject is the agent, but the answer is not in the injected prompt files, so
  // these stay grounded rather than being answered from an assumption.
  if (matchesAny(SELF_STATE_SHAPES, trimmed)) {
    return { kind: "memory", correction: false, reason: "self-state" };
  }

  // the agent as the subject. A question about who or what the agent is, what it can do,
  // or how it is set is answered by the files already in context, so it is
  // direct and must not spend a search. Anything else that merely mentions the
  // name — "chat is broken" — is still workspace context.
  if (isSelfReferenceQuestion(trimmed)) {
    return { kind: null, correction: false, reason: "self-reference" };
  }
  if (matchesAny(SELF_TERMS, trimmed)) {
    return { kind: "memory", correction: false, reason: "personal-or-project" };
  }

  // Creative, transformational, and casual turns have no external premise, so
  // they suppress name detection — but only after current/personal precedence.
  const directShape = matchesAny(DIRECT_SHAPES, trimmed);

  if (!directShape && (hasNamedExternalEntity(trimmed) || hasLowercaseExternalReference(trimmed))) {
    const reason = matchesAny(EMOTION_SHAPES, trimmed)
      ? "named-external-fact-with-emotion"
      : "named-external-fact";
    return { kind: "web", correction: false, reason };
  }

  return {
    kind: null,
    correction: false,
    reason: directShape ? "direct-shape" : "no-external-premise",
  };
}

/**
 * Report which signals a turn trips, without deciding anything.
 *
 * Phase 0 telemetry records this alongside the verdict so old traffic can be
 * re-scored when a rule changes. A verdict alone is not enough: "web" tells you
 * the outcome but not whether CURRENT_INFO or the proper-noun heuristic caused
 * it, so a later edit to one of them cannot be evaluated against past turns.
 *
 * Deliberately read-only and deliberately not consulted by classifyGrounding.
 * If this function ever influences a decision it stops being an instrument and
 * becomes another rule to maintain.
 */
export function describeFeatures(message) {
  const raw = String(message ?? "");
  const trimmed = stripVocative(stripChannelContext(raw)).trim();
  if (!trimmed) return {};
  const safe = (fn) => {
    try {
      return Boolean(fn());
    } catch {
      return false;
    }
  };
  return {
    words: trimmed.split(/\s+/).filter(Boolean).length,
    currentInfo: safe(() => matchesAny(CURRENT_INFO, trimmed)),
    memoryTerms: safe(() => matchesAny(MEMORY_TERMS, trimmed)),
    personalTerms: safe(() => matchesAny(personalPatterns, trimmed)),
    acknowledgement: safe(() => isAcknowledgement(trimmed)),
    selfSettings: safe(() => isSelfSettingsQuestion(trimmed)),
    selfState: safe(() => matchesAny(SELF_STATE_SHAPES, trimmed)),
    selfReference: safe(() => isSelfReferenceQuestion(trimmed)),
    selfTerms: safe(() => matchesAny(SELF_TERMS, trimmed)),
    directShape: safe(() => matchesAny(DIRECT_SHAPES, trimmed)),
    correctionShape: safe(() => matchesAny(CORRECTION_SHAPES, trimmed)),
    emotionShape: safe(() => matchesAny(EMOTION_SHAPES, trimmed)),
    namedEntity: safe(() => hasNamedExternalEntity(trimmed)),
    lowercaseExternal: safe(() => hasLowercaseExternalReference(trimmed)),
    arithmetic: safe(() => ARITHMETIC.test(trimmed) && hasDigitAndOperator(trimmed)),
  };
}

/** Tool names that satisfy each grounding kind. */
export const SATISFYING_TOOLS = {
  web: ["web_search"],
  memory: ["memory_search", "wiki_search"],
};

/**
 * The exact fail-closed reply. Never reword: acceptance asserts it verbatim.
 *
 * Deliberately short and plain. This is the most frequently seen line the
 * assistant produces, so it sets the register more than any other single
 * string. Process vocabulary ("verify", "invent", "the missing piece") reads
 * as a compliance notice rather than as the agent, and at seven words this matches
 * the length a terse agent actually speaks at.
 */
export const FAIL_CLOSED_TEXT =
  "I couldn't confirm that. I won't guess.";
