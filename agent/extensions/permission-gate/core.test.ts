import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
    buildAuditEntry,
    buildGrantKey,
    buildPromptModel,
    buildWorkspaceSignature,
    classifyBashCommand,
    classifyOtherToolAccess,
    classifyPathAccess,
    createPolicyContext,
    formatActiveGrants,
    resolvePathTarget,
} from "./core.ts";

function createWorkspaceFixture() {
    const root = mkdtempSync(join(tmpdir(), "permission-gate-"));
    const projectRoot = join(root, "project");
    const outsideRoot = join(root, "outside");

    mkdirSync(join(projectRoot, "src"), { recursive: true });
    mkdirSync(join(projectRoot, ".git"), { recursive: true });
    mkdirSync(outsideRoot, { recursive: true });

    writeFileSync(join(projectRoot, "src", "file.ts"), "export const ok = true;\n");
    writeFileSync(join(projectRoot, ".env"), "TOKEN=secret\n");
    writeFileSync(join(projectRoot, ".git", "config"), "[core]\nrepositoryformatversion = 0\n");
    writeFileSync(join(outsideRoot, "notes.txt"), "outside\n");

    symlinkSync(outsideRoot, join(projectRoot, "linked-outside"));

    return { root, projectRoot, outsideRoot };
}

test("createPolicyContext migrates legacy deny/cwd and resolves defaults", () => {
    const cwd = "/work/project";
    const homeDir = "/Users/tester";

    const context = createPolicyContext(
        {
            tools: {
                read: "cwd",
                custom_allow: "allow",
                custom_deny: "deny",
                custom_cwd: "cwd",
                mcp: "allow",
            },
            bash: {
                "git status": "allow",
                "sudo *": "deny",
            },
        },
        { cwd, homeDir },
    );

    assert.ok(context.notices.some((notice) => notice.includes("deny")));
    assert.ok(context.notices.some((notice) => notice.includes("cwd")));
    assert.deepEqual(context.trustedRoots, [cwd]);
    assert.equal(context.toolPermissions.custom_allow, "allow");
    assert.equal(context.toolPermissions.custom_deny, "ask");
    assert.equal(context.toolPermissions.custom_cwd, "ask");
    assert.equal(context.toolPermissions.mcp, "ask");
    assert.equal(context.bashPermissions["sudo *"], "ask");
    assert.ok(context.alwaysAskTools.includes("mcp"));
    assert.ok(context.sensitivePaths.some((path) => path === resolve(homeDir, ".pi/agent/auth.json")));
});

test("classifyPathAccess allows read inside trusted root, asks outside root, and asks-once for sensitive paths", () => {
    const { projectRoot, outsideRoot } = createWorkspaceFixture();
    const context = createPolicyContext(undefined, { cwd: projectRoot, homeDir: "/Users/tester" });

    const insideRead = classifyPathAccess({
        toolName: "read",
        accessKind: "read",
        path: join(projectRoot, "src", "file.ts"),
        context,
    });
    assert.equal(insideRead.action, "allow");
    assert.equal(insideRead.reason, "trusted-root-read");

    const outsideRead = classifyPathAccess({
        toolName: "read",
        accessKind: "read",
        path: join(outsideRoot, "notes.txt"),
        context,
    });
    assert.equal(outsideRead.action, "ask-session");
    assert.equal(outsideRead.reason, "outside-root-read");
    assert.equal(outsideRead.grantKind, "read-path");
    assert.equal(outsideRead.grantScope, "exact");
    assert.equal(outsideRead.grantKey, buildGrantKey("read-path", outsideRead.targetPath!));

    const sensitiveRead = classifyPathAccess({
        toolName: "read",
        accessKind: "read",
        path: join(projectRoot, ".env"),
        context,
    });
    assert.equal(sensitiveRead.action, "ask-once");
    assert.equal(sensitiveRead.reason, "sensitive-path");
    assert.equal(sensitiveRead.grantKey, undefined);
});

