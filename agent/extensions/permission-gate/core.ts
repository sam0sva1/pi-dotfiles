import { basename, dirname, join, normalize, relative, resolve, sep } from "node:path";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";

// =============================================================================
// Types
// =============================================================================

export type LegacyPermission = "allow" | "ask" | "deny" | "cwd";
export type RuntimePermission = "allow" | "ask";
export type PolicyAction = "allow" | "ask-session" | "ask-once";
export type GrantKind = "modify-file" | "read-path" | "browse-path" | "bash";
export type ToolCategory = "path-tool" | "bash" | "meta-tool" | "other-tool";
export type PathAccessKind = "read" | "browse" | "modify";

export type PermissionGateRawConfig = {
    trustedRoots?: unknown;
    sensitivePaths?: unknown;
    alwaysAskTools?: unknown;
    tools?: Record<string, unknown>;
    bash?: Record<string, unknown>;
};

export type PermissionGateNormalizedConfig = {
    trustedRoots: string[];
    sensitivePaths: string[];
    alwaysAskTools: string[];
    tools: Record<string, RuntimePermission>;
    bash: Record<string, RuntimePermission>;
    notices: string[];
};

export type PermissionGateContext = PermissionGateNormalizedConfig & {
    cwd: string;
    homeDir: string;
    trustedRoots: string[];
    sensitivePaths: string[];
    toolPermissions: Record<string, RuntimePermission>;
    bashPermissions: Record<string, RuntimePermission>;
    compiledBashPatterns: CompiledPattern[];
    initialAllowPatterns: CompiledPattern[];
    absoluteSensitivePaths: string[];
    relativeSensitivePaths: string[];
};

export type AccessDecision = {
    toolName: string;
    category: ToolCategory;
    action: PolicyAction;
    reason: string;
    targetPath?: string;
    grantKind?: GrantKind;
    grantScope?: GrantScope;
    grantKey?: string;
    messageContext: string;
};

export type PromptModel = {
    message: string;
    options: string[];
    cacheable: boolean;
};

export type AuditEntryInput = {
    toolName: string;
    category: ToolCategory;
    target?: string;
    scope: "policy" | "session-grant" | "once" | "session" | "ask-once" | "grant-clear" | "blocked-no-ui";
    decision: "allowed" | "allowed-session" | "blocked" | "cleared";
    reason: string;
    grantKey?: string;
    timestamp?: number;
};

export type PermissionAuditEntry = AuditEntryInput & {
    schemaVersion: 1;
    timestamp: number;
};

export type GrantScope = "exact" | "subtree";

export type ActiveGrant = {
    kind: GrantKind;
    scope: GrantScope;
    key: string;
    toolName: string;
    category: ToolCategory;
    target: string;
    reason: string;
    createdAt: number;
};

type CompiledPattern = {
    original: string;
    regex: RegExp;
    specificity: number;
    permission: RuntimePermission;
};

// =============================================================================
// Constants
// =============================================================================

export const PATH_READ_TOOLS = new Set(["read"]);
export const PATH_BROWSE_TOOLS = new Set(["ls", "find", "grep"]);
export const PATH_MODIFY_TOOLS = new Set(["edit", "write"]);
export const PATH_TOOLS = new Set([...PATH_READ_TOOLS, ...PATH_BROWSE_TOOLS, ...PATH_MODIFY_TOOLS]);

export const DEFAULT_ALWAYS_ASK_TOOLS = [
    "mcp",
    "subagent",
    "subagent_status",
    "team_create",
    "spawn_teammate",
    "spawn_lead_window",
    "send_message",
    "broadcast_message",
    "read_inbox",
    "task_create",
    "task_submit_plan",
    "task_evaluate_plan",
    "task_list",
    "task_update",
    "team_shutdown",
    "task_read",
    "check_teammate",
    "process_shutdown_approved",
] as const;

export const INITIAL_BASH_ALLOW_PATTERNS = [
    "pwd",
    "git status",
    "git diff *",
    "git log *",
    "git branch",
    "git branch --list *",
    "git remote -v",
] as const;

