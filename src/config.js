// Plugin config: defaults, the JSON Schema, and a dependency-free validator.
//
// The same schema object is written into `openclaw.plugin.json`, which OpenClaw
// reads before it loads any plugin code. `tests/manifest.test.mjs` asserts the
// two stay identical, so there is one source of truth in practice.

import path from "node:path";

import { DEFAULT_EVIDENCE_DIR } from "./evidence.js";
import { varDir, workspaceDir } from "./paths.js";

export const DEFAULTS = Object.freeze({
  // The agents this contract governs. An empty array means every agent;
  // these defaults match the common layout of a primary agent plus a
  // conversational one, and are meant to be overridden.
  enabledAgents: ["main", "chat"],
  evidenceDir: DEFAULT_EVIDENCE_DIR,
  maxRevisions: 1,
  stateTtlSeconds: 600,
  maxTrackedTurns: 200,
  // WP-2026-004 — the guarded fact transaction. Off by default: a plugin that
  // silently gained vault-write reach on upgrade would be exactly the wrong
  // failure mode, so it takes a deliberate operator opt-in.
  factsEnabled: false,
  factsAgents: ["main", "chat"],
  // Both are deployment-specific and have no sensible default. The fact
  // transaction stays disabled until an operator supplies them; see
  // docs/CONFIGURATION.md for the CLI contract they must satisfy.
  vaultPath: "",
  factsCliPath: "",
  // Voice gate. maxVoiceRevisions 0 disables it entirely.
  // Phase 0 telemetry. Bounded retention on the house rule that nothing grows
  // without a limit; days rather than bytes because the corpus is only useful
  // while it reflects current code.
  // Names the behaviour regime a record belongs to. Bump on every
  // deliberate behaviour change so analysis can segment by epoch instead of
  // requiring a development freeze.
  behaviorEpoch: "v1.11.0-advisory",
  telemetryDir: path.join(varDir(), "telemetry"),
  telemetryRetentionDays: 30,
  maxVoiceRevisions: 1,
  voiceMaxWords: 90,
  pythonPath: "python3",
  caseTimeoutMs: 20000,
  factTimeoutMs: 20000,
  maxEvidenceItems: 4,
  maxEvidenceChars: 1200,
  maxFactRevisions: 1,
  // Explicit session-key prefixes that count as a direct owner conversation.
  // A front-end console and one-shot CLI runs pass an explicit session
  // key that OpenClaw does not normalize into `agent:<id>:main…`, so they are
  // recognized by prefix instead. Group and channel keys are refused
  // structurally and cannot be allowed from here.
  directSessionPrefixes: [],
  // Installation-specific vocabulary. Empty by default: this plugin ships with
  // nobody's private world baked in, and an empty list is safe — the classifier
  // simply never treats a proper noun as personally owned, which under advisory
  // routing costs a slightly worse suggestion and nothing else.
  personalTerms: [],
  agentNames: [],
  // Prompt surfaces to hash into each telemetry record's `promptHash`. A
  // wording change here alters behaviour without touching code, so a corpus
  // that cannot see it will eventually be used to justify a wrong conclusion.
  //
  // Contents are never read into a record — only a hash. The defaults are
  // OpenClaw's workspace files; point this at your own prompt sources on any
  // other host. Files that do not exist hash as "absent", so a wrong path
  // degrades to a constant rather than an error.
  promptFiles: ["SOUL.md", "AGENTS.md"].map((f) => path.join(workspaceDir(), f)),
});

// There is deliberately no `failClosedText` option. The injected requirement,
// the revision instruction, and the delivery substitution must all be the same
// sentence, and acceptance asserts it verbatim — a config knob would let those
// three drift apart and would be a way to weaken the contract from config.

