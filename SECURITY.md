# Security policy

## Reporting

Report vulnerabilities privately through GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository. Please do not open a public issue first.

This is a single-maintainer project run alongside other work. Expect an
acknowledgement within a week rather than within a day.

## What this package is, in security terms

llm-grounded is a **mitigation, not a boundary.** It reduces how often an agent
states unsupported facts and refuses a category of privacy-invasive searches.
It is not an access control, a sandbox, or a filter you should rely on to keep
a determined adversary from reaching a tool or eliciting an answer.

Two properties are worth stating plainly, because assuming the opposite is the
most likely way to get hurt by this code:

**The sensitive-search gate is pattern-based.** It matches intent phrasing
against likely-person signals. It will not catch an obfuscated, translated, or
multi-step version of the same request, and it is not intended to. It exists to
stop the ordinary accident, a playful hypothetical becoming a search for
someone's home address, which is a real failure this project has on record.

**Advisory routing is the default, deliberately.** Since 0.1.0 the classifier
cannot compel a tool. If your threat model requires that certain answers are
never produced without retrieval, that guarantee currently holds only for
explicit tool requests. This is documented as an accepted regression in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), not an oversight.

## In scope

- A way to make a gate release a draft it should have withheld, or to bypass
  the fail-closed substitution on any delivery path.
- A way to reach the fact-transaction tool without the required authorisation,
  or to get a value written that the operator did not assert.
- Command injection or path traversal through configuration or tool
  parameters, particularly in the optional fact transaction, which spawns a
  process.
- Secrets or verbatim conversation text appearing somewhere they should not.
  Evidence and telemetry records contain real conversation content; they are
  written `0600` in directories created `0700`, and any weakening of that is a
  bug worth reporting.

## Out of scope

- Prompt injection that persuades a model to say something untrue but
  *supported by the evidence it retrieved*. That is a model problem; this
  package gates evidence, not truth.
- Bypassing the sensitive-search gate through rephrasing. Improvements are
  welcome as ordinary issues; it is not treated as a vulnerability.
- The behaviour of any model, host framework, or tool this package is wired
  into.

## Operational note

Configuration values are literal, never expanded. If you keep credentials near
this package's config, keep them in a file the package does not read. Nothing
here needs a secret to work.