const RISKY_BASH_FAMILY_PATTERNS: RegExp[] = [
    /^npm\b/i,
    /^npx\b/i,
    /^node\b/i,
    /^pnpm\b/i,
    /^yarn\b/i,
    /^bun\b/i,
    /^deno\b/i,
    /^pip3?\b/i,
    /^python3?\b/i,
    /^cargo\b/i,
    /^go\b/i,
    /^make\b/i,
    /^cmake\b/i,
    /^docker\b/i,
    /^kubectl\b/i,
    /^brew\b/i,
    /^apt(-get)?\b/i,
    /^curl\b/i,
    /^wget\b/i,
];

const RISKY_BASH_SYNTAX_PATTERNS: RegExp[] = [/[|]/, /&&/, /\|\|/, /;/, />/, /</, /\$\(/, /`/];

const DESTRUCTIVE_BASH_PATTERNS: Array<[RegExp, string]> = [
    [/\brm\b/, "file-removal"],
    [/\brmdir\b/, "directory-removal"],
    [/\buninstall\b/i, "uninstall"],
    [/\bremove\b/i, "remove"],
    [/\bdelete\b/i, "delete"],
    [/\bpurge\b/i, "purge"],
    [/\bdrop\b/i, "drop"],
    [/\bdestroy\b/i, "destroy"],
    [/\bsudo\b/, "sudo"],
    [/\b(?:chmod|chown)\b.*\b777\b/, "unsafe-permissions"],
    [/\bmkfs\b/, "mkfs"],
    [/\bdd\s+if=/, "dd"],
    [/>\s*\/dev\//, "device-write"],
    [/\bkill\b/, "kill"],
    [/\bkillall\b/, "killall"],
    [/\bpkill\b/, "pkill"],
    [/\btruncate\b/, "truncate"],
];

// =============================================================================
// Default config
// =============================================================================

export function buildDefaultConfig(homeDir = homedir()): PermissionGateNormalizedConfig {
    return {
        trustedRoots: ["."],
        sensitivePaths: [".env", ".git/", join(homeDir, ".pi", "agent", "auth.json"), join(homeDir, ".pi", "agent", "sessions")],
        alwaysAskTools: [...DEFAULT_ALWAYS_ASK_TOOLS],
        tools: {},
        bash: Object.fromEntries(INITIAL_BASH_ALLOW_PATTERNS.map((pattern) => [pattern, "allow"])),
        notices: [],
    };
}

// =============================================================================
// Config normalization
// =============================================================================

export function createPolicyContext(rawConfig: PermissionGateRawConfig | undefined, options: { cwd: string; homeDir?: string }): PermissionGateContext {
    const homeDir = options.homeDir ?? homedir();
    const defaults = buildDefaultConfig(homeDir);
    const notices = new Set<string>();

    const trustedRoots = normalizeStringArray(rawConfig?.trustedRoots, defaults.trustedRoots, { fallbackOnEmpty: true });
    const sensitivePaths = normalizeStringArray(rawConfig?.sensitivePaths, defaults.sensitivePaths, { fallbackOnEmpty: false });
    const alwaysAskTools = normalizeStringArray(rawConfig?.alwaysAskTools, defaults.alwaysAskTools, { fallbackOnEmpty: false });

    const tools = normalizeToolPermissions(rawConfig?.tools, defaults.tools, notices);
    const bash = normalizeBashPermissions(rawConfig?.bash, defaults.bash, notices);

    const resolvedTrustedRoots = dedupe(
        trustedRoots.map((root) => resolvePathTarget(root, options.cwd, homeDir)).map((root) => normalize(root)),
    );

    const sensitiveMatchers = buildSensitiveMatchers(sensitivePaths, resolvedTrustedRoots, options.cwd, homeDir);

    const toolPermissions: Record<string, RuntimePermission> = { ...tools };
    for (const toolName of alwaysAskTools) {
        toolPermissions[toolName] = "ask";
    }

    return {
        cwd: options.cwd,
        homeDir,
        trustedRoots: resolvedTrustedRoots.length > 0 ? resolvedTrustedRoots : [normalize(options.cwd)],
        sensitivePaths: [...sensitiveMatchers.publicEntries],
        absoluteSensitivePaths: sensitiveMatchers.absolute,
        relativeSensitivePaths: sensitiveMatchers.relative,
        alwaysAskTools,
        tools: toolPermissions,
        toolPermissions,
        bash,
        bashPermissions: bash,
        notices: [...notices],
        compiledBashPatterns: compilePatterns(bash),
        initialAllowPatterns: compilePatterns(Object.fromEntries(INITIAL_BASH_ALLOW_PATTERNS.map((pattern) => [pattern, "allow"]))),
    };
}

function normalizeStringArray(value: unknown, fallback: string[], options: { fallbackOnEmpty: boolean }): string[] {
    if (!Array.isArray(value)) return [...fallback];
    const normalized = value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
    if (normalized.length === 0) {
        return options.fallbackOnEmpty ? [...fallback] : [];
    }
    return dedupe(normalized);
}

function normalizeToolPermissions(
    value: Record<string, unknown> | undefined,
    fallback: Record<string, RuntimePermission>,
    notices: Set<string>,
): Record<string, RuntimePermission> {
    const normalized: Record<string, RuntimePermission> = { ...fallback };
    if (!value || typeof value !== "object") return normalized;

    for (const [toolName, permission] of Object.entries(value)) {
        const next = normalizeLegacyPermission(permission, `tools.${toolName}`, notices, { supportsCwdMigration: true });
        if (next) normalized[toolName] = next;
    }
    return normalized;
}

function normalizeBashPermissions(
    value: Record<string, unknown> | undefined,
    fallback: Record<string, RuntimePermission>,
    notices: Set<string>,
): Record<string, RuntimePermission> {
    if (!value || typeof value !== "object") return { ...fallback };

    const normalized: Record<string, RuntimePermission> = {};
    for (const [pattern, permission] of Object.entries(value)) {
        const next = normalizeLegacyPermission(permission, `bash.${pattern}`, notices, { supportsCwdMigration: false });
        if (next) normalized[pattern] = next;
    }
    return Object.keys(normalized).length > 0 ? normalized : { ...fallback };
}

function normalizeLegacyPermission(
    value: unknown,
    label: string,
    notices: Set<string>,
    options: { supportsCwdMigration: boolean },
): RuntimePermission | undefined {
    if (value === "allow" || value === "ask") return value;
    if (value === "deny") {
        notices.add(`Permission Gate: legacy 'deny' in ${label} is migrated to 'ask'.`);
        return "ask";
    }
    if (value === "cwd") {
        notices.add(
            options.supportsCwdMigration
                ? `Permission Gate: legacy 'cwd' in ${label} is migrated to the root-based policy.`
                : `Permission Gate: legacy 'cwd' in ${label} is migrated to 'ask'.`,
        );
        return "ask";
    }
    return undefined;
}

// =============================================================================
// Path resolution / classification
// =============================================================================

type SensitiveMatcherState = {
    absolute: string[];
    relative: string[];
    publicEntries: string[];
};

function buildSensitiveMatchers(
    entries: string[],
    trustedRoots: string[],
    cwd: string,
    homeDir: string,
): SensitiveMatcherState {
    const absolute = new Set<string>();
    const relative = new Set<string>();
    const publicEntries = new Set<string>();

    for (const entry of entries) {
        if (isAbsoluteLike(entry)) {
            const resolved = resolvePathTarget(entry, cwd, homeDir);
            absolute.add(trimTrailingSep(normalize(resolved)));
            publicEntries.add(trimTrailingSep(normalize(resolved)));
        } else {
            const normalizedEntry = normalizeRelativePrefix(entry);
            relative.add(normalizedEntry);
            publicEntries.add(normalizedEntry);
        }
    }

    // If there are no trusted roots, relative entries cannot match meaningfully.
    if (trustedRoots.length === 0) {
        return { absolute: [...absolute], relative: [], publicEntries: [...publicEntries] };
    }

    return {
        absolute: [...absolute],
        relative: [...relative],
        publicEntries: [...publicEntries],
    };
}

export function resolvePathTarget(inputPath: string, cwd: string, homeDir = homedir()): string {
    let candidate = sanitizePathInput(inputPath, cwd, homeDir);
    candidate = normalize(candidate);

    if (existsSync(candidate)) {
        return normalize(realpathSync(candidate));
    }

    const missingParts: string[] = [];
    let cursor = candidate;

    while (!existsSync(cursor)) {
        const parent = dirname(cursor);
        if (parent === cursor) {
            return normalize(candidate);
        }
        missingParts.unshift(basename(cursor));
        cursor = parent;
    }

    let resolvedBase = normalize(realpathSync(cursor));
    for (const part of missingParts) {
        resolvedBase = normalize(join(resolvedBase, part));
    }
    return resolvedBase;
}

export function resolveBrowseTarget(inputPath: string, cwd: string, homeDir = homedir()): string {
    const resolved = resolvePathTarget(inputPath, cwd, homeDir);
    if (!existsSync(resolved)) return resolved;
    const stat = statSync(resolved);
    return stat.isDirectory() ? resolved : dirname(resolved);
}

export function classifyPathAccess(params: {
    toolName: string;
    accessKind: PathAccessKind;
    path: string | undefined;
    context: PermissionGateContext;
}): AccessDecision {
    const targetPath =
        params.accessKind === "browse"
            ? resolveBrowseTarget(params.path ?? params.context.cwd, params.context.cwd, params.context.homeDir)
            : resolvePathTarget(params.path ?? params.context.cwd, params.context.cwd, params.context.homeDir);
    const sensitive = isSensitivePath(targetPath, params.context);
    const trusted = isWithinTrustedRoot(targetPath, params.context.trustedRoots);

    if (sensitive) {
        return {
            toolName: params.toolName,
            category: "path-tool",
            action: "ask-once",
            reason: "sensitive-path",
            targetPath,
            messageContext: `Sensitive path access requires approval for ${params.toolName}. No session grant will be created.`,
        };
    }

    if (params.accessKind === "modify") {
        return {
            toolName: params.toolName,
            category: "path-tool",
            action: "ask-session",
            reason: trusted ? "modify-file" : "modify-file-outside-root",
            targetPath,
            grantKind: "modify-file",
            grantScope: "exact",
            grantKey: buildGrantKey("modify-file", targetPath),
            messageContext: `File modification requires approval for ${params.toolName}.`,
        };
    }

    if (params.accessKind === "browse") {
        if (trusted) {
            return {
                toolName: params.toolName,
                category: "path-tool",
                action: "allow",
                reason: "trusted-root-browse",
                targetPath,
                messageContext: `Browse target is inside trusted roots.`,
            };
        }

        return {
            toolName: params.toolName,
            category: "path-tool",
            action: "ask-session",
            reason: "outside-root-browse",
            targetPath,
            grantKind: "browse-path",
            grantScope: "subtree",
            grantKey: buildGrantKey("browse-path", targetPath),
            messageContext: `Browse target is outside trusted roots. Session approval will cover this directory subtree only.`,
        };
    }

    if (trusted) {
        return {
            toolName: params.toolName,
            category: "path-tool",
            action: "allow",
            reason: "trusted-root-read",
            targetPath,
            messageContext: `Read target is inside trusted roots.`,
        };
    }

    return {
        toolName: params.toolName,
        category: "path-tool",
        action: "ask-session",
        reason: "outside-root-read",
        targetPath,
        grantKind: "read-path",
        grantScope: "exact",
        grantKey: buildGrantKey("read-path", targetPath),
        messageContext: `Read target is outside trusted roots.`,
    };
}

export function isWithinTrustedRoot(targetPath: string, trustedRoots: string[]): boolean {
    return trustedRoots.some((root) => isPathWithinPrefix(targetPath, root));
}

export function buildWorkspaceSignature(context: PermissionGateContext): string {
    return JSON.stringify({
        schemaVersion: 1,
        trustedRoots: [...context.trustedRoots].sort(),
        absoluteSensitivePaths: [...context.absoluteSensitivePaths].sort(),
        relativeSensitivePaths: [...context.relativeSensitivePaths].sort(),
    });
}

function isSensitivePath(targetPath: string, context: PermissionGateContext): boolean {
    const normalizedTarget = trimTrailingSep(normalize(targetPath));

    if (context.absoluteSensitivePaths.some((prefix) => isPathWithinPrefix(normalizedTarget, prefix))) {
        return true;
    }

    for (const root of context.trustedRoots) {
        if (!isPathWithinPrefix(normalizedTarget, root)) continue;
        const rel = normalize(relative(root, normalizedTarget));
        if (!rel || rel.startsWith("..") || rel === ".") continue;

        if (context.relativeSensitivePaths.some((prefix) => isRelativePrefixMatch(rel, prefix))) {
            return true;
        }
    }

    return false;
}

function isRelativePrefixMatch(relativePathValue: string, prefix: string): boolean {
    const rel = trimTrailingSep(relativePathValue);
    const normalizedPrefix = trimTrailingSep(prefix);
    return rel === normalizedPrefix || rel.startsWith(normalizedPrefix + sep);
}

function isPathWithinPrefix(targetPath: string, prefix: string): boolean {
    const normalizedTarget = trimTrailingSep(normalize(targetPath));
    const normalizedPrefix = trimTrailingSep(normalize(prefix));
    return normalizedTarget === normalizedPrefix || normalizedTarget.startsWith(normalizedPrefix + sep);
}

function sanitizePathInput(inputPath: string, cwd: string, homeDir: string): string {
    let value = inputPath.trim().replace(/^['"]|['"]$/g, "");
    if (value.startsWith("@")) value = value.slice(1);
    if (value === "~") return homeDir;
    if (value.startsWith("~/") || value.startsWith("~\\")) {
        value = join(homeDir, value.slice(2));
    }
    return resolve(cwd, value);
}

function isAbsoluteLike(value: string): boolean {
    return value.startsWith("/") || value.startsWith("~/") || value.startsWith("~\\");
}

function normalizeRelativePrefix(value: string): string {
    return trimTrailingSep(value.trim().replace(/^\.\//, ""));
}

function trimTrailingSep(value: string): string {
    if (value.length <= 1) return value;
    return value.endsWith(sep) ? value.slice(0, -1) : value;
}

// =============================================================================
// Bash classification
// =============================================================================

export function classifyBashCommand(command: string, context: PermissionGateContext): AccessDecision {
    const normalizedCommand = normalizeCommand(command);

    if (matchesAnyPattern(normalizedCommand, context.initialAllowPatterns)) {
        return {
            toolName: "bash",
            category: "bash",
            action: "allow",
            reason: "initial-bash-allowlist",
            targetPath: normalizedCommand,
            messageContext: `Bash command matches the initial allowlist.`,
        };
    }

    if (isRiskyBashCommand(normalizedCommand)) {
        return {
            toolName: "bash",
            category: "bash",
            action: "ask-once",
            reason: "risky-bash",
            targetPath: normalizedCommand,
            messageContext: `Risky bash command requires approval. No session grant will be created.`,
        };
    }

    const configMatch = findPatternMatch(normalizedCommand, context.compiledBashPatterns);
    if (configMatch?.permission === "allow") {
        return {
            toolName: "bash",
            category: "bash",
            action: "allow",
            reason: `config-bash-allow:${configMatch.original}`,
            targetPath: normalizedCommand,
            messageContext: `Bash command matches an allow rule.`,
        };
    }

    return {
        toolName: "bash",
        category: "bash",
        action: "ask-session",
        reason: configMatch ? `config-bash-ask:${configMatch.original}` : "default-bash-ask",
        targetPath: normalizedCommand,
        grantKind: "bash",
        grantScope: "exact",
        grantKey: buildGrantKey("bash", normalizedCommand),
        messageContext: `Bash command requires approval. If allowed for this session, only this exact command will be remembered.`,
    };
}

export function normalizeCommand(command: string): string {
    return command.trim().replace(/\s+/g, " ");
}

function isRiskyBashCommand(command: string): boolean {
    if (RISKY_BASH_SYNTAX_PATTERNS.some((pattern) => pattern.test(command))) return true;
    if (RISKY_BASH_FAMILY_PATTERNS.some((pattern) => pattern.test(command))) return true;
    if (DESTRUCTIVE_BASH_PATTERNS.some(([pattern]) => pattern.test(command))) return true;
    return false;
}

function compilePatterns(patterns: Record<string, RuntimePermission>): CompiledPattern[] {
    return Object.entries(patterns).map(([pattern, permission]) => ({
        original: pattern,
        regex: compileWildcard(pattern),
        specificity: calcSpecificity(pattern),
        permission,
    }));
}

function compileWildcard(pattern: string): RegExp {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`, "i");
}

