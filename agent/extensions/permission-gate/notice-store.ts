export type NoticeRecord = {
    key: string;
    origin: string;
    message: string;
};

export type NoticeStore = ReturnType<typeof createNoticeStore>;

export function createNoticeStore() {
    const pending = new Map<string, NoticeRecord>();
    const delivered = new Map<string, string>();

    return {
        enqueue(notices: NoticeRecord[]): void {
            for (const notice of notices) {
                const id = buildNoticeId(notice.origin, notice.key);
                if (delivered.has(id)) continue;
                if (pending.has(id)) continue;
                pending.set(id, notice);
            }
        },

        replacePending(origin: string, notices: NoticeRecord[]): void {
            for (const [id, notice] of pending.entries()) {
                if (notice.origin === origin) pending.delete(id);
            }

            const nextIds = new Set(notices.filter((notice) => notice.origin === origin).map((notice) => buildNoticeId(notice.origin, notice.key)));
            for (const [id, deliveredOrigin] of delivered.entries()) {
                if (deliveredOrigin === origin && !nextIds.has(id)) {
                    delivered.delete(id);
                }
            }

            this.enqueue(notices);
        },

        getPending(): NoticeRecord[] {
            return [...pending.values()];
        },

        drainPending(): NoticeRecord[] {
            return this.getPending();
        },

        markDelivered(notices: NoticeRecord[]): void {
            for (const notice of notices) {
                const id = buildNoticeId(notice.origin, notice.key);
                delivered.set(id, notice.origin);
                pending.delete(id);
            }
        },

        hasPending(): boolean {
            return pending.size > 0;
        },
    };
}

function buildNoticeId(origin: string, key: string): string {
    return `${origin}:${key}`;
}
