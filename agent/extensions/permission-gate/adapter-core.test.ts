import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { handlePermissionsCommand, handleToolCall, type ContextLike } from "./adapter-core.ts";
import { createRuntimeState } from "./runtime-state.ts";

function createWorkspaceFixture() {
    const root = mkdtempSync(join(tmpdir(), "permission-gate-adapter-"));
    const projectRoot = join(root, "project");
    const outsideRoot = join(root, "outside");

    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(outsideRoot, { recursive: true });

    writeFileSync(join(projectRoot, "inside.txt"), "inside-ok\n", "utf-8");
    writeFileSync(join(outsideRoot, "outside.txt"), "outside-secret\n", "utf-8");

    return { root, projectRoot, outsideRoot };
}

function createTempConfigSource(initialContent: string) {
    const root = mkdtempSync(join(tmpdir(), "permission-gate-config-"));
    const homeDir = join(root, "home");
    const configPath = join(homeDir, ".pi", "agent", "permission-gate.jsonc");
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, initialContent, "utf-8");

    return {
        homeDir,
        configPath,
        io: {
            homeDir,
            configPath,
            exists: existsSync,
            readFile: (path: string) => readFileSync(path, "utf-8"),
            writeFile: (path: string, content: string) => writeFileSync(path, content, "utf-8"),
            mkdir: (path: string) => mkdirSync(path, { recursive: true }),
        },
    };
}

function createRuntime(cwd: string) {
    const source = createTempConfigSource(JSON.stringify({ trustedRoots: ["."], sensitivePaths: [], tools: {}, bash: {} }));
    const runtime = createRuntimeState({
        io: source.io,
        parseConfigText: (text) => JSON.parse(text),
        createDefaultConfigText: () => JSON.stringify({ trustedRoots: ["."], sensitivePaths: [], tools: {}, bash: {} }),
    });
    runtime.initialize(cwd);
    return runtime;
}

function makeContext(options: {
    cwd: string;
    hasUI: boolean;
    choice?: string;
    notifications?: string[];
}): ContextLike {
    return {
        cwd: options.cwd,
        hasUI: options.hasUI,
        ui: {
            notify: (message) => {
                options.notifications?.push(message);
            },
            select: options.choice ? async () => options.choice : undefined,
        },
    };
}

test("adapter-core audits trusted-root policy allows", async () => {
    const { projectRoot } = createWorkspaceFixture();
    const runtime = createRuntime(projectRoot);
    const audits: unknown[] = [];

    const result = await handleToolCall({
        event: { toolName: "read", input: { path: join(projectRoot, "inside.txt") } },
        ctx: makeContext({ cwd: projectRoot, hasUI: false }),
        runtime,
        appendAudit: (entry) => audits.push(entry),
    });

    assert.equal(result, undefined);
    assert.equal(audits.length, 1);
    assert.deepEqual(audits[0] && {
        toolName: (audits[0] as any).toolName,
        scope: (audits[0] as any).scope,
        decision: (audits[0] as any).decision,
        reason: (audits[0] as any).reason,
    }, {
        toolName: "read",
        scope: "policy",
        decision: "allowed",
        reason: "trusted-root-read",
    });
});

test("adapter-core blocks outside-root access without UI and audits blocked-no-ui", async () => {
    const { projectRoot, outsideRoot } = createWorkspaceFixture();
    const runtime = createRuntime(projectRoot);
    const audits: unknown[] = [];

    const result = await handleToolCall({
        event: { toolName: "read", input: { path: join(outsideRoot, "outside.txt") } },
        ctx: makeContext({ cwd: projectRoot, hasUI: false }),
        runtime,
        appendAudit: (entry) => audits.push(entry),
    });

    assert.deepEqual(result, { block: true, reason: "Approval required but no UI is available" });
    assert.equal(audits.length, 1);
    assert.deepEqual(audits[0] && {
        toolName: (audits[0] as any).toolName,
        scope: (audits[0] as any).scope,
        decision: (audits[0] as any).decision,
        reason: (audits[0] as any).reason,
    }, {
        toolName: "read",
        scope: "blocked-no-ui",
        decision: "blocked",
        reason: "outside-root-read",
    });
});

test("adapter-core audits session grants both when created and when reused", async () => {
    const { projectRoot, outsideRoot } = createWorkspaceFixture();
    const runtime = createRuntime(projectRoot);
    const audits: unknown[] = [];
    const outsidePath = join(outsideRoot, "outside.txt");

    const first = await handleToolCall({
        event: { toolName: "read", input: { path: outsidePath } },
        ctx: makeContext({ cwd: projectRoot, hasUI: true, choice: "Yes, for this session" }),
        runtime,
        appendAudit: (entry) => audits.push(entry),
    });

    const second = await handleToolCall({
        event: { toolName: "read", input: { path: outsidePath } },
        ctx: makeContext({ cwd: projectRoot, hasUI: false }),
        runtime,
        appendAudit: (entry) => audits.push(entry),
    });

    assert.equal(first, undefined);
    assert.equal(second, undefined);
    assert.equal(runtime.getGrantStore().size(), 1);
    assert.deepEqual(audits.map((entry) => ({
        scope: (entry as any).scope,
        decision: (entry as any).decision,
        reason: (entry as any).reason,
    })), [
        {
            scope: "session",
            decision: "allowed-session",
            reason: "outside-root-read",
        },
        {
            scope: "session-grant",
            decision: "allowed",
            reason: "outside-root-read",
        },
    ]);
});

test("adapter-core clears grants through /permissions and subsequent access asks again", async () => {
    const { projectRoot, outsideRoot } = createWorkspaceFixture();
    const runtime = createRuntime(projectRoot);
    const audits: unknown[] = [];
    const outsidePath = join(outsideRoot, "outside.txt");

    await handleToolCall({
        event: { toolName: "read", input: { path: outsidePath } },
        ctx: makeContext({ cwd: projectRoot, hasUI: true, choice: "Yes, for this session" }),
        runtime,
        appendAudit: (entry) => audits.push(entry),
    });

    const clearResult = handlePermissionsCommand({
        args: "clear",
        runtime,
        appendAudit: (entry) => audits.push(entry),
    });

    const afterClear = await handleToolCall({
        event: { toolName: "read", input: { path: outsidePath } },
        ctx: makeContext({ cwd: projectRoot, hasUI: false }),
        runtime,
        appendAudit: (entry) => audits.push(entry),
    });

    assert.deepEqual(clearResult, {
        kind: "cleared",
        message: "Cleared 1 active permission grant(s).",
    });
    assert.equal(runtime.getGrantStore().size(), 0);
    assert.deepEqual(afterClear, { block: true, reason: "Approval required but no UI is available" });
    assert.deepEqual(audits.slice(1).map((entry) => ({
        scope: (entry as any).scope,
        decision: (entry as any).decision,
        reason: (entry as any).reason,
    })), [
        {
            scope: "grant-clear",
            decision: "cleared",
            reason: "manual-grant-clear",
        },
        {
            scope: "blocked-no-ui",
            decision: "blocked",
            reason: "outside-root-read",
        },
    ]);
});
