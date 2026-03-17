/**
 * =============================================================================
 * Permission Gate - workspace-first ask-based gate for Pi
 * =============================================================================
 *
 * This extension keeps the runtime adapter thin and delegates policy/state work
 * to dedicated modules under `permission-gate/`.
 *
 * Runtime responsibilities:
 * - provide config file I/O to runtime-state
 * - reset ephemeral grants on session context changes
 * - deliver pending notices once UI is actually available
 * - map tool calls to core classifiers
 * - show approval prompts through `ctx.ui`
 * - persist audit entries through `pi.appendEntry()`
 * - expose `/permissions` for inspecting and clearing active grants
 *
 * Policy/state responsibilities live in the support modules:
 * - `core.ts` - trusted roots, sensitive paths, bash risk, prompts, audit
 * - `runtime-state.ts` - config loading, workspace snapshots, boundary resets
 * - `grant-store.ts` - exact vs subtree capability coverage
 * - `notice-store.ts` - delivery-aware notice buffering
 * - `adapter-core.ts` - runtime wiring for tool calls, commands, and audit
 *
 * See `./permission-gate/README.md` for behavior, architecture, invariants,
 * activation semantics, and test/runtime notes.
 *
 * Active grants are ephemeral and live only in memory.
 * Audit entries are persisted in the session JSONL as custom entries with
 * `customType = "permission-gate"`.
 *
 * =============================================================================
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { matchesKey, truncateToWidth } from "@mariozechner/pi-tui";

import { buildDefaultConfig, INITIAL_BASH_ALLOW_PATTERNS, type PermissionGateRawConfig } from "./permission-gate/core.ts";
import {
    deliverPendingNotices,
    handlePermissionsCommand,
    handleToolCall,
} from "./permission-gate/adapter-core.ts";
import { createRuntimeState, type PermissionGateRuntimeIO } from "./permission-gate/runtime-state.ts";

const HOME_DIR = homedir();
const CONFIG_PATH = join(HOME_DIR, ".pi", "agent", "permission-gate.jsonc");
const AUDIT_CUSTOM_TYPE = "permission-gate";

class PermissionGrantViewerComponent {
    constructor(
        private readonly summary: string,
        private readonly theme: Theme,
        private readonly onClose: () => void,
    ) {}

    handleInput(data: string): void {
        if (matchesKey(data, "enter") || matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
            this.onClose();
        }
    }

    render(width: number): string[] {
        const lines: string[] = [];
        lines.push("");
        lines.push(truncateToWidth(this.theme.fg("accent", this.theme.bold("Active Permission Grants")), width));
        lines.push("");
        for (const line of this.summary.split("\n")) {
            lines.push(truncateToWidth(`  ${line}`, width));
        }
        lines.push("");
        lines.push(truncateToWidth(`  ${this.theme.fg("dim", "Press Enter or Esc to close")}`, width));
        lines.push("");
        return lines;
    }
}

export default function permissionGate(pi: ExtensionAPI) {
    const io: PermissionGateRuntimeIO = {
        homeDir: HOME_DIR,
        configPath: CONFIG_PATH,
        exists: existsSync,
        readFile: (path) => readFileSync(path, "utf-8"),
        writeFile: (path, content) => writeFileSync(path, content, "utf-8"),
        mkdir: (path) => mkdirSync(path, { recursive: true }),
    };

    const runtime = createRuntimeState({
        io,
        parseConfigText,
        createDefaultConfigText: () => createDefaultConfigText(io.homeDir),
    });

    runtime.initialize(process.cwd());

    // -------------------------------------------------------------------------
    // Session lifecycle
    // -------------------------------------------------------------------------

    const resetRuntimeState = async (reason: string, ctx: ExtensionContext) => {
        runtime.resetSessionState(reason, ctx.cwd);
        deliverPendingNotices(ctx, runtime.getNoticeStore());
    };

    pi.on("session_start", async (_event, ctx) => {
        await resetRuntimeState("session_start", ctx);
    });

    pi.on("session_switch", async (_event, ctx) => {
        await resetRuntimeState("session_switch", ctx);
    });

    pi.on("session_fork", async (_event, ctx) => {
        await resetRuntimeState("session_fork", ctx);
    });

    pi.on("session_tree", async (_event, ctx) => {
        await resetRuntimeState("session_tree", ctx);
    });

    // -------------------------------------------------------------------------
    // User command
    // -------------------------------------------------------------------------

    pi.registerCommand("permissions", {
        description: "Show or clear active permission grants for the current session",
        getArgumentCompletions: (prefix) => {
            const options = ["clear", "reset"];
            const filtered = options.filter((value) => value.startsWith(prefix));
            return filtered.length > 0 ? filtered.map((value) => ({ value, label: value })) : null;
        },
        handler: async (args, ctx) => {
            deliverPendingNotices(ctx, runtime.getNoticeStore());

            const result = handlePermissionsCommand({
                args,
                runtime,
                appendAudit: (entry) => pi.appendEntry(AUDIT_CUSTOM_TYPE, entry),
            });

            if (result.kind === "cleared") {
                if (ctx.hasUI) {
                    ctx.ui.notify(result.message, "info");
                } else {
                    console.log(result.message);
                }
                return;
            }

            if (!ctx.hasUI) {
                console.log(result.summary);
                return;
            }

            await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
                return new PermissionGrantViewerComponent(result.summary, theme, () => done(undefined));
            });
        },
    });

    // -------------------------------------------------------------------------
    // Tool gate
    // -------------------------------------------------------------------------

    pi.on("tool_call", async (event, ctx) => {
        deliverPendingNotices(ctx, runtime.getNoticeStore());
        return handleToolCall({
            event: {
                toolName: event.toolName,
                input: event.input as Record<string, unknown>,
            },
            ctx,
            runtime,
            appendAudit: (entry) => pi.appendEntry(AUDIT_CUSTOM_TYPE, entry),
        });
    });
}

function parseConfigText(text: string): PermissionGateRawConfig {
    return JSON.parse(stripJsonComments(text)) as PermissionGateRawConfig;
}

function stripJsonComments(input: string): string {
    let result = "";
    let inString = false;
    let escape = false;

    for (let index = 0; index < input.length; index++) {
        const char = input[index];
        const next = input[index + 1];

        if (inString) {
            result += char;
            if (escape) {
                escape = false;
            } else if (char === "\\") {
                escape = true;
            } else if (char === '"') {
                inString = false;
            }
            continue;
        }

        if (char === '"') {
            inString = true;
            result += char;
            continue;
        }

        if (char === "/" && next === "/") {
            const end = input.indexOf("\n", index + 2);
            index = end === -1 ? input.length : end - 1;
            continue;
        }

        if (char === "/" && next === "*") {
            const end = input.indexOf("*/", index + 2);
            index = end === -1 ? input.length : end + 1;
            continue;
        }

        result += char;
    }

    return result;
}