export const CONFIG_JSON_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    enabledAgents: {
      type: "array",
      items: { type: "string", minLength: 1 },
      description: "Agent ids this contract applies to. Empty array means every agent.",
    },
    evidenceDir: {
      type: "string",
      minLength: 1,
      description: "Directory for per-session grounding evidence records.",
    },
    maxRevisions: {
      type: "integer",
      minimum: 0,
      maximum: 2,
      description: "Bounded extra model passes requested when grounding is missing.",
    },
    stateTtlSeconds: {
      type: "integer",
      minimum: 30,
      maximum: 3600,
      description: "How long per-turn grounding state is retained.",
    },
    maxTrackedTurns: {
      type: "integer",
      minimum: 10,
      maximum: 2000,
      description: "Upper bound on concurrently tracked turns.",
    },
    factsEnabled: {
      type: "boolean",
      description: "Register the guarded vault_fact_commit tool. Off unless explicitly enabled.",
    },
    factsAgents: {
      type: "array",
      items: { type: "string", minLength: 1 },
      description: "Agent ids allowed to use vault_fact_commit. Empty array means no agent.",
    },
    vaultPath: {
      type: "string",
      minLength: 1,
      description: "Vault root passed to the Vault Tools writer. Never model-supplied.",
    },
    factsCliPath: {
      type: "string",
      minLength: 1,
      description: "Absolute path to the Vault Tools fact transaction entry point.",
    },
    pythonPath: {
      type: "string",
      minLength: 1,
      description: "Interpreter used to run the Vault Tools writer.",
    },
    caseTimeoutMs: {
      type: "integer",
      minimum: 1000,
      maximum: 120000,
      description: "Budget for the isolated CASE audit completion.",
    },
    factTimeoutMs: {
      type: "integer",
      minimum: 1000,
      maximum: 120000,
      description: "Budget for the Vault Tools fact transaction.",
    },
    maxEvidenceItems: {
      type: "integer",
      minimum: 1,
      maximum: 10,
      description: "How many successful wiki retrievals are bound into the audit packet.",
    },
    maxEvidenceChars: {
      type: "integer",
      minimum: 200,
      maximum: 8000,
      description: "Per-excerpt character bound for bound vault evidence.",
    },
    maxFactRevisions: {
      type: "integer",
      minimum: 0,
      maximum: 1,
      description: "Bounded extra model passes when an eligible turn skipped the fact tool.",
    },
    maxVoiceRevisions: {
      type: "integer",
      minimum: 0,
      maximum: 2,
      description:
        "Bounded extra passes requested when a reply violates the voice rules. 0 disables the voice gate.",
    },
    voiceMaxWords: {
      type: "integer",
      minimum: 20,
      maximum: 400,
      description:
        "Word count above which a reply is treated as long. Targets the tail, not the median.",
    },
    behaviorEpoch: {
      type: "string",
      minLength: 1,
      description:
        "Label for the behaviour regime that produced a record. Bump on every deliberate behaviour change.",
    },
    telemetryDir: {
      type: "string",
      minLength: 1,
      description:
        "Directory for per-turn telemetry (JSONL, one file per day). Empty disables logging.",
    },
    telemetryRetentionDays: {
      type: "integer",
      minimum: 1,
      maximum: 365,
      description: "Days of turn telemetry retained. Day files older than this are pruned.",
    },
    directSessionPrefixes: {
      type: "array",
      items: { type: "string", minLength: 1 },
      description:
        "Explicit session-key prefixes treated as a direct owner conversation. Group and channel keys are refused structurally and cannot be allowed here.",
    },
    personalTerms: {
      type: "array",
      items: { type: "string", minLength: 2 },
      description:
        "Names, projects, hosts and schedule vocabulary belonging to the operator. Matched case-insensitively on word boundaries; questions containing one route to memory rather than the web, and the words are never mistaken for external proper nouns.",
    },
    agentNames: {
      type: "array",
      items: { type: "string", minLength: 2 },
      description:
        "Names this agent answers to. Being addressed by name is stripped before classification, so a capitalised agent name is not read as a reference to the outside world.",
    },
    promptFiles: {
      type: "array",
      items: { type: "string", minLength: 1 },
      description:
        "Absolute paths to the prompt surfaces hashed into each telemetry record. Contents are never copied into a record. Missing files hash as absent.",
    },
  },
});

function issue(message) {
  return { success: false, error: { issues: [{ path: [], message }] } };
}

