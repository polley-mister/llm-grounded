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
 * accepted `"2"` as evidence of `"M2"`, which is exactly the class of
 * fabrication these prechecks exist to stop.
 */
export function containsValue(haystack, needle) {
  return statesValue(haystack, needle);
}

/**
 * Session keys that may run a fact transaction.
 *
 * `senderIsOwner` alone is not enough: it stays true when the operator speaks in a
 * group or a channel, and a durable personal fact must not be minted from a
 * shared conversation. OpenClaw collapses direct chats to the agent's canonical
 * main bucket (`agent:<id>:main…`) or a per-peer direct bucket
 * (`…:direct:<peer>`), and keeps group/channel sessions isolated under `:group:`
 * / `:channel:` segments. Explicit keys — a front-end console and one-shot
 * CLI runs — use OpenClaw's canonical `agent:<id>:explicit:<session-id>`
 * shape. The Gateway marks authenticated operator calls as owner requests;
 * recognizing that canonical shape keeps the console direct while the
 * group/channel exclusions above remain structural. Non-canonical explicit
 * keys may still be admitted through the configured prefix allowlist.
 *
 * Known OpenClaw limitation: a tool context exposes `sessionKey`,
 * `messageChannel` and `oneShotCliRun`, but no first-class "this is a DM" flag.
 * Anything that does not positively match one of the direct shapes is refused
 * rather than guessed at, so an unrecognized native channel context fails
 * closed.
 */
export function isDirectOwnerSession(sessionKey, ctx, cfg) {
  const key = typeof sessionKey === "string" ? sessionKey.trim() : "";
  if (!key) return { ok: false, reason: "no session key on this turn" };
  if (key.includes(":group:") || key.includes(":channel:")) {
    return { ok: false, reason: "group and channel sessions may not write vault facts" };
  }
  if (/^agent:[^:]+:explicit:[^:]+$/.test(key)) {
    return { ok: true, reason: "canonical explicit operator session" };
  }
  if (ctx?.oneShotCliRun === true) return { ok: true, reason: "one-shot cli run" };
  const prefixes = cfg?.directSessionPrefixes ?? [];
  if (prefixes.some((prefix) => key.startsWith(prefix))) {
    return { ok: true, reason: "explicit operator session" };
  }
  if (/^agent:[^:]+:main(?::|$)/.test(key)) return { ok: true, reason: "direct main session" };
  if (/:direct:[^:]+$/.test(key)) return { ok: true, reason: "direct peer session" };
  return { ok: false, reason: "session is not a recognized direct owner conversation" };
}

/**
 * OpenClaw reserves `senderIsOwner` for an allowlisted channel sender or a
 * Gateway client with operator.admin. the console deliberately connects
 * with narrower operator read/write scopes, so its authenticated loopback
 * calls arrive as `senderIsOwner: false`. Runtime-owned explicit sessions,
 * configured operator prefixes, and one-shot CLI runs remain trusted direct
 * control-plane contexts.
 */
export function isFactOperatorAuthorized(ctx, direct) {
  if (ctx?.senderIsOwner === true) return true;
  // The authenticated OpenClaw Control UI runs through the built-in `webchat`
  // transport. It deliberately uses the canonical per-agent `:main` session
  // rather than an `:explicit:` session, and its operator token normally has
  // read/write scope rather than operator.admin. The session shape is already
  // structurally direct (group/channel keys were rejected above), while
  // `messageProvider` is runtime-owned metadata rather than model input.
  // Treat this one narrow combination as the operator's direct console; do not
  // extend the exception to native channels or arbitrary `:main` sessions.
  if (direct?.ok === true && direct.reason === "direct main session" && ctx?.messageProvider === "webchat") {
    return true;
  }
  return direct?.ok === true && [
    "canonical explicit operator session",
    "explicit operator session",
    "one-shot cli run",
  ].includes(direct.reason);
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
      // 1. exposure — re-checked here, not just at factory time.
      if (!cfg.factsAgents.includes(ctx?.agentId)) {
        return failure("agent-not-allowed", "this agent may not write vault facts");
      }
      const direct = isDirectOwnerSession(ctx?.sessionKey, ctx, cfg);
      if (!direct.ok) {
        return failure("not-direct-session", direct.reason);
      }
      if (!isFactOperatorAuthorized(ctx, direct)) {
        return failure("not-owner", "only an owner-authenticated direct turn may write vault facts");
      }

      // 2. binding — resolve the exact run this tool call belongs to. The
      // binding is stamped by before_tool_call, which is the only hook that
      // sees both the tool call id and the run id.
      const key = store.resolveToolCall(toolCallId);
      if (!key) {
        return failure("unbound-call", "this tool call is not bound to a classified turn");
      }
      const entry = store.get(key);
      if (!entry) {
        return failure("no-turn-state", "no turn state for this run");
      }

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
      const transactionId = newId();
      const result = await commit(
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

      const outcome = { ...result, factKey: proposal.factKey, attribution: audited.attribution };
      store.setFactOutcome(key, outcome);
      // A committed record must be visible to the very next retrieval in this
      // same turn, so the overlay cache is dropped rather than left to expire.
      if (result.ok) deps.overlay?.invalidate?.();

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
