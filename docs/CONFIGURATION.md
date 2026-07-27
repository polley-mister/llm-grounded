# Configuration

All keys live under `plugins.entries.llm-grounded.config` in
`openclaw.json`. The schema is `additionalProperties: false` and validation is
strict: an unknown key, or a value outside its range, fails config load rather
than being ignored.

That strictness is deliberate. A silently-dropped key is how you end up
believing a gate is disabled when it is not.

## Keys

| Key | Range | Default | Meaning |
|---|---|---|---|
| `enabledAgents` | array | `["main","chat"]` | Agent ids this contract applies to. Empty array means every agent. |
| `agentNames` | array | `[]` | Names this agent answers to. Being addressed by name is stripped before classification, so a capitalised agent name is not read as a reference to the outside world. |
| `personalTerms` | array | `[]` | Names, projects, hosts and schedule vocabulary belonging to the operator. Matched case-insensitively on word boundaries; questions containing one route to memory rather than the web, and the words are never mistaken for external proper nouns. |
| `maxRevisions` | 0..2 | `1` | Bounded extra model passes requested when grounding is missing. |
| `stateTtlSeconds` | 30..3600 | `600` | How long per-turn grounding state is retained. |
| `maxTrackedTurns` | 10..2000 | `200` | Upper bound on concurrently tracked turns. |
| `evidenceDir` | string | `$OPENCLAW_HOME/var/llm-grounded/evidence` | Directory for per-session grounding evidence records. |
| `maxEvidenceItems` | 1..10 | `4` | How many successful retrievals are bound into the audit packet. |
| `maxEvidenceChars` | 200..8000 | `1200` | Per-excerpt character bound for bound evidence. |
| `maxVoiceRevisions` | 0..2 | `1` | Bounded extra passes when a reply violates the voice rules. **0 disables the voice gate.** |
| `voiceMaxWords` | 20..400 | `90` | Word count above which a reply is treated as long. Targets the tail, not the median. |
| `telemetryDir` | string | `$OPENCLAW_HOME/var/llm-grounded/telemetry` | Per-turn telemetry, JSONL, one file per day. **Empty string disables logging.** |
| `telemetryRetentionDays` | 1..365 | `30` | Days of telemetry retained. Older day files are pruned. |
| `behaviorEpoch` | string | `"v1.11.0-advisory"` | Label for the behaviour regime that produced a record. Bump on every deliberate behaviour change. |
| `directSessionPrefixes` | array | `[]` | Session-key prefixes treated as a direct owner conversation. Group and channel keys are refused structurally and cannot be allowed here. |
| `factsEnabled` | boolean | `false` | Register the guarded fact-commit tool. Off unless explicitly enabled. |
| `factsAgents` | array | `["main","chat"]` | Agent ids allowed to use the fact tool. Empty array means no agent. |
| `vaultPath` | string | `""` | Store root passed to the fact writer. Never model-supplied. |
| `factsCliPath` | string | `""` | Absolute path to the fact-transaction entry point. |
| `pythonPath` | string | `"python3"` | Interpreter used to run the fact writer. |
| `factTimeoutMs` | 1000..120000 | `20000` | Budget for the fact transaction. |
| `caseTimeoutMs` | 1000..120000 | `20000` | Budget for the isolated audit completion. |
| `maxFactRevisions` | 0..1 | `1` | Bounded extra passes when an eligible turn skipped the fact tool. |

## Paths

State is host-independent. The root is resolved in this order:

1. `$LLM_GROUNDED_HOME` — explicit override
2. `$XDG_STATE_HOME/llm-grounded` — when `XDG_STATE_HOME` is set
3. `$HOME/.local/state/llm-grounded` — the ordinary default

Every directory is also overridable through config (`evidenceDir`,
`telemetryDir`), so a fresh install needs no environment variables at all.

Nothing is hardcoded to an absolute path. Directories are created mode `0700`
and files mode `0600`, because both telemetry and evidence contain verbatim
conversation text.

One default *is* host-shaped: `promptFiles` points at OpenClaw's workspace
prompt files, because their hash is what tells a telemetry record which prompt
surface produced it. On any other host, point it at your own prompt sources.
Files that do not exist hash as `"absent"`, so a wrong path degrades to a
constant rather than an error.

## Vocabulary

```jsonc
{
  "agentNames": ["atlas"],
  "personalTerms": ["sam", "rivera", "parts catalogue", "on-call weekend"]
}
```

Entries must be plain words of at least two characters. Regex metacharacters
are **rejected at config load** rather than escaped silently — a term that
needs escaping is a mistake in configuration, and accepting it would let a
stray `(` change what the classifier matches.

Terms configured here do three things:

1. A question containing one routes to memory rather than the web.
2. The word is never counted as an external proper noun.
3. For `agentNames` only: a leading or comma-separated trailing vocative is
   stripped before classification, and the name counts as a self-subject, so
   "what should I know about `<name>`?" is recognised as a question about the
   agent.

Both default to empty and both are safe empty. An unconfigured install simply
never treats a proper noun as personally owned.

## The fact transaction

Optional, off by default, and it stays off until you supply both `vaultPath`
and `factsCliPath`. A plugin that silently gained write reach on upgrade would
be exactly the wrong failure mode.

`factsCliPath` must point at an executable that accepts a JSON transaction on
stdin and returns a JSON result on stdout. It runs under `pythonPath` with an
explicit timeout, receives the store root from **configuration and never from
the model**, and its output is parsed defensively — a malformed result is
treated as a failed write, not a successful one.

## Turning things off

- **Voice gate:** `maxVoiceRevisions: 0`
- **Telemetry:** `telemetryDir: ""`
- **Fact tool:** `factsEnabled: false`, or `factsAgents: []`
- **Everything, for one agent:** leave that agent out of `enabledAgents`

There is deliberately no key for the fail-closed sentence. See
[ARCHITECTURE.md](ARCHITECTURE.md#fail-closed-text-is-not-configurable).

## After editing

Restart the OpenClaw gateway. Plugin code and configuration are read at load;
neither is re-read from disk on its own. When checking whether the restart took
effect, identify the gateway by the process actually bound to its port — a
`pgrep` pattern loose enough to match a neighbouring process will tell you the
gateway is running when it is not.
