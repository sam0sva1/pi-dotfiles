/**
 * =============================================================================
 * Permission Gate - access control extension for Pi
 * =============================================================================
 *
 * Intercepts tool calls and bash commands, applying rules from a config file.
 * Works as a single gate - no enterprise-plugin complexity.
 *
 * --- How it works --------------------------------------------------------------
 *
 * 1. On every tool_call event, the extension checks permission.
 * 2. If permission = "ask", a three-choice dialog is shown:
 *    - Yes              - allow once
 *    - Yes, for session - remember and don't ask again until pi restarts
 *    - No               - block this time
 * 3. Session cache lives in memory and resets on new session.
 *
 * --- Permission states ---------------------------------------------------------
 *
 *   "allow"  - permit silently
 *   "ask"    - prompt user (three-choice dialog)
 *   "deny"   - block without asking
 *   "cwd"    - permit silently ONLY if path is inside working directory,
 *              otherwise fall back to "ask"
 *
 * --- Bash command check order --------------------------------------------------
 *
 *   1. Built-in destructive patterns (rm, uninstall, delete, sudo, etc.)
 *      If command is destructive -> "ask" (even if config says "allow").
 *   2. Patterns from config ("bash" section).
 *      Most specific pattern wins (by length excluding wildcards).
 *      On equal specificity - last in list wins.
 *   3. Fallback to tools.bash (default "ask").
 *
 * --- Tool check order ----------------------------------------------------------
 *
 *   1. Check tools.<name> in config.
 *   2. If "cwd" - resolve path and verify it's inside cwd.
 *   3. If not found - fallback to "ask".
 *
 * --- Config file ---------------------------------------------------------------
 *
 *   Path: ~/.pi/agent/permission-gate.jsonc
 *   Format: JSON with comments (// and block comments)
 *   Auto-created on first run with sensible defaults.
 *   Reloaded on every new session start.
 *
 * --- Session cache -------------------------------------------------------------
 *
 *   Cache keys:
 *     - bash:<normalized-command>       - for bash commands
 *     - tool:<tool-name>               - for tools
 *     - cwd-escape:<tool>:<abs-path>   - for paths outside cwd
 *
 *   "Yes, for session" saves "allow" for the key.
 *   "No" is NOT cached - blocks only once (in case you change your mind).
 *
 * --- Built-in destructive patterns ---------------------------------------------
 *
 *   These always trigger at least "ask", even if config says "allow":
 *
 *   - rm, rmdir                    - file/directory removal
 *   - uninstall, remove, delete    - destructive keywords
 *   - purge, drop, destroy         - cleanup/destruction
 *   - sudo                         - privilege escalation
 *   - chmod/chown ... 777          - unsafe permissions
 *   - mkfs, dd if=                 - low-level system operations
 *   - > /dev/                      - device write
 *   - kill, killall, pkill         - process termination
 *   - truncate                     - file truncation
 *
 * =============================================================================
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, normalize, join, sep, dirname } from "node:path";
import { homedir } from "node:os";

// --- Types -------------------------------------------------------------------

/** Permission states for tools and commands */
type Permission = "allow" | "ask" | "deny" | "cwd";

/** Config file structure */
type Config = {
    tools: Record<string, Permission>;
    bash: Record<string, Exclude<Permission, "cwd">>;
};

/** Compiled bash pattern for fast matching */
type CompiledPattern = {
    original: string;
    regex: RegExp;
    specificity: number;
    permission: Exclude<Permission, "cwd">;
};

// --- Constants ---------------------------------------------------------------

const CONFIG_PATH = join(homedir(), ".pi", "agent", "permission-gate.jsonc");

/**
 * Default config - auto-created on first run.
 *
 * Default philosophy:
 *   - read/grep/find/ls -> "cwd" (free inside project, ask outside)
 *   - write/edit -> "ask" (changes always require confirmation)
 *   - bash -> "ask" (default, overridden by patterns below)
 *   - Safe read-only bash -> "allow"
 *   - sudo -> "deny" (unconditionally blocked)
 */
