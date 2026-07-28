/**
 * Resolve a correction's scope and what it is permitted to do.
 *
 * @returns {{
 *   isCorrection: boolean,
 *   correctionScope: "user_owned_fact"|"external_world"|"ambiguous"|null,
 *   evidenceSource: string|null,
 *   requiredTool: null,
 *   factEnforcementRequired: boolean,
 *   commitPermitted: boolean,
 *   reason: string
 * }}
 */
export function resolveCorrection(userMessage: any, prevAssistant: any): {
    isCorrection: boolean;
    correctionScope: "user_owned_fact" | "external_world" | "ambiguous" | null;
    evidenceSource: string | null;
    requiredTool: null;
    factEnforcementRequired: boolean;
    commitPermitted: boolean;
    reason: string;
};
