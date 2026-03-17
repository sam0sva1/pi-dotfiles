import { dirname } from "node:path";

import {
    buildWorkspaceSignature,
    createPolicyContext,
    type PermissionGateContext,
    type PermissionGateRawConfig,
} from "./core.ts";
import { createGrantStore, type GrantStore } from "./grant-store.ts";
import { createNoticeStore, type NoticeRecord, type NoticeStore } from "./notice-store.ts";

const CONFIG_NOTICE_ORIGIN = "config-load";

export type PermissionGateRuntimeIO = {
    homeDir: string;
    configPath: string;
    exists(path: string): boolean;
    readFile(path: string): string;
    writeFile(path: string, content: string): void;
    mkdir(path: string): void;
};

export function createRuntimeState(options: {
    io: PermissionGateRuntimeIO;
    parseConfigText(text: string): PermissionGateRawConfig;
    createDefaultConfigText(): string;
    grantStore?: GrantStore;
    noticeStore?: NoticeStore;
}) {
    const grantStore = options.grantStore ?? createGrantStore();
    const noticeStore = options.noticeStore ?? createNoticeStore();
    let rawConfig: PermissionGateRawConfig | undefined;
    let snapshot: PermissionGateContext | undefined;
    let workspaceSignature = "";

    function initialize(cwd: string): PermissionGateContext {
        return reloadSnapshot(cwd);
    }

    function getSnapshotForCwd(cwd: string): PermissionGateContext {
        if (!snapshot || snapshot.cwd !== cwd) {
            clearGrantsIfBoundaryChanged(cwd);
        }
        return snapshot!;
    }

    function resetSessionState(_reason: string, cwd: string): PermissionGateContext {
        grantStore.clear();
        return reloadSnapshot(cwd);
    }

    function clearGrantsIfBoundaryChanged(cwd: string): boolean {
        const nextSnapshot = createPolicyContext(rawConfig, { cwd, homeDir: options.io.homeDir });
        const nextSignature = buildWorkspaceSignature(nextSnapshot);
        const changed = workspaceSignature !== "" && workspaceSignature !== nextSignature;
        if (changed) {
            grantStore.clear();
        }
        snapshot = nextSnapshot;
        workspaceSignature = nextSignature;
        return changed;
    }

    function getGrantStore(): GrantStore {
        return grantStore;
    }

    function getNoticeStore(): NoticeStore {
        return noticeStore;
    }

    function reloadSnapshot(cwd: string): PermissionGateContext {
        ensureConfigFile();

        const nextNotices: NoticeRecord[] = [];
        try {
            rawConfig = options.parseConfigText(options.io.readFile(options.io.configPath));
        } catch (error) {
            rawConfig = undefined;
            nextNotices.push({
                key: "config-parse-error",
                origin: CONFIG_NOTICE_ORIGIN,
                message: `Permission Gate: failed to parse config, using defaults. Error: ${String(error)}`,
            });
        }

        const nextSnapshot = createPolicyContext(rawConfig, { cwd, homeDir: options.io.homeDir });
        nextNotices.push(...nextSnapshot.notices.map((message) => ({
            key: `config-notice:${message}`,
            origin: CONFIG_NOTICE_ORIGIN,
            message,
        })));

        noticeStore.replacePending(CONFIG_NOTICE_ORIGIN, nextNotices);
        snapshot = nextSnapshot;
        workspaceSignature = buildWorkspaceSignature(nextSnapshot);
        return nextSnapshot;
    }

    function ensureConfigFile(): void {
        if (options.io.exists(options.io.configPath)) return;
        options.io.mkdir(dirname(options.io.configPath));
        options.io.writeFile(options.io.configPath, options.createDefaultConfigText());
    }

    return {
        initialize,
        getSnapshotForCwd,
        resetSessionState,
        clearGrantsIfBoundaryChanged,
        getGrantStore,
        getNoticeStore,
    };
}