test("classifyPathAccess detects symlink escape and grants modify per file", () => {
    const { projectRoot, outsideRoot } = createWorkspaceFixture();
    const context = createPolicyContext(undefined, { cwd: projectRoot, homeDir: "/Users/tester" });

    const symlinkedRead = classifyPathAccess({
        toolName: "read",
        accessKind: "read",
        path: join(projectRoot, "linked-outside", "notes.txt"),
        context,
    });
    assert.equal(symlinkedRead.action, "ask-session");
    assert.ok(symlinkedRead.targetPath?.endsWith(`${join("outside", "notes.txt")}`));

    const modifyInside = classifyPathAccess({
        toolName: "edit",
        accessKind: "modify",
        path: join(projectRoot, "src", "file.ts"),
        context,
    });
    assert.equal(modifyInside.action, "ask-session");
    assert.equal(modifyInside.grantKind, "modify-file");
    assert.equal(modifyInside.grantScope, "exact");
    assert.equal(modifyInside.grantKey, buildGrantKey("modify-file", modifyInside.targetPath!));

    const modifySensitive = classifyPathAccess({
        toolName: "write",
        accessKind: "modify",
        path: join(projectRoot, ".env"),
        context,
    });
    assert.equal(modifySensitive.action, "ask-once");
    assert.equal(modifySensitive.grantKey, undefined);
});

test("classifyPathAccess for browse targets uses canonical directory roots for subtree grants", () => {
    const { projectRoot, outsideRoot } = createWorkspaceFixture();
    const context = createPolicyContext(undefined, { cwd: projectRoot, homeDir: "/Users/tester" });

    const canonicalOutsideRoot = resolvePathTarget(outsideRoot, projectRoot, "/Users/tester");

    const browseOutside = classifyPathAccess({
        toolName: "find",
        accessKind: "browse",
        path: outsideRoot,
        context,
    });
    assert.equal(browseOutside.action, "ask-session");
    assert.equal(browseOutside.reason, "outside-root-browse");
    assert.equal(browseOutside.grantKind, "browse-path");
    assert.equal(browseOutside.grantScope, "subtree");
    assert.equal(browseOutside.targetPath, canonicalOutsideRoot);
    assert.equal(browseOutside.grantKey, buildGrantKey("browse-path", browseOutside.targetPath!));

    const browseFileOutside = classifyPathAccess({
        toolName: "grep",
        accessKind: "browse",
        path: join(outsideRoot, "notes.txt"),
        context,
    });
    assert.equal(browseFileOutside.action, "ask-session");
    assert.equal(browseFileOutside.grantKind, "browse-path");
    assert.equal(browseFileOutside.grantScope, "subtree");
    assert.equal(browseFileOutside.targetPath, canonicalOutsideRoot);
    assert.equal(browseFileOutside.grantKey, buildGrantKey("browse-path", canonicalOutsideRoot));

    const browseDefault = classifyPathAccess({
        toolName: "ls",
        accessKind: "browse",
        path: undefined,
        context,
    });
    assert.equal(browseDefault.action, "allow");
    assert.ok(browseDefault.targetPath?.endsWith(join("project")));
});

test("classifyBashCommand applies allowlist, ask-session and ask-once precedence", () => {
    const context = createPolicyContext(undefined, { cwd: "/work/project", homeDir: "/Users/tester" });

    assert.equal(classifyBashCommand("pwd", context).action, "allow");
    assert.equal(classifyBashCommand("git diff HEAD~1", context).action, "allow");

    const gitCheckout = classifyBashCommand("git checkout main", context);
    assert.equal(gitCheckout.action, "ask-session");
    assert.equal(gitCheckout.grantKind, "bash");
    assert.equal(gitCheckout.grantScope, "exact");
    assert.equal(gitCheckout.grantKey, buildGrantKey("bash", "git checkout main"));

    assert.equal(classifyBashCommand("npm test", context).action, "ask-once");
    assert.equal(classifyBashCommand("curl https://example.com", context).action, "ask-once");
    assert.equal(classifyBashCommand("cat a.txt | head", context).action, "ask-once");
    assert.equal(classifyBashCommand("sudo ls", context).action, "ask-once");
});

