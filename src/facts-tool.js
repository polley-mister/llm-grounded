// `vault_fact_commit` — the one guarded seam through which a conversation may
// change the state of record.
//
// The model supplies a *proposal* and nothing else. Everything that decides
// whether the proposal becomes a vault write is either deterministic (this
// file), independently audited (CASE, read-only, on its own agent), or owned by
// Vault Tools (the transaction itself).
//
// In particular the model may not supply:
//   - the quotation attributed to the operator (bound from the hook-captured turn),
//   - the retrieved vault excerpts (bound from this run's own tool results),
//   - the run/session/agent provenance,
//   - the auditing model.
//
// Order of operations, all fail-closed:
//   1. exposure     — enabled agent, owner-authenticated direct turn
//   2. binding      — the call resolves to a live turn this plugin classified
//   3. budget       — one transaction and one audit per run
//   4. eligibility  — the turn is a durable fact or a contextual correction
//   5. prechecks    — the values actually occur in the evidence they claim
//   6. audit        — CASE approves, on strict JSON
//   7. transaction  — Vault Tools commits, or refuses

import { mayInvokeFactTools, mayMutateFacts } from "./authorization.js";
import { AUDIT_PURPOSE, buildAuditPacket, runCaseAudit } from "./case-audit.js";
import { commitFactTransaction } from "./vault-txn.js";
import { looksSecret, statesValue, valuesEquivalent } from "./values.js";

export const FACT_TOOL_NAME = "vault_fact_commit";

const FACT_KEY_RE = /^[a-z0-9]+(?:\.[a-z0-9][a-z0-9-]*)+$/;
const MAX_VALUE_CHARS = 400;
const MAX_SHORT_CHARS = 160;

/** JSON Schema, not TypeBox: OpenClaw validates plain JSON-schema parameters. */
export const FACT_TOOL_PARAMETERS = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["factKey", "subject", "property", "operation", "newValue"],
  properties: {
    factKey: {
      type: "string",
      description:
        "Stable lowercase dotted identifier for this fact, e.g. operator.vehicle.car.chassis.",
    },
    subject: { type: "string", description: "What the fact is about, e.g. CAR." },
    property: { type: "string", description: "Which attribute, e.g. chassis code." },
    operation: {
      type: "string",
      enum: ["create", "correct"],
      description: "create for a new fact; correct to replace a value you or the vault got wrong.",
    },
    previousValue: {
      type: "string",
      description: "Required for correct: the exact wrong value being replaced.",
    },
    newValue: { type: "string", description: "The corrected or new value, as the operator stated it." },
    targetPage: {
      type: "string",
      description:
        "Optional vault-relative path of a generated synthesis page under syntheses/ whose prose should be updated.",
    },
  },
});

export const FACT_TOOL_DESCRIPTION = [
  "Record one durable personal fact about the operator, or correct one you got wrong,",
  "in the authoritative vault fact store. Use it in the same turn the operator states",
  "the fact — before you reply. The values must be theirs, not your paraphrase.",
  "Do not use it for questions, guesses, jokes, hypotheticals, third-party",
  "claims, or anything they did not actually assert.",
].join(" ");

function textResult(text, details) {
  return { content: [{ type: "text", text }], details: details ?? {} };
}

// The two session predicates moved to authorization.js, where the boundaries
// that consume them live. Re-exported here because they are part of this
// module's published surface.
export { isDirectOwnerSession, isFactOperatorAuthorized } from "./authorization.js";

function failure(code, message, extra = {}) {
  return textResult(`vault_fact_commit refused: ${message}`, {
    ok: false,
    code,
    ...extra,
  });
}

/**
 * Whether `haystack` actually states `value`.
 *
 * Delegates to token-sequence matching. The previous substring implementation
 * accepted `"2"` as evidence of `"TC20"`, which is exactly the class of
 * fabrication these prechecks exist to stop.
 */
export function containsValue(haystack, needle) {
  return statesValue(haystack, needle);
}