function createDefaultConfigText(homeDir: string): string {
    const defaults = buildDefaultConfig(homeDir);
    const alwaysAskToolLines = defaults.alwaysAskTools.map((tool, index) => {
        const suffix = index === defaults.alwaysAskTools.length - 1 ? "" : ",";
        return `    ${JSON.stringify(tool)}${suffix}`;
    });

    const bashAllowlistLines = INITIAL_BASH_ALLOW_PATTERNS.map((pattern) => `    ${JSON.stringify(pattern)}: "allow",`);
    const bashEntries = [
        ...bashAllowlistLines,
        '',
        '    // Optional non-risky ask rules. Matching "ask" becomes ask-session.',
        '    // Risky syntax/families (npm, curl, pipes, redirects, sudo, etc.) still ask once only.',
        '    "git *": "ask"',
    ];

    return [
        "// =============================================================================",
        "// Permission Gate - configuration",
        "// =============================================================================",
        "//",
        "// Model summary:",
        "// - trustedRoots are resolved relative to the current session cwd",
        "// - workspace-derived policy snapshots are recomputed when cwd changes",
        "// - read/ls/find/grep inside trusted roots are allowed silently",
        "// - access outside trusted roots is asked per target",
        "// - browse grants are subtree-scoped to a canonical directory root",
        "// - edit/write are asked per file; session grants are file-scoped",
        "// - sensitive paths always ask once and are never cached",
        "// - meta-tools in alwaysAskTools always ask once and are never cached",
        "// - bash uses a small allowlist; risky commands ask once only",
        "//",
        "// Legacy notes:",
        "// - old permissions 'cwd' and 'deny' are migrated to the new ask-based model",
        "// - tools.* below is only a fallback for custom/other tools",
        "//   path tools use the root-based policy and meta-tools use alwaysAskTools",
        "// =============================================================================",
        "{",
        '  "trustedRoots": [',
        '    "."',
        "  ],",
        "",
        '  "sensitivePaths": [',
        '    ".env",',
        '    ".git/",',
        '    "~/.pi/agent/auth.json",',
        '    "~/.pi/agent/sessions/"',
        "  ],",
        "",
        '  "alwaysAskTools": [',
        ...alwaysAskToolLines,
        "  ],",
        "",
        '  "tools": {',
        '    // Fallback permissions for non-path, non-bash, non-meta custom tools.',
        '    // Example:',
        '    // "my_custom_tool": "allow"',
        "  },",
        "",
        '  "bash": {',
        '    // Initial safe allowlist.',
        ...bashEntries,
        "  }",
        "}",
        "",
    ].join("\n");
}