const DEFAULT_CONFIG: Config = {
    tools: {
        read: "cwd",
        grep: "cwd",
        find: "cwd",
        ls: "cwd",
        write: "ask",
        edit: "ask",
        bash: "ask",
        mcp: "ask",
    },
    bash: {
        // Safe read-only commands
        "git status": "allow",
        "git diff *": "allow",
        "git log *": "allow",
        "git branch": "allow",
        "git branch --list *": "allow",
        "git remote -v": "allow",
        "ls *": "allow",
        "cat *": "allow",
        "echo *": "allow",
        "pwd": "allow",
        "which *": "allow",
        "find *": "allow",
        "grep *": "allow",
        "head *": "allow",
        "tail *": "allow",
        "wc *": "allow",
        "sort *": "allow",
        "date": "allow",
        "date *": "allow",
        "whoami": "allow",
        "uname *": "allow",
        "env": "allow",
        "printenv *": "allow",
        "type *": "allow",
        "file *": "allow",
        "stat *": "allow",
        "du *": "allow",
        "df *": "allow",
        "test *": "allow",
        "[ *": "allow",
        "basename *": "allow",
        "dirname *": "allow",
        "realpath *": "allow",
        "readlink *": "allow",
        // Commands that require confirmation
        "git *": "ask",
        "npm *": "ask",
        "npx *": "ask",
        "node *": "ask",
        "pnpm *": "ask",
        "yarn *": "ask",
        "bun *": "ask",
        "deno *": "ask",
        "pip *": "ask",
        "pip3 *": "ask",
        "python *": "ask",
        "python3 *": "ask",
        "cargo *": "ask",
        "go *": "ask",
        "make *": "ask",
        "cmake *": "ask",
        "docker *": "ask",
        "kubectl *": "ask",
        "brew *": "ask",
        "apt *": "ask",
        "apt-get *": "ask",
        "curl *": "ask",
        "wget *": "ask",
        // Blocked commands
        "sudo *": "deny",
    },
};

/**
 * Built-in destructive command patterns.
 * If a command matches, it ALWAYS gets at least "ask",
 * even if the config says "allow".
 *
 * Each element is [RegExp, human-readable description].
 */
