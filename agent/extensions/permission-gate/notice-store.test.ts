import test from "node:test";
import assert from "node:assert/strict";

import { createNoticeStore } from "./notice-store.ts";

function makeNotice(overrides: Partial<{ key: string; origin: string; message: string }> = {}) {
    return {
        key: "config-parse-error",
        origin: "config-load",
        message: "Permission Gate: failed to parse config, using defaults.",
        ...overrides,
    };
}

test("notice-store keeps notices pending until they are explicitly marked delivered", () => {
    const store = createNoticeStore();
    const notice = makeNotice();

    store.enqueue([notice]);

    assert.equal(store.hasPending(), true);
    assert.deepEqual(store.getPending(), [notice]);
    assert.deepEqual(store.drainPending(), [notice]);
    assert.equal(store.hasPending(), true);

    store.markDelivered([notice]);

    assert.equal(store.hasPending(), false);
    assert.deepEqual(store.getPending(), []);
});

test("notice-store does not lose a pending notice on repeated enqueue before delivery", () => {
    const store = createNoticeStore();
    const notice = makeNotice();

    store.enqueue([notice]);
    store.enqueue([notice]);

    assert.deepEqual(store.getPending(), [notice]);
});

test("notice-store does not re-enqueue already delivered notices", () => {
    const store = createNoticeStore();
    const notice = makeNotice();

    store.enqueue([notice]);
    store.markDelivered([notice]);
    store.enqueue([notice]);

    assert.equal(store.hasPending(), false);
    assert.deepEqual(store.getPending(), []);
});

test("notice-store replaces stale pending notices of the same origin", () => {
    const store = createNoticeStore();
    const stale = makeNotice({ key: "config-parse-error", message: "old parse error" });
    const fresh = makeNotice({ key: "legacy-migration", message: "new migration notice" });

    store.enqueue([stale]);
    store.replacePending("config-load", [fresh]);

    assert.deepEqual(store.getPending(), [fresh]);
});

test("notice-store can clear pending notices for an origin when the problem is gone", () => {
    const store = createNoticeStore();
    const stale = makeNotice({ key: "config-parse-error", message: "old parse error" });

    store.enqueue([stale]);
    store.replacePending("config-load", []);

    assert.equal(store.hasPending(), false);
    assert.deepEqual(store.getPending(), []);
});

test("notice-store allows a delivered notice to appear again after that origin was cleared and the problem returns", () => {
    const store = createNoticeStore();
    const notice = makeNotice({ key: "config-parse-error", message: "parse error" });

    store.enqueue([notice]);
    store.markDelivered([notice]);
    store.replacePending("config-load", []);
    store.enqueue([notice]);

    assert.equal(store.hasPending(), true);
    assert.deepEqual(store.getPending(), [notice]);
});

test("notice-store deduplicates by origin plus key, not by key alone", () => {
    const store = createNoticeStore();
    const configNotice = makeNotice({ key: "shared-key", origin: "config-load", message: "config notice" });
    const runtimeNotice = makeNotice({ key: "shared-key", origin: "runtime", message: "runtime notice" });

    store.enqueue([configNotice]);
    store.markDelivered([configNotice]);
    store.enqueue([runtimeNotice]);

    assert.equal(store.hasPending(), true);
    assert.deepEqual(store.getPending(), [runtimeNotice]);
});
