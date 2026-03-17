import test from "node:test";
import assert from "node:assert/strict";

import { buildGrantKey, type AccessDecision } from "./core.ts";
import { createGrantStore } from "./grant-store.ts";

function buildDecision(overrides: Partial<AccessDecision> = {}): AccessDecision {
    return {
        toolName: "read",
        category: "path-tool",
        action: "ask-session",
        reason: "outside-root-read",
        targetPath: "/tmp/project/file.txt",
        grantKind: "read-path",
        grantScope: "exact",
        grantKey: buildGrantKey("read-path", "/tmp/project/file.txt"),
        messageContext: "Read target is outside trusted roots.",
        ...overrides,
    };
}

test("grant-store reuses exact grants only for the exact same target", () => {
    const store = createGrantStore();
    const first = buildDecision({
        toolName: "edit",
        reason: "modify-file",
        targetPath: "/tmp/project/a.ts",
        grantKind: "modify-file",
        grantScope: "exact",
        grantKey: buildGrantKey("modify-file", "/tmp/project/a.ts"),
    });
    const second = buildDecision({
        toolName: "edit",
        reason: "modify-file",
        targetPath: "/tmp/project/b.ts",
        grantKind: "modify-file",
        grantScope: "exact",
        grantKey: buildGrantKey("modify-file", "/tmp/project/b.ts"),
    });

    store.rememberGrant(first);

    assert.equal(store.hasCoverage(first), true);
    assert.equal(store.hasCoverage(second), false);
});

test("grant-store reuses browse grants for nested subtree but not sibling paths", () => {
    const store = createGrantStore();
    const rootBrowse = buildDecision({
        toolName: "find",
        reason: "outside-root-browse",
        targetPath: "/tmp/outside/project-a",
        grantKind: "browse-path",
        grantScope: "subtree",
        grantKey: buildGrantKey("browse-path", "/tmp/outside/project-a"),
    });
    const nestedBrowse = buildDecision({
        toolName: "grep",
        reason: "outside-root-browse",
        targetPath: "/tmp/outside/project-a/src",
        grantKind: "browse-path",
        grantScope: "subtree",
        grantKey: buildGrantKey("browse-path", "/tmp/outside/project-a/src"),
    });
    const siblingBrowse = buildDecision({
        toolName: "ls",
        reason: "outside-root-browse",
        targetPath: "/tmp/outside/project-b",
        grantKind: "browse-path",
        grantScope: "subtree",
        grantKey: buildGrantKey("browse-path", "/tmp/outside/project-b"),
    });

    store.rememberGrant(rootBrowse);

    assert.equal(store.hasCoverage(rootBrowse), true);
    assert.equal(store.hasCoverage(nestedBrowse), true);
    assert.equal(store.hasCoverage(siblingBrowse), false);
});

test("grant-store keeps browse and exact grants isolated by capability kind", () => {
    const store = createGrantStore();
    const browse = buildDecision({
        toolName: "find",
        reason: "outside-root-browse",
        targetPath: "/tmp/outside/project-a",
        grantKind: "browse-path",
        grantScope: "subtree",
        grantKey: buildGrantKey("browse-path", "/tmp/outside/project-a"),
    });
    const readFile = buildDecision({
        toolName: "read",
        reason: "outside-root-read",
        targetPath: "/tmp/outside/project-a/secret.txt",
        grantKind: "read-path",
        grantScope: "exact",
        grantKey: buildGrantKey("read-path", "/tmp/outside/project-a/secret.txt"),
    });

    store.rememberGrant(browse);

    assert.equal(store.hasCoverage(readFile), false);
});

test("grant-store list returns structured grant records without parsing keys downstream", () => {
    const store = createGrantStore();
    const browse = buildDecision({
        toolName: "find",
        reason: "outside-root-browse",
        targetPath: "/tmp/outside/project-a",
        grantKind: "browse-path",
        grantScope: "subtree",
        grantKey: buildGrantKey("browse-path", "/tmp/outside/project-a"),
    });

    store.rememberGrant(browse);

    assert.equal(store.size(), 1);
    assert.deepEqual(store.list().map((grant) => ({
        kind: grant.kind,
        scope: grant.scope,
        target: grant.target,
        toolName: grant.toolName,
        category: grant.category,
        reason: grant.reason,
    })), [
        {
            kind: "browse-path",
            scope: "subtree",
            target: "/tmp/outside/project-a",
            toolName: "find",
            category: "path-tool",
            reason: "outside-root-browse",
        },
    ]);
});

test("grant-store uses structured grant metadata instead of parsing grant keys", () => {
    const store = createGrantStore();
    const remembered = buildDecision({
        toolName: "find",
        reason: "outside-root-browse",
        targetPath: "/tmp/outside/project-a",
        grantKind: "browse-path",
        grantScope: "subtree",
        grantKey: "opaque-browse-grant",
    });
    const covered = buildDecision({
        toolName: "grep",
        reason: "outside-root-browse",
        targetPath: "/tmp/outside/project-a/src",
        grantKind: "browse-path",
        grantScope: "subtree",
        grantKey: "opaque-nested-browse-grant",
    });

    store.rememberGrant(remembered);

    assert.equal(store.list()[0]?.kind, "browse-path");
    assert.equal(store.list()[0]?.scope, "subtree");
    assert.equal(store.hasCoverage(covered), true);
});