function calcSpecificity(pattern: string): number {
    return pattern.replace(/\*/g, "").length;
}

function findPatternMatch(command: string, patterns: CompiledPattern[]): CompiledPattern | undefined {
    let best: CompiledPattern | undefined;
    let bestIndex = -1;

    for (let index = 0; index < patterns.length; index++) {
        const pattern = patterns[index];
        if (!pattern.regex.test(command)) continue;

        if (!best || pattern.specificity > best.specificity || (pattern.specificity === best.specificity && index >= bestIndex)) {
            best = pattern;
            bestIndex = index;
        }
    }

    return best;
}

function matchesAnyPattern(command: string, patterns: CompiledPattern[]): boolean {
    return patterns.some((pattern) => pattern.regex.test(command));
}

// =============================================================================
// Tool classification
// =============================================================================

export function classifyToolCategory(toolName: string, context: PermissionGateContext): ToolCategory {
    if (toolName === "bash") return "bash";
    if (PATH_TOOLS.has(toolName)) return "path-tool";
    if (context.alwaysAskTools.includes(toolName)) return "meta-tool";
    return "other-tool";
}

export function classifyOtherToolAccess(toolName: string, context: PermissionGateContext): AccessDecision {
    const category = classifyToolCategory(toolName, context);
    if (category === "meta-tool") {
        return {
            toolName,
            category,
            action: "ask-once",
            reason: "meta-tool",
            messageContext: `Meta-tool '${toolName}' requires approval and is never cached.`,
        };
    }

    const permission = context.toolPermissions[toolName] ?? "ask";
    if (permission === "allow") {
        return {
            toolName,
            category: "other-tool",
            action: "allow",
            reason: "tool-config-allow",
            messageContext: `Tool '${toolName}' is allowed by config.`,
        };
    }

    return {
        toolName,
        category: "other-tool",
        action: "ask-once",
        reason: "tool-config-ask",
        messageContext: `Tool '${toolName}' requires approval. No session grant will be created.`,
    };
}

