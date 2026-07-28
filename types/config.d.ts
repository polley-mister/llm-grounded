/** Validate and normalize plugin config without pulling in the SDK. */
export function parseConfig(value: any): {
    success: boolean;
    error: {
        issues: {
            path: any[];
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
        directSessionPrefixes: any[];
        personalTerms: any[];
        agentNames: any[];
        trafficClasses: {
            bySessionPrefix: {};
            byAgent: {};
            default: string;
        };
        evidenceCaptureEnabled: false;
        evidenceCaptureDir: any;
        evidenceCaptureRetentionDays: 14;
        evidenceCaptureTools: string[];
        evidenceCaptureRuntimeTools: any[];
        evidenceCaptureTrafficClasses: string[];
        evidenceCaptureTimeoutMs: 400;
        evidenceCaptureMaxItemsPerCall: 5;
        evidenceCaptureMaxItemsPerTurn: 8;
        evidenceCaptureMaxCharsPerItem: 2000;
        evidenceCaptureMaxCharsPerTurn: 10000;
        claimExtractionEnabled: false;
        claimExtractionDir: any;
        claimExtractionRetentionDays: 14;
        claimExtractionTrafficClasses: string[];
        claimExtractionAgentId: "";
        claimExtractionTimeoutMs: 20000;
        claimExtractionMaxTokens: 16000;
        promptFiles: any[];
    };
};
/** Whether the contract applies to this agent. */
export function appliesToAgent(cfg: any, agentId: any): boolean;
/**
 * Whether this agent may run a fact transaction.
 *
 * Unlike `enabledAgents`, an empty `factsAgents` means *no* agent rather than
 * every agent. Vault-write reach is the one place where a permissive reading of
 * an empty list would be indefensible.
 */
export function factsApplyToAgent(cfg: any, agentId: any): boolean;
export const DEFAULTS: Readonly<{
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
    directSessionPrefixes: any[];
    personalTerms: any[];
    agentNames: any[];
    trafficClasses: {
        bySessionPrefix: {};
        byAgent: {};
        default: string;
    };
    evidenceCaptureEnabled: false;
    evidenceCaptureDir: any;
    evidenceCaptureRetentionDays: 14;
    evidenceCaptureTools: string[];
    evidenceCaptureRuntimeTools: any[];
    evidenceCaptureTrafficClasses: string[];
    evidenceCaptureTimeoutMs: 400;
    evidenceCaptureMaxItemsPerCall: 5;
    evidenceCaptureMaxItemsPerTurn: 8;
    evidenceCaptureMaxCharsPerItem: 2000;
    evidenceCaptureMaxCharsPerTurn: 10000;
    claimExtractionEnabled: false;
    claimExtractionDir: any;
    claimExtractionRetentionDays: 14;
    claimExtractionTrafficClasses: string[];
    claimExtractionAgentId: "";
    claimExtractionTimeoutMs: 20000;
    claimExtractionMaxTokens: 16000;
    promptFiles: any[];
}>;
export const CONFIG_JSON_SCHEMA: Readonly<{
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
        evidenceCaptureEnabled: {
            type: string;
            description: string;
        };
        evidenceCaptureDir: {
            type: string;
            minLength: number;
            description: string;
        };
        evidenceCaptureRetentionDays: {
            type: string;
            minimum: number;
            maximum: number;
            description: string;
        };
        evidenceCaptureTools: {
            type: string;
            items: {
                type: string;
                minLength: number;
            };
            description: string;
        };
        evidenceCaptureRuntimeTools: {
            type: string;
            items: {
                type: string;
                minLength: number;
            };
            description: string;
        };
        evidenceCaptureTrafficClasses: {
            type: string;
            items: {
                enum: string[];
            };
            description: string;
        };
        evidenceCaptureTimeoutMs: {
            type: string;
            minimum: number;
            maximum: number;
            description: string;
        };
        evidenceCaptureMaxItemsPerCall: {
            type: string;
            minimum: number;
            maximum: number;
        };
        evidenceCaptureMaxItemsPerTurn: {
            type: string;
            minimum: number;
            maximum: number;
        };
        evidenceCaptureMaxCharsPerItem: {
            type: string;
            minimum: number;
            maximum: number;
        };
        claimExtractionEnabled: {
            type: string;
            description: string;
        };
        claimExtractionDir: {
            type: string;
            minLength: number;
            description: string;
        };
        claimExtractionRetentionDays: {
            type: string;
            minimum: number;
            maximum: number;
            description: string;
        };
        claimExtractionTrafficClasses: {
            type: string;
            items: {
                enum: string[];
            };
            description: string;
        };
        claimExtractionAgentId: {
            type: string;
            description: string;
        };
        claimExtractionTimeoutMs: {
            type: string;
            minimum: number;
            maximum: number;
            description: string;
        };
        claimExtractionMaxTokens: {
            type: string;
            minimum: number;
            maximum: number;
            description: string;
        };
        evidenceCaptureMaxCharsPerTurn: {
            type: string;
            minimum: number;
            maximum: number;
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
/** Runtime config-schema object in the shape OpenClaw's plugin loader expects. */
export const configSchema: Readonly<{
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
            evidenceCaptureEnabled: {
                type: string;
                description: string;
            };
            evidenceCaptureDir: {
                type: string;
                minLength: number;
                description: string;
            };
            evidenceCaptureRetentionDays: {
                type: string;
                minimum: number;
                maximum: number;
                description: string;
            };
            evidenceCaptureTools: {
                type: string;
                items: {
                    type: string;
                    minLength: number;
                };
                description: string;
            };
            evidenceCaptureRuntimeTools: {
                type: string;
                items: {
                    type: string;
                    minLength: number;
                };
                description: string;
            };
            evidenceCaptureTrafficClasses: {
                type: string;
                items: {
                    enum: string[];
                };
                description: string;
            };
            evidenceCaptureTimeoutMs: {
                type: string;
                minimum: number;
                maximum: number;
                description: string;
            };
            evidenceCaptureMaxItemsPerCall: {
                type: string;
                minimum: number;
                maximum: number;
            };
            evidenceCaptureMaxItemsPerTurn: {
                type: string;
                minimum: number;
                maximum: number;
            };
            evidenceCaptureMaxCharsPerItem: {
                type: string;
                minimum: number;
                maximum: number;
            };
            claimExtractionEnabled: {
                type: string;
                description: string;
            };
            claimExtractionDir: {
                type: string;
                minLength: number;
                description: string;
            };
            claimExtractionRetentionDays: {
                type: string;
                minimum: number;
                maximum: number;
                description: string;
            };
            claimExtractionTrafficClasses: {
                type: string;
                items: {
                    enum: string[];
                };
                description: string;
            };
            claimExtractionAgentId: {
                type: string;
                description: string;
            };
            claimExtractionTimeoutMs: {
                type: string;
                minimum: number;
                maximum: number;
                description: string;
            };
            claimExtractionMaxTokens: {
                type: string;
                minimum: number;
                maximum: number;
                description: string;
            };
            evidenceCaptureMaxCharsPerTurn: {
                type: string;
                minimum: number;
                maximum: number;
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