const DESTRUCTIVE_PATTERNS: Array<[RegExp, string]> = [
    [/\brm\b/, "file removal (rm)"],
    [/\brmdir\b/, "directory removal (rmdir)"],
    [/\buninstall\b/i, "uninstall operation"],
    [/\bremove\b/i, "remove operation"],
    [/\bdelete\b/i, "delete operation"],
    [/\bpurge\b/i, "purge operation"],
    [/\bdrop\b/i, "drop operation"],
    [/\bdestroy\b/i, "destroy operation"],
    [/\bsudo\b/, "privilege escalation (sudo)"],
    [/\b(?:chmod|chown)\b.*\b777\b/, "unsafe permissions (777)"],
    [/\bmkfs\b/, "filesystem creation (mkfs)"],
    [/\bdd\s+if=/, "raw disk write (dd)"],
    [/>\s*\/dev\//, "device write (> /dev/)"],
    [/\bkill\b/, "process kill"],
    [/\bkillall\b/, "killall"],
    [/\bpkill\b/, "pkill"],
    [/\btruncate\b/, "file truncation"],
];

/** Tools that have a path in their input (for cwd checks) */
const PATH_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls"]);

// --- Helpers -----------------------------------------------------------------

/**
 * Strip comments from JSONC (// and block comments).
 * Correctly handles comments inside strings (leaves them alone).
 */
function stripJsonComments(input: string): string {
    let result = "";
    let inString = false;
    let escape = false;

    for (let i = 0; i < input.length; i++) {
        const ch = input[i];
        const next = input[i + 1];

        if (inString) {
            result += ch;
            if (escape) {
                escape = false;
            } else if (ch === "\\") {
                escape = true;
            } else if (ch === '"') {
                inString = false;
            }
            continue;
        }

        if (ch === '"') {
            inString = true;
            result += ch;
            continue;
        }

        if (ch === "/" && next === "/") {
            const eol = input.indexOf("\n", i + 2);
            i = eol === -1 ? input.length : eol - 1;
            continue;
        }

        if (ch === "/" && next === "*") {
            const end = input.indexOf("*/", i + 2);
            i = end === -1 ? input.length : end + 1;
            continue;
        }

        result += ch;
    }

    return result;
}

/**
 * Compile a wildcard pattern into a RegExp.
 * Only supports * as a wildcard (matches any substring).
 *
 * Examples:
 *   "git status"  -> /^git status$/i
 *   "git *"       -> /^git .*$/i
 *   "npm *"       -> /^npm .*$/i
 */
function compileWildcard(pattern: string): RegExp {
    const escaped = pattern
        .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`, "i");
}

/**
 * Calculate pattern specificity.
 * More "concrete" characters (not *) = more specific.
 * More specific patterns win on conflict.
 *
 * Examples:
 *   "git status"  -> 10 (very specific)
 *   "git *"       -> 3  (less specific)
 *   "*"           -> 0  (not specific at all)
 */
function calcSpecificity(pattern: string): number {
    return pattern.replace(/\*/g, "").length;
}

/**
 * Compile all bash patterns from config.
 * Returns array in config order (for last-wins on equal specificity).
 */
function compileBashPatterns(bash: Record<string, Exclude<Permission, "cwd">>): CompiledPattern[] {
    return Object.entries(bash).map(([pattern, permission]) => ({
        original: pattern,
        regex: compileWildcard(pattern),
        specificity: calcSpecificity(pattern),
        permission,
    }));
}

/**
 * Normalize a path to absolute for comparison.
 *
 * Handles:
 *   - ~/path   -> /home/user/path
 *   - ./path   -> <cwd>/path
 *   - ../path  -> <cwd>/../path (resolved)
 *   - @path    -> path (pi-specific prefix)
 */
function normalizePath(filePath: string, cwd: string): string {
    let p = filePath.trim().replace(/^['"]|['"]$/g, "");

    // Strip @ prefix (pi-specific)
    if (p.startsWith("@")) p = p.slice(1);

    // Expand ~
    if (p === "~") return homedir();
    if (p.startsWith("~/") || p.startsWith("~\\")) {
        p = join(homedir(), p.slice(2));
    }

    return normalize(resolve(cwd, p));
}

/**
 * Check if a path is inside the given directory.
 *
 * Correctly handles:
 *   - /project/src/file.ts inside /project     -> true
 *   - /project inside /project                  -> true
 *   - /project2/file.ts inside /project         -> false (not a prefix match trap)
 *   - /other/file.ts inside /project            -> false
 */
function isWithinDir(filePath: string, dir: string): boolean {
    if (filePath === dir) return true;
    const prefix = dir.endsWith(sep) ? dir : dir + sep;
    return filePath.startsWith(prefix);
}

/**
 * Extract the path from tool input.
 * Different tools store the path in different fields.
 */
function extractPath(toolName: string, input: Record<string, unknown>): string | null {
    const p = input.path;
    return typeof p === "string" && p.trim() ? p : null;
}

/**
 * Generate a cache key for a bash command.
 * Normalizes: trims and collapses whitespace.
 *
 * Examples:
 *   "  npm   install  " -> "bash:npm install"
 *   "git status"        -> "bash:git status"
 */
function bashCacheKey(command: string): string {
    return "bash:" + command.trim().replace(/\s+/g, " ");
}

// --- Extension ---------------------------------------------------------------

export default function (pi: ExtensionAPI) {
    /**
     * Session decision cache.
     * Key -> "allow" | "deny".
     * Cleared on session_start.
     */
    const sessionCache = new Map<string, "allow" | "deny">();

    /** Current config (reloaded on session_start) */
    let config: Config = DEFAULT_CONFIG;

    /** Compiled bash patterns (rebuilt on config load) */
    let compiledPatterns: CompiledPattern[] = compileBashPatterns(DEFAULT_CONFIG.bash);

    // --- Config Loading ------------------------------------------------------

    /**
     * Load config from file.
     * If file doesn't exist - creates default.
     * If file is invalid - shows warning and uses defaults.
     */
    function loadConfig(notify?: (msg: string) => void): void {
        if (!existsSync(CONFIG_PATH)) {
            createDefaultConfig();
            if (notify) notify("Permission Gate: created default config at " + CONFIG_PATH);
        }

        try {
            const raw = readFileSync(CONFIG_PATH, "utf-8");
            const parsed = JSON.parse(stripJsonComments(raw));

            config = {
                tools: { ...DEFAULT_CONFIG.tools },
                bash: { ...DEFAULT_CONFIG.bash },
            };

            // Merge tools from file
            if (parsed.tools && typeof parsed.tools === "object") {
                for (const [key, value] of Object.entries(parsed.tools)) {
                    if (isValidPermission(value)) {
                        config.tools[key] = value as Permission;
                    }
                }
            }

            // Merge bash from file - REPLACE entirely (user controls it)
            if (parsed.bash && typeof parsed.bash === "object") {
                const bashConfig: Record<string, Exclude<Permission, "cwd">> = {};
                for (const [key, value] of Object.entries(parsed.bash)) {
                    if (isValidBashPermission(value)) {
                        bashConfig[key] = value as Exclude<Permission, "cwd">;
                    }
                }
                if (Object.keys(bashConfig).length > 0) {
                    config.bash = bashConfig;
                }
            }

            compiledPatterns = compileBashPatterns(config.bash);
        } catch (err) {
            if (notify) {
                notify("Permission Gate: failed to parse config, using defaults. Error: " + String(err));
            }
            config = { ...DEFAULT_CONFIG };
            compiledPatterns = compileBashPatterns(config.bash);
        }
    }

    function isValidPermission(value: unknown): boolean {
        return value === "allow" || value === "ask" || value === "deny" || value === "cwd";
    }

    function isValidBashPermission(value: unknown): boolean {
        return value === "allow" || value === "ask" || value === "deny";
    }

    /**
     * Create default config file with detailed comments.
     */
    function createDefaultConfig(): void {
        const dir = dirname(CONFIG_PATH);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

        const content = [
            "// =============================================================================",
            "// Permission Gate - configuration",
            "// =============================================================================",
            "//",
            "// Permission states:",
            '//   "allow"  - permit silently',
            '//   "ask"    - prompt (Yes / Yes for session / No)',
            '//   "deny"   - block without asking',
            '//   "cwd"    - allow only inside working directory, otherwise "ask"',
            "//             (only for tools with paths: read, write, edit, grep, find, ls)",
            "//",
            '// Destructive bash commands (rm, delete, uninstall, sudo, etc.)',
            '// automatically get at least "ask", even if "allow" is specified here.',
            "//",
            "// Bash patterns: * = any substring. More specific pattern wins.",
            "// On equal specificity, the last one in the list wins.",
            "// =============================================================================",
            "{",
            "  // Tool permissions",
            "  \"tools\": {",
            "    \"read\": \"cwd\",      // file reading - free inside project",
            "    \"grep\": \"cwd\",      // content search - free inside project",
            "    \"find\": \"cwd\",      // file search - free inside project",
            "    \"ls\": \"cwd\",        // directory listing - free inside project",
            "    \"write\": \"ask\",     // file writing - always ask",
            "    \"edit\": \"ask\",      // file editing - always ask",
            "    \"bash\": \"ask\",      // bash default (overridden by patterns below)",
            "    \"mcp\": \"ask\"        // MCP calls - always ask",
            "  },",
            "",
            "  // Bash patterns (order matters for equal specificity!)",
            "  \"bash\": {",
            "    // --- Safe read-only commands ---",
            "    \"git status\": \"allow\",",
            "    \"git diff *\": \"allow\",",
            "    \"git log *\": \"allow\",",
            "    \"git branch\": \"allow\",",
            "    \"git branch --list *\": \"allow\",",
            "    \"git remote -v\": \"allow\",",
            "    \"ls *\": \"allow\",",
            "    \"cat *\": \"allow\",",
            "    \"echo *\": \"allow\",",
            "    \"pwd\": \"allow\",",
            "    \"which *\": \"allow\",",
            "    \"find *\": \"allow\",",
            "    \"grep *\": \"allow\",",
            "    \"head *\": \"allow\",",
            "    \"tail *\": \"allow\",",
            "    \"wc *\": \"allow\",",
            "    \"sort *\": \"allow\",",
            "    \"date\": \"allow\",",
            "    \"date *\": \"allow\",",
            "    \"whoami\": \"allow\",",
            "    \"uname *\": \"allow\",",
            "    \"env\": \"allow\",",
            "    \"printenv *\": \"allow\",",
            "    \"type *\": \"allow\",",
            "    \"file *\": \"allow\",",
            "    \"stat *\": \"allow\",",
            "    \"du *\": \"allow\",",
            "    \"df *\": \"allow\",",
            "    \"test *\": \"allow\",",
            "    \"[ *\": \"allow\",",
            "    \"basename *\": \"allow\",",
            "    \"dirname *\": \"allow\",",
            "    \"realpath *\": \"allow\",",
            "    \"readlink *\": \"allow\",",
            "",
            "    // --- Commands that require confirmation ---",
            "    \"git *\": \"ask\",",
            "    \"npm *\": \"ask\",",
            "    \"npx *\": \"ask\",",
            "    \"node *\": \"ask\",",
            "    \"pnpm *\": \"ask\",",
            "    \"yarn *\": \"ask\",",
            "    \"bun *\": \"ask\",",
            "    \"deno *\": \"ask\",",
            "    \"pip *\": \"ask\",",
            "    \"pip3 *\": \"ask\",",
            "    \"python *\": \"ask\",",
            "    \"python3 *\": \"ask\",",
            "    \"cargo *\": \"ask\",",
            "    \"go *\": \"ask\",",
            "    \"make *\": \"ask\",",
            "    \"cmake *\": \"ask\",",
            "    \"docker *\": \"ask\",",
            "    \"kubectl *\": \"ask\",",
            "    \"brew *\": \"ask\",",
            "    \"apt *\": \"ask\",",
            "    \"apt-get *\": \"ask\",",
            "    \"curl *\": \"ask\",",
            "    \"wget *\": \"ask\",",
            "",
            "    // --- Blocked commands ---",
            "    \"sudo *\": \"deny\"",
            "  }",
            "}",
            "",
        ].join("\n");

        writeFileSync(CONFIG_PATH, content, "utf-8");
    }

    // --- Permission Resolution -----------------------------------------------

    /**
     * Find bash permission for a command using config patterns.
     *
     * Algorithm:
     *   1. Iterate all compiled patterns
     *   2. Find ALL matches
     *   3. Pick the most specific match
     *   4. On equal specificity - last in list wins (last-wins)
     *   5. If no matches - null (fallback to tools.bash)
     */
    function findBashPermission(command: string): { permission: Exclude<Permission, "cwd">; pattern: string } | null {
        const normalized = command.trim();
        if (!normalized) return null;

        let bestMatch: CompiledPattern | null = null;
        let bestIndex = -1;

        for (let i = 0; i < compiledPatterns.length; i++) {
            const p = compiledPatterns[i];
            if (!p.regex.test(normalized)) continue;

            if (
                !bestMatch ||
                p.specificity > bestMatch.specificity ||
                (p.specificity === bestMatch.specificity && i >= bestIndex)
            ) {
                bestMatch = p;
                bestIndex = i;
            }
        }

        return bestMatch ? { permission: bestMatch.permission, pattern: bestMatch.original } : null;
    }

    /**
     * Check if a bash command is destructive.
     * Returns description or null.
     */
    function checkDestructive(command: string): string | null {
        for (const [pattern, description] of DESTRUCTIVE_PATTERNS) {
            if (pattern.test(command)) return description;
        }
        return null;
    }

    // --- Ask Dialog ----------------------------------------------------------

    /**
     * Show three-choice dialog: Yes / Yes, for this session / No.
     *
     * Checks session cache before showing dialog.
     * "Yes, for session" saves to cache.
     *
     * @returns true if allowed, false if blocked
     */
    async function askPermission(
        ctx: { hasUI: boolean; ui: { select: (msg: string, options: string[]) => Promise<string | undefined> } },
        message: string,
        cacheKey: string,
    ): Promise<boolean> {
        // Check cache first
        const cached = sessionCache.get(cacheKey);
        if (cached === "allow") return true;
        if (cached === "deny") return false;

        // No UI - block
        if (!ctx.hasUI) return false;

        const choice = await ctx.ui.select(message, ["Yes", "Yes, for this session", "No"]);

        switch (choice) {
            case "Yes, for this session":
                sessionCache.set(cacheKey, "allow");
                return true;
            case "Yes":
                return true;
            default:
                // "No" or Escape - block but do NOT cache
                return false;
        }
    }

    // --- Initialization ------------------------------------------------------

    loadConfig();

    /**
     * Reset cache and reload config on new session.
     */
    pi.on("session_start", async (_event, ctx) => {
        sessionCache.clear();
        loadConfig((msg) => ctx.ui.notify(msg, "info"));
    });

    /**
     * Main handler - intercept all tool calls.
     */
    pi.on("tool_call", async (event, ctx) => {
        const toolName = event.toolName;

        // --- Bash commands ---------------------------------------------------

        if (toolName === "bash" && isToolCallEventType("bash", event)) {
            const command = event.input.command;
            if (!command || !command.trim()) return undefined;

            const normalizedCmd = command.trim();
            const cacheKey = bashCacheKey(normalizedCmd);

            // 1. Check session cache FIRST
            const cached = sessionCache.get(cacheKey);
            if (cached === "allow") return undefined;
            if (cached === "deny") return { block: true, reason: "Blocked by session cache" };

            // 2. Check destructive patterns
            const destructive = checkDestructive(normalizedCmd);

            // 3. Find config pattern
            const patternMatch = findBashPermission(normalizedCmd);
            let permission: Exclude<Permission, "cwd"> =
                patternMatch?.permission ?? ((config.tools.bash as Exclude<Permission, "cwd">) || "ask");

            // 4. Destructive commands ALWAYS get at least "ask"
            if (destructive && permission === "allow") {
                permission = "ask";
            }

            // 5. Apply decision
            if (permission === "allow") return undefined;

            if (permission === "deny") {
                const reason = patternMatch
                    ? `Blocked by policy (matched '${patternMatch.pattern}')`
                    : "Blocked by policy";
                return { block: true, reason };
            }

            // permission === "ask"
            const parts: string[] = ["Bash command requires approval:"];
            parts.push("");
            parts.push(`  ${normalizedCmd}`);
            if (destructive) parts.push(`\n  Detected: ${destructive}`);
            if (patternMatch) parts.push(`  Matched pattern: '${patternMatch.pattern}'`);
            parts.push("\nAllow this command?");

            const allowed = await askPermission(ctx, parts.join("\n"), cacheKey);
            if (!allowed) return { block: true, reason: "Blocked by user" };
            return undefined;
        }

        // --- Tools with paths (read, write, edit, grep, find, ls) ------------

        if (PATH_TOOLS.has(toolName)) {
            const toolPermission = config.tools[toolName] ?? "ask";

            // Extract path
            const input = event.input as Record<string, unknown>;
            const filePath = extractPath(toolName, input);

            // Check "cwd" permission
            if (toolPermission === "cwd") {
                if (!filePath) {
                    // grep/find/ls without path = current directory -> allowed
                    if (toolName === "grep" || toolName === "find" || toolName === "ls") {
                        return undefined;
                    }
                    // read/write/edit without path - tool error, let it pass
                    return undefined;
                }

                const absPath = normalizePath(filePath, ctx.cwd);
                const normalizedCwd = normalize(resolve(ctx.cwd));

                if (isWithinDir(absPath, normalizedCwd)) {
                    return undefined; // Inside cwd -> allowed
                }

                // Outside cwd -> ask
                const cwdCacheKey = `cwd-escape:${toolName}:${absPath}`;
                const allowed = await askPermission(
                    ctx,
                    `${toolName} wants to access a path outside your project:\n\n` +
                        `  Path: ${filePath}\n` +
                        `  Resolved: ${absPath}\n` +
                        `  Project: ${normalizedCwd}\n\n` +
                        `Allow this access?`,
                    cwdCacheKey,
                );
                if (!allowed) {
                    return { block: true, reason: `Blocked: path '${filePath}' is outside working directory` };
                }
                return undefined;
            }

            // Other states
            if (toolPermission === "allow") return undefined;
            if (toolPermission === "deny") {
                return { block: true, reason: `Tool '${toolName}' is denied by policy` };
            }

            // "ask"
            const toolCacheKey = `tool:${toolName}`;
            const detail = filePath ? `\n  Path: ${filePath}` : "";
            const allowed = await askPermission(
                ctx,
                `Tool '${toolName}' requires approval:${detail}\n\nAllow this call?`,
                toolCacheKey,
            );
            if (!allowed) return { block: true, reason: "Blocked by user" };
            return undefined;
        }

        // --- Other tools (mcp, custom tools, etc.) ---------------------------

        const toolPermission = config.tools[toolName] ?? "ask";

        if (toolPermission === "allow" || toolPermission === "cwd") return undefined;
        if (toolPermission === "deny") {
            return { block: true, reason: `Tool '${toolName}' is denied by policy` };
        }

        // "ask"
        const otherCacheKey = `tool:${toolName}`;
        const allowed = await askPermission(
            ctx,
            `Tool '${toolName}' requires approval:\n\nAllow this call?`,
            otherCacheKey,
        );
        if (!allowed) return { block: true, reason: "Blocked by user" };
        return undefined;
    });
}