/** Validate and normalize plugin config without pulling in the SDK. */
export function parseConfig(value) {
  if (value === undefined || value === null) return { success: true, data: { ...DEFAULTS } };
  if (typeof value !== "object" || Array.isArray(value)) return issue("expected config object");

  const out = { ...DEFAULTS };
  for (const [key, raw] of Object.entries(value)) {
    if (!(key in DEFAULTS)) return issue(`unknown config key: ${key}`);
    switch (key) {
      case "enabledAgents": {
        if (!Array.isArray(raw) || raw.some((x) => typeof x !== "string" || !x)) {
          return issue("enabledAgents must be an array of non-empty strings");
        }
        out.enabledAgents = [...raw];
        break;
      }
      case "evidenceDir": {
        if (typeof raw !== "string" || !raw) return issue("evidenceDir must be a non-empty string");
        out.evidenceDir = raw;
        break;
      }
      case "maxRevisions":
        if (!Number.isInteger(raw) || raw < 0 || raw > 2) return issue("maxRevisions must be 0..2");
        out.maxRevisions = raw;
        break;
      case "stateTtlSeconds":
        if (!Number.isInteger(raw) || raw < 30 || raw > 3600) {
          return issue("stateTtlSeconds must be 30..3600");
        }
        out.stateTtlSeconds = raw;
        break;
      case "maxTrackedTurns":
        if (!Number.isInteger(raw) || raw < 10 || raw > 2000) {
          return issue("maxTrackedTurns must be 10..2000");
        }
        out.maxTrackedTurns = raw;
        break;
      case "factsEnabled":
        if (typeof raw !== "boolean") return issue("factsEnabled must be a boolean");
        out.factsEnabled = raw;
        break;
      case "factsAgents": {
        if (!Array.isArray(raw) || raw.some((x) => typeof x !== "string" || !x)) {
          return issue("factsAgents must be an array of non-empty strings");
        }
        out.factsAgents = [...raw];
        break;
      }
      case "vaultPath":
      case "factsCliPath":
      case "pythonPath": {
        if (typeof raw !== "string" || !raw) return issue(`${key} must be a non-empty string`);
        // These become argv entries for the writer subprocess. They are
        // operator config, but requiring an absolute path for the two that name
        // a location removes a whole class of surprise about what got started.
        if (key !== "pythonPath" && !raw.startsWith("/")) {
          return issue(`${key} must be an absolute path`);
        }
        out[key] = raw;
        break;
      }
      case "caseTimeoutMs":
      case "factTimeoutMs":
        if (!Number.isInteger(raw) || raw < 1000 || raw > 120000) {
          return issue(`${key} must be 1000..120000`);
        }
        out[key] = raw;
        break;
      case "maxEvidenceItems":
        if (!Number.isInteger(raw) || raw < 1 || raw > 10) return issue("maxEvidenceItems must be 1..10");
        out.maxEvidenceItems = raw;
        break;
      case "maxEvidenceChars":
        if (!Number.isInteger(raw) || raw < 200 || raw > 8000) {
          return issue("maxEvidenceChars must be 200..8000");
        }
        out.maxEvidenceChars = raw;
        break;
      case "maxVoiceRevisions":
        if (!Number.isInteger(raw) || raw < 0 || raw > 2)
          return issue("maxVoiceRevisions must be 0..2");
        out.maxVoiceRevisions = raw;
        break;
      case "voiceMaxWords":
        if (!Number.isInteger(raw) || raw < 20 || raw > 400)
          return issue("voiceMaxWords must be 20..400");
        out.voiceMaxWords = raw;
        break;
      case "behaviorEpoch":
        if (typeof raw !== "string" || !raw.trim()) return issue("behaviorEpoch must be a label");
        out.behaviorEpoch = raw.trim();
        break;
      case "telemetryDir":
        if (typeof raw !== "string" || !raw.trim()) return issue("telemetryDir must be a path");
        out.telemetryDir = raw.trim();
        break;
      case "telemetryRetentionDays":
        if (!Number.isInteger(raw) || raw < 1 || raw > 365)
          return issue("telemetryRetentionDays must be 1..365");
        out.telemetryRetentionDays = raw;
        break;
      case "maxFactRevisions":
        if (!Number.isInteger(raw) || raw < 0 || raw > 1) return issue("maxFactRevisions must be 0..1");
        out.maxFactRevisions = raw;
        break;
      case "directSessionPrefixes": {
        if (!Array.isArray(raw) || raw.some((x) => typeof x !== "string" || !x)) {
          return issue("directSessionPrefixes must be an array of non-empty strings");
        }
        // A prefix that would readmit a shared conversation defeats the point
        // of the check it feeds, so it is rejected at config load rather than
        // silently honoured at runtime.
        if (raw.some((x) => x.includes(":group:") || x.includes(":channel:"))) {
          return issue("directSessionPrefixes must not match group or channel sessions");
        }
        out.directSessionPrefixes = [...raw];
        break;
      }
      case "promptFiles": {
        if (!Array.isArray(raw) || raw.some((x) => typeof x !== "string" || !x)) {
          return issue("promptFiles must be an array of non-empty paths");
        }
        out.promptFiles = [...raw];
        break;
      }
      case "personalTerms":
      case "agentNames": {
        if (!Array.isArray(raw) || raw.some((x) => typeof x !== "string" || x.trim().length < 2)) {
          return issue(`${key} must be an array of strings, each at least 2 characters`);
        }
        // Each term becomes a regex. Refuse metacharacters rather than escaping
        // them silently: a term that needs escaping is a mistake in config, and
        // accepting it would let a stray "(" change what the classifier matches.
        if (raw.some((x) => /[.*+?^${}()|[\]\\]/.test(x))) {
          return issue(`${key} entries must be plain words, without regex metacharacters`);
        }
        out[key] = raw.map((x) => x.trim());
        break;
      }
      default:
        return issue(`unhandled config key: ${key}`);
    }
  }
  return { success: true, data: out };
}

/** Runtime config-schema object in the shape OpenClaw's plugin loader expects. */
export const configSchema = Object.freeze({
  safeParse: parseConfig,
  jsonSchema: CONFIG_JSON_SCHEMA,
});

/** Whether the contract applies to this agent. */
export function appliesToAgent(cfg, agentId) {
  const list = cfg?.enabledAgents ?? DEFAULTS.enabledAgents;
  if (!Array.isArray(list) || list.length === 0) return true;
  return typeof agentId === "string" && list.includes(agentId);
}

/**
 * Whether this agent may run a fact transaction.
 *
 * Unlike `enabledAgents`, an empty `factsAgents` means *no* agent rather than
 * every agent. Vault-write reach is the one place where a permissive reading of
 * an empty list would be indefensible.
 */
export function factsApplyToAgent(cfg, agentId) {
  if (!cfg?.factsEnabled) return false;
  const list = cfg?.factsAgents ?? DEFAULTS.factsAgents;
  if (!Array.isArray(list) || list.length === 0) return false;
  return typeof agentId === "string" && list.includes(agentId);
}