/** Structural validation of the model's proposal, before anything is consulted. */
export function validateProposal(params) {
  const str = (value) => (typeof value === "string" ? value.trim() : "");
  const factKey = str(params?.factKey);
  const subject = str(params?.subject);
  const property = str(params?.property);
  const operation = str(params?.operation);
  const newValue = str(params?.newValue);
  const previousValue = str(params?.previousValue);
  const targetPage = str(params?.targetPage);

  if (!FACT_KEY_RE.test(factKey) || factKey.length > 120) {
    return { ok: false, code: "invalid-fact-key", message: "factKey must be a lowercase dotted identifier" };
  }
  for (const [name, value] of [["subject", subject], ["property", property]]) {
    if (!value || value.length > MAX_SHORT_CHARS) {
      return { ok: false, code: "invalid-request", message: `${name} must be 1..${MAX_SHORT_CHARS} characters` };
    }
  }
  if (operation !== "create" && operation !== "correct") {
    return { ok: false, code: "invalid-request", message: "operation must be create or correct" };
  }
  if (!newValue || newValue.length > MAX_VALUE_CHARS || /[\n\r]/.test(newValue)) {
    return { ok: false, code: "invalid-request", message: "newValue must be a single line under 400 characters" };
  }
  if (operation === "correct") {
    if (!previousValue || previousValue.length > MAX_VALUE_CHARS || /[\n\r]/.test(previousValue)) {
      return { ok: false, code: "invalid-request", message: "previousValue is required for a correction" };
    }
    if (previousValue === newValue) {
      return { ok: false, code: "no-op", message: "previousValue and newValue are identical" };
    }
  } else if (previousValue) {
    return { ok: false, code: "invalid-request", message: "previousValue is only valid for a correction" };
  }
  if (targetPage) {
    if (targetPage.startsWith("/") || targetPage.includes("..") || !targetPage.endsWith(".md")) {
      return { ok: false, code: "invalid-target", message: "targetPage must be a relative in-vault Markdown path" };
    }
    if (!targetPage.startsWith("syntheses/")) {
      return { ok: false, code: "invalid-target", message: "targetPage must live under syntheses/" };
    }
  }

  return {
    ok: true,
    proposal: {
      factKey,
      subject,
      property,
      operation,
      newValue,
      previousValue: operation === "correct" ? previousValue : null,
      targetPage: targetPage || null,
    },
  };
}

/**
 * The evidence-binding prechecks. These are the acceptance criteria that stop a
 * plausible-sounding invention from reaching the vault.
 */
export function runPrechecks(proposal, entry) {
  const userMessage = entry?.userMessage ?? "";
  const prevAssistant = entry?.prevAssistant ?? "";
  const evidence = entry?.wikiEvidence ?? [];

  // The exact user message becomes `sourceQuote`, so a message carrying a
  // secret is refused whole — even when the proposed value itself is benign.
  // Persisting "my router is a CCR2004, password hunter2" would leak the
  // credential no matter how clean newValue looked.
  if (looksSecret(userMessage)) {
    return {
      ok: false,
      code: "secret-like-message",
      message: "the source message looks like it carries a credential; nothing was recorded",
    };
  }
  if (looksSecret(proposal.newValue) || looksSecret(proposal.previousValue ?? "")) {
    return { ok: false, code: "secret-like-value", message: "a proposed value looks like a credential" };
  }

  // A value the operator never said cannot be committed, however confident the model
  // is that it is correct.
  if (!containsValue(userMessage, proposal.newValue)) {
    return {
      ok: false,
      code: "new-value-not-stated",
      message: "newValue does not occur in the operator's message this turn",
    };
  }

  if (proposal.operation === "correct") {
    const inAnswer = containsValue(prevAssistant, proposal.previousValue);
    const inVault = evidence.some((item) => containsValue(item?.excerpt, proposal.previousValue));
    if (!inAnswer && !inVault) {
      return {
        ok: false,
        code: "old-value-unsupported",
        message: "previousValue occurs neither in the preceding answer nor in this turn's vault evidence",
      };
    }
    return {
      ok: true,
      checks: {
        newValueInOwnerMessage: true,
        previousValueInAssistantAnswer: inAnswer,
        previousValueInVaultEvidence: inVault,
      },
    };
  }

  return { ok: true, checks: { newValueInOwnerMessage: true } };
}

/**
 * Build the tool. `deps` supplies everything that touches the world, so the
 * whole path is testable without a gateway, a vault, or a model.
 */