test("classifyOtherToolAccess allows configured custom tools and always asks meta-tools", () => {
    const context = createPolicyContext(
        {
            tools: {
                custom_allow: "allow",
                custom_ask: "ask",
                mcp: "allow",
            },
        },
        { cwd: "/work/project", homeDir: "/Users/tester" },
    );

    assert.equal(classifyOtherToolAccess("custom_allow", context).action, "allow");
    assert.equal(classifyOtherToolAccess("custom_ask", context).action, "ask-once");
    assert.equal(classifyOtherToolAccess("mcp", context).action, "ask-once");
    assert.equal(classifyOtherToolAccess("subagent", context).action, "ask-once");
});

test("buildPromptModel exposes correct choices and subtree wording for grants", () => {
    const askSessionPrompt = buildPromptModel({
        toolName: "edit",
        action: "ask-session",
        reason: "modify-file",
        targetPath: "/work/project/src/file.ts",
        grantKey: buildGrantKey("modify-file", "/work/project/src/file.ts"),
        messageContext: "Modify file",
    });

    assert.deepEqual(askSessionPrompt.options, ["Yes, once", "Yes, for this session", "No"]);
    assert.equal(askSessionPrompt.cacheable, true);
    assert.ok(askSessionPrompt.message.includes("/work/project/src/file.ts"));
    assert.ok(askSessionPrompt.message.includes("only this exact target/command"));

    const browsePrompt = buildPromptModel({
        toolName: "find",
        action: "ask-session",
        reason: "outside-root-browse",
        targetPath: "/outside/project-a",
        grantKind: "browse-path",
        grantScope: "subtree",
        grantKey: "opaque-browse-grant",
        messageContext: "Browse target is outside trusted roots.",
    });

    assert.ok(browsePrompt.message.includes("subtree"));
    assert.ok(browsePrompt.message.includes("/outside/project-a"));

    const askOncePrompt = buildPromptModel({
        toolName: "bash",
        action: "ask-once",
        reason: "risky-bash",
        targetPath: "npm test",
        messageContext: "Risky bash command",
    });

    assert.deepEqual(askOncePrompt.options, ["Yes", "No"]);
    assert.equal(askOncePrompt.cacheable, false);
});

test("buildWorkspaceSignature is deterministic and changes with trust boundary", () => {
    const homeDir = "/Users/tester";
    const contextA = createPolicyContext(undefined, { cwd: "/work/project-a", homeDir });
    const contextA2 = createPolicyContext(undefined, { cwd: "/work/project-a", homeDir });
    const contextB = createPolicyContext(undefined, { cwd: "/work/project-b", homeDir });

    assert.equal(buildWorkspaceSignature(contextA), buildWorkspaceSignature(contextA2));
    assert.notEqual(buildWorkspaceSignature(contextA), buildWorkspaceSignature(contextB));
});

test("formatActiveGrants describes structured exact and subtree capabilities", () => {
    const summary = formatActiveGrants([
        {
            kind: "browse-path",
            scope: "subtree",
            key: buildGrantKey("browse-path", "/tmp/outside/project-a"),
            toolName: "find",
            category: "path-tool",
            target: "/tmp/outside/project-a",
            reason: "outside-root-browse",
            createdAt: 1,
        },
        {
            kind: "modify-file",
            scope: "exact",
            key: buildGrantKey("modify-file", "/tmp/project/file.ts"),
            toolName: "edit",
            category: "path-tool",
            target: "/tmp/project/file.ts",
            reason: "modify-file",
            createdAt: 2,
        },
    ]);

    assert.ok(summary.includes("browse-path"));
    assert.ok(summary.includes("subtree"));
    assert.ok(summary.includes("modify-file"));
    assert.ok(summary.includes("exact"));
    assert.ok(summary.includes("/tmp/outside/project-a"));
});

test("buildAuditEntry emits versioned payload", () => {
    const entry = buildAuditEntry({
        toolName: "read",
        category: "path-tool",
        target: "/tmp/file.txt",
        scope: "session",
        decision: "allowed-session",
        reason: "outside-root-read",
        grantKey: buildGrantKey("read-path", "/tmp/file.txt"),
        timestamp: 123,
    });

    assert.equal(entry.schemaVersion, 1);
    assert.equal(entry.toolName, "read");
    assert.equal(entry.scope, "session");
    assert.equal(entry.decision, "allowed-session");
});
