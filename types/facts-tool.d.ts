/**
 * Whether `haystack` actually states `value`.
 *
 * Delegates to token-sequence matching. The previous substring implementation
 * accepted `"2"` as evidence of `"TC20"`, which is exactly the class of
 * fabrication these prechecks exist to stop.
 */
export function containsValue(haystack: any, needle: any): boolean;
/** Structural validation of the model's proposal, before anything is consulted. */
export function validateProposal(params: any): {
    ok: boolean;
    code: string;
    message: string;
    proposal?: undefined;
} | {
    ok: boolean;
    proposal: {
        factKey: string;
        subject: string;
        property: string;
        operation: string;
        newValue: string;
        previousValue: string;
        targetPage: string;
    };
    code?: undefined;
    message?: undefined;
};
/**
 * The evidence-binding prechecks. These are the acceptance criteria that stop a
 * plausible-sounding invention from reaching the vault.
 */
export function runPrechecks(proposal: any, entry: any): {
    ok: boolean;
    code: string;
    message: string;
    checks?: undefined;
} | {
    ok: boolean;
    checks: {
        newValueInOwnerMessage: boolean;
        previousValueInAssistantAnswer: boolean;
        previousValueInVaultEvidence: any;
    };
    code?: undefined;
    message?: undefined;
} | {
    ok: boolean;
    checks: {
        newValueInOwnerMessage: boolean;
        previousValueInAssistantAnswer?: undefined;
        previousValueInVaultEvidence?: undefined;
    };
    code?: undefined;
    message?: undefined;
};
/**
 * Build the tool. `deps` supplies everything that touches the world, so the
 * whole path is testable without a gateway, a vault, or a model.
 */
export function createFactTool({ cfg, store, ctx, deps, logger }: {
    cfg: any;
    store: any;
    ctx: any;
    deps?: {};
    logger: any;
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
export const FACT_TOOL_NAME: "vault_fact_commit";
/** JSON Schema, not TypeBox: OpenClaw validates plain JSON-schema parameters. */
export const FACT_TOOL_PARAMETERS: Readonly<{
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
export const FACT_TOOL_DESCRIPTION: string;
export { isDirectOwnerSession, isFactOperatorAuthorized } from "./authorization.js";
