import { parseConfig } from "./config.js";
export declare const PLUGIN_ID = "llm-grounded";
/**
 * Resolve plugin config inside a tool factory.
 *
 * Hook contexts carry `pluginConfig`; a tool context does not — it carries the
 * whole runtime config snapshot instead. Read our own entry out of it, and fall
 * back to the last config a hook resolved, then to defaults. Defaults leave
 * `factsEnabled` false, so a failure to resolve config closes the tool rather
 * than opening it.
 */
export declare function resolveToolConfig(toolCtx: any, fallback: any): any;
/**
 * Build the plugin. Exported for tests so hook behavior can be exercised
 * without a running gateway.
 */
export declare function createPlugin(deps?: {}): {
    id: string;
    name: string;
    description: string;
    /**
     * Test-only introspection of per-turn state. Not part of the OpenClaw
     * plugin contract and not read by any handler — it exists so hook wiring
     * can be asserted on the state it actually produced rather than on a
     * downstream side effect.
     */
    readonly __store: any;
    configSchema: Readonly<{
        safeParse: typeof parseConfig;
        jsonSchema: Readonly<{
            type: "object";
            additionalProperties: false;
            properties: {
                enabledAgents: {
                    type: string;
                    items: {
                        type: string;
                        minLength: number;
                    };
                    description: string;
                };
                evidenceDir: {
                    type: string;
                    minLength: number;
                    description: string;
                };
                maxRevisions: {
                    type: string;
                    minimum: number;
                    maximum: number;
                    description: string;
                };
                stateTtlSeconds: {
                    type: string;
                    minimum: number;
                    maximum: number;
                    description: string;
                };
                maxTrackedTurns: {
                    type: string;
                    minimum: number;
                    maximum: number;
                    description: string;
                };
                factsEnabled: {
                    type: string;
                    description: string;
                };
                factsAgents: {
                    type: string;
                    items: {
                        type: string;
                        minLength: number;
                    };
                    description: string;
                };
                vaultPath: {
                    type: string;
                    minLength: number;
                    description: string;
                };
                factsCliPath: {
                    type: string;
                    minLength: number;
                    description: string;
                };
                pythonPath: {
                    type: string;
                    minLength: number;
                    description: string;
                };
                caseTimeoutMs: {
                    type: string;
                    minimum: number;
                    maximum: number;
                    description: string;
                };
                factTimeoutMs: {
                    type: string;
                    minimum: number;
                    maximum: number;
                    description: string;
                };
                maxEvidenceItems: {
                    type: string;
                    minimum: number;
                    maximum: number;
                    description: string;
                };
                maxEvidenceChars: {
                    type: string;
                    minimum: number;
                    maximum: number;
                    description: string;
                };
                maxFactRevisions: {
                    type: string;
                    minimum: number;
                    maximum: number;
                    description: string;
                };
                maxVoiceRevisions: {
                    type: string;
                    minimum: number;
                    maximum: number;
                    description: string;
                };
                voiceMaxWords: {
                    type: string;
                    minimum: number;
                    maximum: number;
                    description: string;
                };
                behaviorEpoch: {
                    type: string;
                    minLength: number;
                    description: string;
                };
                telemetryDir: {
                    type: string;
                    minLength: number;
                    description: string;
                };
                telemetryRetentionDays: {
                    type: string;
                    minimum: number;
                    maximum: number;
                    description: string;
                };
                directSessionPrefixes: {
                    type: string;
                    items: {
                        type: string;
                        minLength: number;
                    };
                    description: string;
                };
                personalTerms: {
                    type: string;
                    items: {
                        type: string;
                        minLength: number;
                    };
                    description: string;
                };
                agentNames: {
                    type: string;
                    items: {
                        type: string;
                        minLength: number;
                    };
                    description: string;
                };
                promptFiles: {
                    type: string;
                    items: {
                        type: string;
                        minLength: number;
                    };
                    description: string;
                };
            };
        }>;
    }>;
    handlers: {
        before_prompt_build(event: any, ctx: any): Promise<{
            prependSystemContext: string;
        } | undefined>;
        /**
         * Bind a fact-tool call to its run.
         *
         * This is the only hook that sees a tool call id together with a run id, so
         * it is where same-run evidence binding is established. It is also the last
         * cheap place to refuse the call outright for an agent that must not have
         * it — `execute` re-checks, but a blocked call never even runs.
         */
        before_tool_call(event: any, ctx: any): {
            block: boolean;
            blockReason: string;
        } | undefined;
        after_tool_call(event: any, ctx: any): void;
        before_agent_finalize(event: any, ctx: any): Promise<{
            action: string;
            reason: string;
            retry: {
                instruction: string;
                idempotencyKey: string;
                maxAttempts: any;
            };
        } | undefined>;
        /**
         * OpenClaw writes a completed assistant message to its transcript before
         * `before_agent_finalize` can request a retry. Delivery is suppressed, but
         * transcript-subscribing clients still render that draft, followed by the
         * revised answer. Hide only drafts which the deterministic gate already
         * knows cannot ship; tool-call messages and ordinary final answers remain
         * untouched. On the last permitted pass, persist the same fail-closed text
         * that delivery will emit, never the unverified draft.
         */
        before_message_write(event: any, ctx: any): {
            message: any;
            block?: undefined;
        } | {
            message?: undefined;
            block: boolean;
        } | undefined;
        reply_payload_sending(event: any, ctx: any): {
            cancel: boolean;
            reason: string;
            payload?: undefined;
        } | {
            cancel?: undefined;
            payload: any;
            reason: string;
        } | undefined;
        message_sending(event: any, ctx: any): {
            cancel: boolean;
            cancelReason: string;
            content?: undefined;
            metadata?: undefined;
        } | {
            cancel?: undefined;
            cancelReason?: undefined;
            content: string;
            metadata: {
                llmGrounded: {
                    failClosed: boolean;
                    factFailClosed: any;
                    grounding: any;
                };
            };
        } | undefined;
        /**
         * Terminal evidence flush.
         *
         * `before_agent_finalize` only fires when a harness is about to accept a
         * natural final answer, so a run that ends any other way would leave
         * the console with no record — which correctly fails closed, but fails
         * closed on turns that were actually fine. `agent_end` always runs, and
         * short-lived one-shot CLI paths (which is exactly how the console
         * invokes the agent) await it before process cleanup.
         */
        agent_end(event: any, ctx: any): Promise<void>;
    };
    register(api: any): void;
};
/** A tool result that reports its own failure counts as a failure. */
export declare function isErrorResult(result: any): any;
/** Remove anything that could carry an unverified claim past the text gate. */
export declare function stripUnverifiable(payload: any): any;
declare const plugin: {
    id: string;
    name: string;
    description: string;
    /**
     * Test-only introspection of per-turn state. Not part of the OpenClaw
     * plugin contract and not read by any handler — it exists so hook wiring
     * can be asserted on the state it actually produced rather than on a
     * downstream side effect.
     */
    readonly __store: any;
    configSchema: Readonly<{
        safeParse: typeof parseConfig;
        jsonSchema: Readonly<{
            type: "object";
            additionalProperties: false;
            properties: {
                enabledAgents: {
                    type: string;
                    items: {
                        type: string;
                        minLength: number;
                    };
                    description: string;
                };
                evidenceDir: {
                    type: string;
                    minLength: number;
                    description: string;
                };
                maxRevisions: {
                    type: string;
                    minimum: number;
                    maximum: number;
                    description: string;
                };
                stateTtlSeconds: {
                    type: string;
                    minimum: number;
                    maximum: number;
                    description: string;
                };
                maxTrackedTurns: {
                    type: string;
                    minimum: number;
                    maximum: number;
                    description: string;
                };
                factsEnabled: {
                    type: string;
                    description: string;
                };
                factsAgents: {
                    type: string;
                    items: {
                        type: string;
                        minLength: number;
                    };
                    description: string;
                };
                vaultPath: {
                    type: string;
                    minLength: number;
                    description: string;
                };
                factsCliPath: {
                    type: string;
                    minLength: number;
                    description: string;
                };
                pythonPath: {
                    type: string;
                    minLength: number;
                    description: string;
                };
                caseTimeoutMs: {
                    type: string;
                    minimum: number;
                    maximum: number;
                    description: string;
                };
                factTimeoutMs: {
                    type: string;
                    minimum: number;
                    maximum: number;
                    description: string;
                };
                maxEvidenceItems: {
                    type: string;
                    minimum: number;
                    maximum: number;
                    description: string;
                };
                maxEvidenceChars: {
                    type: string;
                    minimum: number;
                    maximum: number;
                    description: string;
                };
                maxFactRevisions: {
                    type: string;
                    minimum: number;
                    maximum: number;
                    description: string;
                };
                maxVoiceRevisions: {
                    type: string;
                    minimum: number;
                    maximum: number;
                    description: string;
                };
                voiceMaxWords: {
                    type: string;
                    minimum: number;
                    maximum: number;
                    description: string;
                };
                behaviorEpoch: {
                    type: string;
                    minLength: number;
                    description: string;
                };
                telemetryDir: {
                    type: string;
                    minLength: number;
                    description: string;
                };
                telemetryRetentionDays: {
                    type: string;
                    minimum: number;
                    maximum: number;
                    description: string;
                };
                directSessionPrefixes: {
                    type: string;
                    items: {
                        type: string;
                        minLength: number;
                    };
                    description: string;
                };
                personalTerms: {
                    type: string;
                    items: {
                        type: string;
                        minLength: number;
                    };
                    description: string;
                };
                agentNames: {
                    type: string;
                    items: {
                        type: string;
                        minLength: number;
                    };
                    description: string;
                };
                promptFiles: {
                    type: string;
                    items: {
                        type: string;
                        minLength: number;
                    };
                    description: string;
                };
            };
        }>;
    }>;
    handlers: {
        before_prompt_build(event: any, ctx: any): Promise<{
            prependSystemContext: string;
        } | undefined>;
        /**
         * Bind a fact-tool call to its run.
         *
         * This is the only hook that sees a tool call id together with a run id, so
         * it is where same-run evidence binding is established. It is also the last
         * cheap place to refuse the call outright for an agent that must not have
         * it — `execute` re-checks, but a blocked call never even runs.
         */
        before_tool_call(event: any, ctx: any): {
            block: boolean;
            blockReason: string;
        } | undefined;
        after_tool_call(event: any, ctx: any): void;
        before_agent_finalize(event: any, ctx: any): Promise<{
            action: string;
            reason: string;
            retry: {
                instruction: string;
                idempotencyKey: string;
                maxAttempts: any;
            };
        } | undefined>;
        /**
         * OpenClaw writes a completed assistant message to its transcript before
         * `before_agent_finalize` can request a retry. Delivery is suppressed, but
         * transcript-subscribing clients still render that draft, followed by the
         * revised answer. Hide only drafts which the deterministic gate already
         * knows cannot ship; tool-call messages and ordinary final answers remain
         * untouched. On the last permitted pass, persist the same fail-closed text
         * that delivery will emit, never the unverified draft.
         */
        before_message_write(event: any, ctx: any): {
            message: any;
            block?: undefined;
        } | {
            message?: undefined;
            block: boolean;
        } | undefined;
        reply_payload_sending(event: any, ctx: any): {
            cancel: boolean;
            reason: string;
            payload?: undefined;
        } | {
            cancel?: undefined;
            payload: any;
            reason: string;
        } | undefined;
        message_sending(event: any, ctx: any): {
            cancel: boolean;
            cancelReason: string;
            content?: undefined;
            metadata?: undefined;
        } | {
            cancel?: undefined;
            cancelReason?: undefined;
            content: string;
            metadata: {
                llmGrounded: {
                    failClosed: boolean;
                    factFailClosed: any;
                    grounding: any;
                };
            };
        } | undefined;
        /**
         * Terminal evidence flush.
         *
         * `before_agent_finalize` only fires when a harness is about to accept a
         * natural final answer, so a run that ends any other way would leave
         * the console with no record — which correctly fails closed, but fails
         * closed on turns that were actually fine. `agent_end` always runs, and
         * short-lived one-shot CLI paths (which is exactly how the console
         * invokes the agent) await it before process cleanup.
         */
        agent_end(event: any, ctx: any): Promise<void>;
    };
    register(api: any): void;
};
export default plugin;
