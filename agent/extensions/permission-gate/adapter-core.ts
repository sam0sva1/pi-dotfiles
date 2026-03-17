import {
    buildAuditEntry,
    buildPromptModel,
    classifyBashCommand,
    classifyOtherToolAccess,
    classifyPathAccess,
    formatActiveGrants,
    PATH_BROWSE_TOOLS,
    PATH_MODIFY_TOOLS,
    PATH_READ_TOOLS,
    type AccessDecision,
    type PermissionAuditEntry,
    type PermissionGateContext,
} from "./core.ts";
import type { GrantStore } from "./grant-store.ts";
import type { NoticeRecord, NoticeStore } from "./notice-store.ts";

export type ToolCallEventLike = {
    toolName: string;
    input: Record<string, unknown>;
};

export type UiLike = {
    notify(message: string, level: string): void;
    select?(message: string, options: string[]): Promise<string | undefined>;
};

export type ContextLike = {
    cwd: string;
    hasUI: boolean;
    ui: UiLike;
};

export type RuntimeLike = {
    clearGrantsIfBoundaryChanged(cwd: string): boolean;
    getSnapshotForCwd(cwd: string): PermissionGateContext;
    getGrantStore(): GrantStore;
    getNoticeStore(): NoticeStore;
};

export type ToolCallResult = { block: true; reason: string } | undefined;

export function deliverPendingNotices(ctx: ContextLike, noticeStore: NoticeStore): void {
    if (!ctx.hasUI) return;
    const notices = noticeStore.drainPending();
    if (notices.length === 0) return;
    for (const notice of notices) {
        ctx.ui.notify(notice.message, "info");
    }
    noticeStore.markDelivered(notices);
}

export async function handleToolCall(options: {
    event: ToolCallEventLike;
    ctx: ContextLike;
    runtime: RuntimeLike;
    appendAudit(entry: PermissionAuditEntry): void;
}): Promise<ToolCallResult> {
    const { event, ctx, runtime, appendAudit } = options;
    runtime.clearGrantsIfBoundaryChanged(ctx.cwd);
    const policyContext = runtime.getSnapshotForCwd(ctx.cwd);
    const decision = classifyToolDecision(event, policyContext);

    if (!decision) return undefined;

    if (decision.action === "allow") {
        appendAudit(
            buildAuditEntry({
                toolName: decision.toolName,
                category: decision.category,
                target: decision.targetPath,
                scope: "policy",
                decision: "allowed",
                reason: decision.reason,
                grantKey: decision.grantKey,
            }),
        );
        return undefined;
    }

    if (runtime.getGrantStore().hasCoverage(decision)) {
        appendAudit(
            buildAuditEntry({
                toolName: decision.toolName,
                category: decision.category,
                target: decision.targetPath,
                scope: "session-grant",
                decision: "allowed",
                reason: decision.reason,
                grantKey: decision.grantKey,
            }),
        );
        return undefined;
    }

    const prompt = buildPromptModel(decision);
    if (!ctx.hasUI || !ctx.ui.select) {
        appendAudit(
            buildAuditEntry({
                toolName: decision.toolName,
                category: decision.category,
                target: decision.targetPath,
                scope: "blocked-no-ui",
                decision: "blocked",
                reason: decision.reason,
                grantKey: decision.grantKey,
            }),
        );
        return { block: true, reason: "Approval required but no UI is available" };
    }

    const choice = await ctx.ui.select(prompt.message, prompt.options);
    if (decision.action === "ask-session") {
        if (choice === "Yes, for this session") {
            runtime.getGrantStore().rememberGrant(decision);
            appendAudit(
                buildAuditEntry({
                    toolName: decision.toolName,
                    category: decision.category,
                    target: decision.targetPath,
                    scope: "session",
                    decision: "allowed-session",
                    reason: decision.reason,
                    grantKey: decision.grantKey,
                }),
            );
            return undefined;
        }

        if (choice === "Yes, once") {
            appendAudit(
                buildAuditEntry({
                    toolName: decision.toolName,
                    category: decision.category,
                    target: decision.targetPath,
                    scope: "once",
                    decision: "allowed",
                    reason: decision.reason,
                    grantKey: decision.grantKey,
                }),
            );
            return undefined;
        }

        appendAudit(
            buildAuditEntry({
                toolName: decision.toolName,
                category: decision.category,
                target: decision.targetPath,
                scope: "session",
                decision: "blocked",
                reason: decision.reason,
                grantKey: decision.grantKey,
            }),
        );
        return { block: true, reason: "Blocked by user" };
    }

    if (choice === "Yes") {
        appendAudit(
            buildAuditEntry({
                toolName: decision.toolName,
                category: decision.category,
                target: decision.targetPath,
                scope: "ask-once",
                decision: "allowed",
                reason: decision.reason,
                grantKey: decision.grantKey,
            }),
        );
        return undefined;
    }

    appendAudit(
        buildAuditEntry({
            toolName: decision.toolName,
            category: decision.category,
            target: decision.targetPath,
            scope: "ask-once",
            decision: "blocked",
            reason: decision.reason,
            grantKey: decision.grantKey,
        }),
    );
    return { block: true, reason: "Blocked by user" };
}

export function handlePermissionsCommand(options: {
    args: string | undefined;
    runtime: RuntimeLike;
    appendAudit(entry: PermissionAuditEntry): void;
}): { kind: "cleared"; message: string } | { kind: "summary"; summary: string } {
    const action = (options.args ?? "").trim();
    if (action === "clear" || action === "reset") {
        const clearedCount = options.runtime.getGrantStore().size();
        options.runtime.getGrantStore().clear();
        options.appendAudit(
            buildAuditEntry({
                toolName: "permissions",
                category: "other-tool",
                scope: "grant-clear",
                decision: "cleared",
                reason: "manual-grant-clear",
            }),
        );
        return {
            kind: "cleared",
            message: `Cleared ${clearedCount} active permission grant(s).`,
        };
    }

    return {
        kind: "summary",
        summary: formatActiveGrants(options.runtime.getGrantStore().list()),
    };
}

export function classifyToolDecision(event: ToolCallEventLike, policyContext: PermissionGateContext): AccessDecision | null {
    if (event.toolName === "bash") {
        const command = typeof event.input.command === "string" ? event.input.command : "";
        if (!command.trim()) return null;
        return classifyBashCommand(command, policyContext);
    }

    if (PATH_READ_TOOLS.has(event.toolName)) {
        const filePath = extractPath(event.input);
        if (!filePath) return null;
        return classifyPathAccess({
            toolName: event.toolName,
            accessKind: "read",
            path: filePath,
            context: policyContext,
        });
    }

    if (PATH_BROWSE_TOOLS.has(event.toolName)) {
        const filePath = extractPath(event.input);
        return classifyPathAccess({
            toolName: event.toolName,
            accessKind: "browse",
            path: filePath ?? undefined,
            context: policyContext,
        });
    }

    if (PATH_MODIFY_TOOLS.has(event.toolName)) {
        const filePath = extractPath(event.input);
        if (!filePath) return null;
        return classifyPathAccess({
            toolName: event.toolName,
            accessKind: "modify",
            path: filePath,
            context: policyContext,
        });
    }

    return classifyOtherToolAccess(event.toolName, policyContext);
}

function extractPath(input: Record<string, unknown>): string | null {
    const value = input.path;
    return typeof value === "string" && value.trim() ? value : null;
}
