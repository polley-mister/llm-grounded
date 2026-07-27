export declare const FACT_TOOL_NAME = "vault_fact_commit";
/** JSON Schema, not TypeBox: OpenClaw validates plain JSON-schema parameters. */
export declare const FACT_TOOL_PARAMETERS: Readonly<{
    type: "object";
    additionalProperties: false;
    required: string[];
    properties: {
        factKey: {
            type: string;
            description: string;
        };
        subject: {
            type: string;
            description: string;
        };
        property: {
            type: string;
            description: string;
        };
        operation: {
            type: string;
            enum: string[];
            description: string;
        };
        previousValue: {
            type: string;
            description: string;
        };
        newValue: {
            type: string;
            description: string;
        };
        targetPage: {
            type: string;
            description: string;
        };
    };
}>;
export declare const FACT_TOOL_DESCRIPTION: string;
/**
 * Whether `haystack` actually states `value`.
 *
 * Delegates to token-sequence matching. The previous substring implementation
 * accepted `"2"` as evidence of `"M2"`, which is exactly the class of
 * fabrication these prechecks exist to stop.
 */
export declare function containsValue(haystack: any, needle: any): boolean;
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
export declare function isDirectOwnerSession(sessionKey: any, ctx: any, cfg: any): {
    ok: boolean;
    reason: string;
};
/**
 * OpenClaw reserves `senderIsOwner` for an allowlisted channel sender or a
 * Gateway client with operator.admin. the console deliberately connects
 * with narrower operator read/write scopes, so its authenticated loopback
 * calls arrive as `senderIsOwner: false`. Runtime-owned explicit sessions,
 * configured operator prefixes, and one-shot CLI runs remain trusted direct
 * control-plane contexts.
 */
export declare function isFactOperatorAuthorized(ctx: any, direct: any): boolean;
/** Structural validation of the model's proposal, before anything is consulted. */
export declare function validateProposal(params: any): {
    ok: boolean;
    code: string;
    message: string;
    proposal?: undefined;
} | {
    code?: undefined;
    message?: undefined;
    ok: boolean;
    proposal: {
        factKey: string;
        subject: string;
        property: string;
        operation: string;
        newValue: string;
        previousValue: string | null;
        targetPage: string | null;
    };
};
/**
 * The evidence-binding prechecks. These are the acceptance criteria that stop a
 * plausible-sounding invention from reaching the vault.
 */
export declare function runPrechecks(proposal: any, entry: any): {
    ok: boolean;
    code: string;
    message: string;
    checks?: undefined;
} | {
    code?: undefined;
    message?: undefined;
    ok: boolean;
    checks: {
        newValueInOwnerMessage: boolean;
        previousValueInAssistantAnswer: boolean;
        previousValueInVaultEvidence: any;
    };
} | {
    code?: undefined;
    message?: undefined;
    ok: boolean;
    checks: {
        previousValueInAssistantAnswer?: undefined;
        previousValueInVaultEvidence?: undefined;
        newValueInOwnerMessage: boolean;
    };
};
/**
 * Build the tool. `deps` supplies everything that touches the world, so the
 * whole path is testable without a gateway, a vault, or a model.
 */
export declare function createFactTool({ cfg, store, ctx, deps, logger }: {
    cfg: any;
    ctx: any;
    deps?: {} | undefined;
    logger: any;
    store: any;
}): {
    name: string;
    label: string;
    description: string;
    parameters: Readonly<{
        type: "object";
        additionalProperties: false;
        required: string[];
        properties: {
            factKey: {
                type: string;
                description: string;
            };
            subject: {
                type: string;
                description: string;
            };
            property: {
                type: string;
                description: string;
            };
            operation: {
                type: string;
                enum: string[];
                description: string;
            };
            previousValue: {
                type: string;
                description: string;
            };
            newValue: {
                type: string;
                description: string;
            };
            targetPage: {
                type: string;
                description: string;
            };
        };
    }>;
    execute(toolCallId: any, params: any, signal: any): Promise<{
        content: {
            type: string;
            text: any;
        }[];
        details: any;
    }>;
};