export function createFactTool({ cfg, store, ctx, deps = {}, logger }) {
  const audit = deps.runCaseAudit ?? runCaseAudit;
  const commit = deps.commitFactTransaction ?? commitFactTransaction;
  const newId = deps.newTransactionId ?? (() => `tx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

  return {
    name: FACT_TOOL_NAME,
    label: "Vault Fact Commit",
    description: FACT_TOOL_DESCRIPTION,
    parameters: FACT_TOOL_PARAMETERS,
    async execute(toolCallId, params, signal) {
      // Boundary 2 of three — invocation. The same requirements exposure
      // applied, re-derived from this tool's own execute context, which is a
      // different object than the factory saw. Permission is not inherited
      // from the earlier verdict; a session that changed shape in between is
      // refused here.
      const invocation = mayInvokeFactTools(cfg, ctx);
      if (!invocation.ok) return failure(invocation.code, invocation.reason);

      // Binding — resolve the exact run this tool call belongs to. The binding
      // is stamped by before_tool_call, which is the only hook that sees both
      // the tool call id and the run id.
      // Asked before resolving, because `resolveToolCall` consumes the binding
      // and answers null for both "never bound" and "bound to a turn that is
      // gone" — a wiring fault and a timing fault, which must not share a code.
      const wasBound = store.hasToolCallBinding(toolCallId);
      const key = store.resolveToolCall(toolCallId);
      const entry = key ? store.get(key) : null;

      // Boundary 3 of three — mutation. Everything invocation required, and a
      // turn to attribute the write to. See
      // docs/decisions/ADR-0002-fact-authorization-boundaries.md.
      const mutation = mayMutateFacts(cfg, ctx, { boundKey: wasBound, boundTurn: entry });
      if (!mutation.ok) return failure(mutation.code, mutation.reason);
      const direct = mutation.direct;

      // 3. budget — one evidence-backed transaction and one audit per run.
      // Deterministic precheck failures do not consume this slot: Flash may
      // call before retrieval, then search after the refusal. Counting that
      // harmless ordering mistake made the now-valid second call impossible.
      if (entry.factCalls >= 1) {
        return failure("already-used", "one fact transaction per turn", { factKey: entry.factOutcome?.factKey });
      }

      // 4. eligibility
      if (!entry.factEligible) {
        const outcome = { ok: false, code: "turn-not-eligible" };
        store.setFactOutcome(key, outcome);
        return failure("turn-not-eligible", `this turn is not a durable fact statement (${entry.factReason})`);
      }

      // 5. structural + evidence prechecks
      const validated = validateProposal(params);
      if (!validated.ok) {
        store.setFactOutcome(key, validated);
        return failure(validated.code, validated.message);
      }
      const { proposal } = validated;
      if (entry.factKind && proposal.operation !== entry.factKind) {
        const mismatch = {
          ok: false,
          code: "operation-mismatch",
          message: `this turn was detected as a ${entry.factKind}, not a ${proposal.operation}`,
        };
        store.setFactOutcome(key, mismatch);
        return failure(mismatch.code, mismatch.message);
      }
      const prechecks = runPrechecks(proposal, entry);
      if (!prechecks.ok) {
        store.setFactOutcome(key, prechecks);
        return failure(prechecks.code, prechecks.message);
      }

      // The proposal is now structurally valid and bound to the operator's exact
      // words plus trusted same-run context. From this point onward it consumes
      // the single transaction slot, whether CASE or the writer later refuses.
      store.noteFactCall(key);

      // 6. the isolated CASE audit
      if (entry.caseAudits >= 1) {
        return failure("already-audited", "one CASE audit per turn");
      }
      store.noteCaseAudit(key);
      const packet = buildAuditPacket({
        userMessage: entry.userMessage,
        prevAssistant: entry.prevAssistant,
        evidence: entry.wikiEvidence,
        proposal,
        prechecks: prechecks.checks,
        maxEvidenceChars: cfg.maxEvidenceChars,
      });
      const audited = await audit({
        llm: deps.llm,
        packet,
        timeoutMs: cfg.caseTimeoutMs,
        signal,
      });
      if (!audited.ok) {
        store.setFactOutcome(key, audited);
        logger?.warn?.(`llmGrounded: ${AUDIT_PURPOSE} failed closed: ${audited.code}`);
        return failure(audited.code, audited.message ?? "the audit did not complete", {
          attribution: audited.attribution,
        });
      }
      // The audit must be an audit *of this proposal*. An auditor that approves
      // while naming different values has not agreed to what is about to be
      // written — it has approved something else, and treating that as consent
      // would let a drifting or confused reply authorize an unreviewed change.
      if (audited.ok && audited.decision.decision === "approve") {
        const newBound = valuesEquivalent(audited.decision.supportedNewValue, proposal.newValue);
        const oldBound =
          proposal.operation !== "correct" ||
          valuesEquivalent(audited.decision.supportedOldValue, proposal.previousValue);
        if (!newBound || !oldBound) {
          const unbound = {
            ok: false,
            code: "case-unbound",
            message:
              "the audit approved values that do not match the proposal " +
              `(supportedNewValue=${JSON.stringify(audited.decision.supportedNewValue)}, ` +
              `supportedOldValue=${JSON.stringify(audited.decision.supportedOldValue)})`,
          };
          store.setFactOutcome(key, unbound);
          return failure(unbound.code, unbound.message, { attribution: audited.attribution });
        }
      }

      if (audited.decision.decision !== "approve") {
        const refused = {
          ok: false,
          code: `case-${audited.decision.decision}`,
          message: audited.decision.reason,
        };
        store.setFactOutcome(key, refused);
        return failure(refused.code, `CASE ${audited.decision.decision}: ${audited.decision.reason}`, {
          attribution: audited.attribution,
        });
      }

      // 7. the transaction. Provenance and the quotation are bound here, from
      // hook-captured state — never from `params`.
      //
      // `expectedRevision` binds the revision this decision was made against,
      // so a record that moved between the overlay read and the write is
      // refused as stale rather than silently overwritten. It is an optimistic
      // hint, not the guarantee: the authoritative compare-and-swap runs inside
      // the writer's exclusive lock, where it also re-checks previousValue
      // against the record on disk. Binding it here is what makes a *stale
      // read* visible; the lock is what makes a *concurrent write* safe.
      let expectedRevision = null;
      try {
        const known = (await deps.overlay?.load())?.facts?.[proposal.factKey];
        if (Number.isInteger(known?.revision)) expectedRevision = known.revision;
      } catch {
        // An unreadable overlay only costs the optimistic hint.
      }
      // The proposal is validated and about to be attempted. Capture it before
      // the write, for two reasons that both matter only when the write fails:
      //
      //   * the session overlay holds the corrected value so the rest of this
      //     conversation does not read the stale one back;
      //   * a truthful reply can be rebuilt from structured data if the model's
      //     draft turns out to claim the write succeeded.
      //
      // Session identity is never synthesised. With no stable session key the
      // overlay is skipped entirely rather than filed under a shared default,
      // which would leak one conversation's correction into another.
      store.setFactProposal(key, {
        factKey: proposal.factKey,
        subject: proposal.subject,
        property: proposal.property,
        operation: proposal.operation,
        newValue: proposal.newValue,
        previousValue: proposal.previousValue,
      });
      const overlaySessionKey = ctx?.sessionKey ?? entry.sessionKey ?? null;
      if (overlaySessionKey && deps.sessionOverlay) {
        deps.sessionOverlay.hold({
          sessionKey: overlaySessionKey,
          factKey: proposal.factKey,
          subject: proposal.subject,
          property: proposal.property,
          currentValue: proposal.newValue,
          supersededValues: proposal.previousValue ? [proposal.previousValue] : [],
        });
      }

      const transactionId = newId();
      // A throw is an outcome, not an escape. The writer spawns a process, so
      // a spawn failure, a timeout, or a malformed response can all raise —
      // and an exception escaping here would leave the turn with no recorded
      // outcome at all, which reads downstream as "never attempted" rather
      // than "failed". The overlay stays held either way.
      let result;
      try {
        result = await commit(
        {
          factKey: proposal.factKey,
          subject: proposal.subject,
          property: proposal.property,
          operation: proposal.operation,
          previousValue: proposal.previousValue,
          newValue: proposal.newValue,
          targetPage: proposal.targetPage,
          expectedRevision,
          transactionId,
          sourceQuote: entry.userMessage,
          runId: entry.runId ?? null,
          sessionId: ctx?.sessionId ?? entry.sessionKey ?? null,
          agentId: ctx?.agentId ?? null,
          writer: "llm-grounded",
          case: {
            decision: audited.decision.decision,
            reason: audited.decision.reason,
            agentId: audited.attribution?.agentId ?? null,
            provider: audited.attribution?.provider ?? null,
            model: audited.attribution?.model ?? null,
          },
        },
        {
          pythonPath: cfg.pythonPath,
          scriptPath: cfg.factsCliPath,
          vaultPath: cfg.vaultPath,
          timeoutMs: cfg.factTimeoutMs,
          spawnFn: deps.spawnFn,
        },
        );
      } catch (err) {
        result = {
          ok: false,
          code: "commit-threw",
          message: String(err?.message ?? err),
        };
        logger?.warn?.(`llmGrounded: fact transaction threw: ${result.message}`);
      }

      const outcome = { ...result, factKey: proposal.factKey, attribution: audited.attribution };
      store.setFactOutcome(key, outcome);
      // Success must be explicit. A throw, a timeout, a malformed response or
      // `ok: undefined` all retain the overlay and stay a persistence failure —
      // the one thing worse than not writing is believing you did.
      if (result?.ok === true) {
        // A committed record must be visible to the very next retrieval in this
        // same turn, so the overlay cache is dropped rather than left to expire.
        deps.overlay?.invalidate?.();
        if (overlaySessionKey && deps.sessionOverlay) {
          deps.sessionOverlay.release({ sessionKey: overlaySessionKey, factKey: proposal.factKey });
        }
      }

      if (!result.ok) {
        return failure(result.code, result.message ?? "the transaction was refused", {
          factKey: proposal.factKey,
        });
      }

      const note = result.needsRematerialization
        ? " The synthesis prose was left unchanged (ambiguous match); the fact record is authoritative."
        : "";
      return textResult(
        `Recorded ${proposal.factKey} = ${proposal.newValue} (revision ${result.revision}).${note}`,
        outcome,
      );
    },
  };
}
