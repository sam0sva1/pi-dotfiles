import { normalize, sep } from "node:path";

import type { AccessDecision, ToolCategory } from "./core.ts";

export type GrantScope = "exact" | "subtree";

export type GrantRecord = {
    kind: GrantKind;
    scope: GrantScope;
    target: string;
    key: string;
    toolName: string;
    category: ToolCategory;
    reason: string;
    createdAt: number;
};

export type GrantStore = ReturnType<typeof createGrantStore>;

export function createGrantStore() {
    const records = new Map<string, GrantRecord>();

    return {
        rememberGrant(decision: AccessDecision): GrantRecord | undefined {
            if (!decision.grantKey || !decision.targetPath || !decision.grantKind || !decision.grantScope) return undefined;

            const record: GrantRecord = {
                kind: decision.grantKind,
                scope: decision.grantScope,
                target: decision.grantKind === "bash" ? decision.targetPath : normalize(decision.targetPath),
                key: decision.grantKey,
                toolName: decision.toolName,
                category: decision.category,
                reason: decision.reason,
                createdAt: Date.now(),
            };
            records.set(record.key, record);
            return record;
        },

        hasCoverage(decision: AccessDecision): boolean {
            if (!decision.grantKey || !decision.targetPath || !decision.grantKind) return false;

            if (decision.grantKind !== "browse-path") {
                return records.has(decision.grantKey);
            }

            const normalizedTarget = normalize(decision.targetPath);
            for (const record of records.values()) {
                if (record.kind !== "browse-path") continue;
                if (isPathWithinPrefix(normalizedTarget, record.target)) return true;
            }
            return false;
        },

        clear(): void {
            records.clear();
        },

        list(): GrantRecord[] {
            return [...records.values()].sort((a, b) => a.createdAt - b.createdAt);
        },

        size(): number {
            return records.size;
        },
    };
}

function isPathWithinPrefix(targetPath: string, prefix: string): boolean {
    const normalizedTarget = trimTrailingSep(normalize(targetPath));
    const normalizedPrefix = trimTrailingSep(normalize(prefix));
    return normalizedTarget === normalizedPrefix || normalizedTarget.startsWith(normalizedPrefix + sep);
}

function trimTrailingSep(value: string): string {
    if (value.length <= 1) return value;
    return value.endsWith(sep) ? value.slice(0, -1) : value;
}
