# Evidence capture

## Why

Claim verification needs to ask whether a specific claim is supported by
specific evidence. Today that question cannot be asked at all: telemetry records
`{name, ok, params}` for each tool call and nothing of what came back, and the
grounding evidence store holds counts and flags rather than content.

This is the binding constraint on shadow mode. It is an absent capability, not a
model-quality problem.

## The distinction this exists to protect

Three facts, recorded separately and never conflated:

```json
{ "toolSucceeded": true, "evidenceCaptured": true, "claimSupported": null }
```

A tool that ran is not evidence that a claim holds. Treating "a web tool ran" as
grounding is the error the whole project exists to correct, and it would be
trivially easy to reintroduce here by storing a boolean called `supported`.

`claimSupported` stays `null` until the entailment stage, which does not exist
yet.

## What is stored, and where

Excerpts live in their own store, never in ordinary telemetry. Telemetry carries
references only:

```json
{
  "evidenceIds": ["ev_..."],
  "evidenceCaptureAttempted": true,
  "evidenceCaptureSucceeded": true,
  "evidenceCaptureCount": 1
}
```

An evidence record:

```json
{
  "schemaVersion": "evidence-v1",
  "evidenceId": "ev_...",
  "turnId": "...",
  "toolCallId": "...",
  "tool": "web_search",
  "sourceType": "web",
  "query": "current price of product",
  "excerpt": "...",
  "excerptHash": "sha256:...",
  "capturedAt": "2026-07-27T...",
  "originalCharacters": 18420,
  "capturedCharacters": 1800,
  "truncated": true,
  "redacted": false,
  "redactionCount": 0
}
```

The hash covers the **stored** excerpt — after redaction and truncation — so it
identifies what is actually on disk rather than something that was never
written.

## Identity

`evidenceId` is generated, never derived from the query. The same query returns
different results at different times, and a content-addressed id would silently
merge two different retrievals into one. Identity binds turn id, tool call id,
tool name, result hash and timestamp.

## Which tools are captured

Only tools whose results can support a claim, and only ones explicitly approved:

`web_search` · `web_fetch` · `memory_search` · `wiki_search` · approved
runtime/status tools

Deliberately **not** captured: `exec` output, filesystem contents, full
transcripts, arbitrary plugin payloads, tool arguments, binary or attachment
data.

`exec` and file reads need a stricter policy than this commit provides. They
routinely contain secrets and large private documents, and an allowlist is the
only safe default — an unknown tool is not captured rather than captured
cautiously.

## Bounds

| bound | value |
|---|---|
| excerpt per evidence item | 2,000 characters |
| evidence items per turn | 8 |
| captured evidence per turn | 10,000 characters |

Starting points, not constants. Selection prefers, in order: the returned
answer or snippet; title and source identifier; directly surrounding context;
omitting navigation and repeated boilerplate.

**No model summarises evidence during capture.** Deterministic bounded excerpts
come first, so the later support evaluation has an auditable source rather than
a paraphrase of one. A summary is a claim about the evidence, and this stage is
not entitled to make claims.

## Redaction

Secret detection runs before anything is written, reusing `looksSecret` from
`src/values.js`. At minimum: API keys, bearer tokens, cookies, authorization
headers, private keys, passwords, connection strings, session tokens.

Redactions are counted and recorded. If safe redaction cannot be guaranteed the
capture is skipped:

```json
{ "captureStatus": "skipped", "reason": "sensitive_content" }
```

A missing excerpt is preferable to a stored credential. The evidence store is a
new place for secrets to accumulate, and it should be treated as one.

## Integrity

Directories `0700`, files `0600`. Writes are atomic — temporary file, flush,
rename — so a crash mid-write leaves either the previous state or the new one,
never a truncated record that hashes to nothing.

**Capture failure never fails a turn.** It is best-effort and telemetry-only:
if the store is unwritable, the tool result proceeds unchanged and the failure
is recorded. The alternative is a logging subsystem that can break delivery,
which is the wrong trade for a shadow feature.

## Retention

Default 14 days, configurable, with bounded pruning. Shorter than telemetry on
purpose: excerpts are verbatim third-party and private content, and an evidence
store with no expiry becomes an unbounded private archive nobody audits.

Development evidence can be copied into a fixture later, after manual redaction.

## Not in this stage

Claim-to-evidence matching, entailment, additional retrieval, answer revision,
remedy selection, enforcement, and any change to `classify.js`.
