import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { buildGrantKey } from "./core.ts";
import { createRuntimeState } from "./runtime-state.ts";

function createTempConfigSource(initialContent: string) {
    const root = mkdtempSync(join(tmpdir(), "permission-gate-runtime-"));
    const homeDir = join(root, "home");
    const configPath = join(homeDir, ".pi", "agent", "permission-gate.jsonc");
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, initialContent, "utf-8");

    return {
        root,
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

function parseConfigText(text: string) {
    return JSON.parse(text);
}

test("runtime-state loads config through injected temp config source and refreshes snapshots by cwd", () => {
    const source = createTempConfigSource(JSON.stringify({ trustedRoots: ["."], sensitivePaths: [], tools: {}, bash: {} }));
    const state = createRuntimeState({
        io: source.io,
        parseConfigText,
        createDefaultConfigText: () => JSON.stringify({ trustedRoots: ["."], sensitivePaths: [], tools: {}, bash: {} }),
    });

    state.initialize("/work/project-a");
    const snapshotA = state.getSnapshotForCwd("/work/project-a");
    const snapshotB = state.getSnapshotForCwd("/work/project-b");

    assert.notEqual(snapshotA, snapshotB);
    assert.deepEqual(snapshotA.trustedRoots, ["/work/project-a"]);
    assert.deepEqual(snapshotB.trustedRoots, ["/work/project-b"]);
});

test("runtime-state preserves grants for the same workspace signature and clears them when the boundary changes", () => {
    const sameSignatureSource = createTempConfigSource(
        JSON.stringify({ trustedRoots: ["/shared/root"], sensitivePaths: [], alwaysAskTools: [], tools: {}, bash: {} }),
    );
    const sameSignatureState = createRuntimeState({
        io: sameSignatureSource.io,
        parseConfigText,
        createDefaultConfigText: () => JSON.stringify({ trustedRoots: ["/shared/root"], sensitivePaths: [], alwaysAskTools: [], tools: {}, bash: {} }),
    });

    sameSignatureState.initialize("/work/project-a");
    sameSignatureState.getGrantStore().rememberGrant({
        toolName: "read",
        category: "path-tool",
        action: "ask-session",
        reason: "outside-root-read",
        targetPath: "/tmp/file.txt",
        grantKind: "read-path",
        grantScope: "exact",
        grantKey: buildGrantKey("read-path", "/tmp/file.txt"),
        messageContext: "Read target is outside trusted roots.",
    });
    sameSignatureState.clearGrantsIfBoundaryChanged("/work/project-b");
    assert.equal(sameSignatureState.getGrantStore().size(), 1);

    const changingBoundarySource = createTempConfigSource(JSON.stringify({ trustedRoots: ["."], sensitivePaths: [], tools: {}, bash: {} }));
    const changingBoundaryState = createRuntimeState({
        io: changingBoundarySource.io,
        parseConfigText,
        createDefaultConfigText: () => JSON.stringify({ trustedRoots: ["."], sensitivePaths: [], tools: {}, bash: {} }),
    });

    changingBoundaryState.initialize("/work/project-a");
    changingBoundaryState.getGrantStore().rememberGrant({
        toolName: "read",
        category: "path-tool",
        action: "ask-session",
        reason: "outside-root-read",
        targetPath: "/tmp/file.txt",
        grantKind: "read-path",
        grantScope: "exact",
        grantKey: buildGrantKey("read-path", "/tmp/file.txt"),
        messageContext: "Read target is outside trusted roots.",
    });
    changingBoundaryState.clearGrantsIfBoundaryChanged("/work/project-b");
    assert.equal(changingBoundaryState.getGrantStore().size(), 0);
});

test("runtime-state getSnapshotForCwd is boundary-safe and clears grants on direct workspace changes", () => {
    const source = createTempConfigSource(JSON.stringify({ trustedRoots: ["."], sensitivePaths: [], tools: {}, bash: {} }));
    const state = createRuntimeState({
        io: source.io,
        parseConfigText,
        createDefaultConfigText: () => JSON.stringify({ trustedRoots: ["."], sensitivePaths: [], tools: {}, bash: {} }),
    });

    state.initialize("/work/project-a");
    state.getGrantStore().rememberGrant({
        toolName: "read",
        category: "path-tool",
        action: "ask-session",
        reason: "outside-root-read",
        targetPath: "/tmp/file.txt",
        grantKind: "read-path",
        grantScope: "exact",
        grantKey: buildGrantKey("read-path", "/tmp/file.txt"),
        messageContext: "Read target is outside trusted roots.",
    });

    const snapshot = state.getSnapshotForCwd("/work/project-b");

    assert.deepEqual(snapshot.trustedRoots, ["/work/project-b"]);
    assert.equal(state.getGrantStore().size(), 0);
});

test("runtime-state replaces stale pending config notices after the config is fixed", () => {
    const source = createTempConfigSource("{ broken json }");
    const state = createRuntimeState({
        io: source.io,
        parseConfigText,
        createDefaultConfigText: () => JSON.stringify({ trustedRoots: ["."], sensitivePaths: [], tools: {}, bash: {} }),
    });

    state.initialize("/work/project-a");
    assert.equal(state.getNoticeStore().hasPending(), true);
    assert.equal(state.getNoticeStore().getPending()[0]?.key, "config-parse-error");

    source.io.writeFile(source.configPath, JSON.stringify({ trustedRoots: ["."], sensitivePaths: [], tools: {}, bash: {} }));
    state.resetSessionState("session_switch", "/work/project-a");

    assert.deepEqual(state.getNoticeStore().getPending(), []);
});
