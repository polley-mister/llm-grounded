export declare const DEFAULTS: Readonly<{
    enabledAgents: string[];
    evidenceDir: any;
    maxRevisions: 1;
    stateTtlSeconds: 600;
    maxTrackedTurns: 200;
    factsEnabled: false;
    factsAgents: string[];
    vaultPath: "";
    factsCliPath: "";
    behaviorEpoch: "v0.1.0-advisory";
    telemetryDir: any;
    telemetryRetentionDays: 30;
    maxVoiceRevisions: 1;
    voiceMaxWords: 90;
    pythonPath: "python3";
    caseTimeoutMs: 20000;
    factTimeoutMs: 20000;
    maxEvidenceItems: 4;
    maxEvidenceChars: 1200;
    maxFactRevisions: 1;
    directSessionPrefixes: never[];
    personalTerms: never[];
    agentNames: never[];
    trafficClasses: {
        bySessionPrefix: {};
        byAgent: {};
        default: string;
    };
    promptFiles: any[];
}>;
export declare const CONFIG_JSON_SCHEMA: Readonly<{
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
        trafficClasses: {
            type: string;
            additionalProperties: boolean;
            properties: {
                bySessionPrefix: {
                    type: string;
                    additionalProperties: {
                        enum: string[];
                    };
                    description: string;
                };
                byAgent: {
                    type: string;
                    additionalProperties: {
                        enum: string[];
                    };
                    description: string;
                };
                default: {
                    enum: string[];
                    description: string;
                };
            };
            description: string;
        };
    };
}>;
/** Validate and normalize plugin config without pulling in the SDK. */
export declare function parseConfig(value: any): {
    success: boolean;
    error: {
        issues: {
            path: never[];
            message: any;
        }[];
    };
} | {
    success: boolean;
    data: {
        enabledAgents: string[];
        evidenceDir: any;
        maxRevisions: 1;
        stateTtlSeconds: 600;
        maxTrackedTurns: 200;
        factsEnabled: false;
        factsAgents: string[];
        vaultPath: "";
        factsCliPath: "";
        behaviorEpoch: "v0.1.0-advisory";
        telemetryDir: any;
        telemetryRetentionDays: 30;
        maxVoiceRevisions: 1;
        voiceMaxWords: 90;
        pythonPath: "python3";
        caseTimeoutMs: 20000;
        factTimeoutMs: 20000;
        maxEvidenceItems: 4;
        maxEvidenceChars: 1200;
        maxFactRevisions: 1;
        directSessionPrefixes: never[];
        personalTerms: never[];
        agentNames: never[];
        trafficClasses: {
            bySessionPrefix: {};
            byAgent: {};
            default: string;
        };
        promptFiles: any[];
    };
};
/** Runtime config-schema object in the shape OpenClaw's plugin loader expects. */
export declare const configSchema: Readonly<{
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
            trafficClasses: {
                type: string;
                additionalProperties: boolean;
                properties: {
                    bySessionPrefix: {
                        type: string;
                        additionalProperties: {
                            enum: string[];
                        };
                        description: string;
                    };
                    byAgent: {
                        type: string;
                        additionalProperties: {
                            enum: string[];
                        };
                        description: string;
                    };
                    default: {
                        enum: string[];
                        description: string;
                    };
                };
                description: string;
            };
        };
    }>;
}>;
/** Whether the contract applies to this agent. */
export declare function appliesToAgent(cfg: any, agentId: any): boolean;
/**
 * Whether this agent may run a fact transaction.
 *
 * Unlike `enabledAgents`, an empty `factsAgents` means *no* agent rather than
 * every agent. Vault-write reach is the one place where a permissive reading of
 * an empty list would be indefensible.
 */
export declare function factsApplyToAgent(cfg: any, agentId: any): boolean;