// =============================================================================
// Grants / prompts / audit
// =============================================================================

export function buildGrantKey(kind: GrantKind, target: string): string {
    return `${kind}:${kind === "bash" ? normalizeCommand(target) : normalize(target)}`;
}

export function buildPromptModel(decision: AccessDecision): PromptModel {
    if (decision.action === "ask-session") {
        const targetLine = decision.targetPath ? `\n\nTarget:\n  ${decision.targetPath}` : "";
        const rememberLine =
            decision.grantScope === "subtree"
                ? "If you allow it for this session, only this directory subtree will be remembered."
                : "If you allow it for this session, only this exact target/command will be remembered.";
        return {
            cacheable: true,
            options: ["Yes, once", "Yes, for this session", "No"],
            message: `${decision.messageContext}${targetLine}\n\n${rememberLine}`,
        };
    }

    return {
        cacheable: false,
        options: ["Yes", "No"],
        message: `${decision.messageContext}${decision.targetPath ? `\n\nTarget:\n  ${decision.targetPath}` : ""}`,
    };
}

export function buildAuditEntry(input: AuditEntryInput): PermissionAuditEntry {
    return {
        schemaVersion: 1,
        timestamp: input.timestamp ?? Date.now(),
        ...input,
    };
}

export function formatActiveGrants(grants: ActiveGrant[]): string {
    if (grants.length === 0) {
        return "No active permission grants in the current session.";
    }

    const lines = [`Active permission grants: ${grants.length}`];
    for (const grant of grants.sort((a, b) => a.createdAt - b.createdAt)) {
        lines.push(`- [${grant.kind} / ${grant.scope}] ${grant.target}`);
        lines.push(`  tool: ${grant.toolName}`);
        lines.push(`  key: ${grant.key}`);
        lines.push(`  reason: ${grant.reason}`);
    }
    return lines.join("\n");
}

// =============================================================================
// Utilities
// =============================================================================

function dedupe(values: string[]): string[] {
    return [...new Set(values)];
}
