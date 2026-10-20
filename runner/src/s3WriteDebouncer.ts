// Coalesces rapid-fire file saves (e.g. every keystroke, via updateContent)
// into a single S3 write per file after a trailing quiet period, instead of
// firing one S3 PUT per edit. Keyed by (S3 prefix, relative path) rather
// than by socket, since a pod serves exactly one project and the goal is
// one write per file, regardless of which session last touched it.
export type S3WriteFn = (key: string, filePath: string, content: string) => Promise<void>;

interface PendingWrite {
    key: string;
    filePath: string;
    content: string;
}

export class S3WriteDebouncer {
    private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly pending = new Map<string, PendingWrite>();

    constructor(private readonly writeFn: S3WriteFn, private readonly debounceMs: number) {}

    private cacheKey(key: string, filePath: string): string {
        return `${key}\u0000${filePath}`;
    }

    // Replaces any pending write for this same file and restarts its timer -
    // only the latest content wins, and only one write fires per quiet period.
    schedule(key: string, filePath: string, content: string): void {
        const cacheKey = this.cacheKey(key, filePath);
        this.pending.set(cacheKey, { key, filePath, content });

        const existingTimer = this.timers.get(cacheKey);
        if (existingTimer) clearTimeout(existingTimer);

        const timer = setTimeout(() => {
            this.timers.delete(cacheKey);
            const write = this.pending.get(cacheKey);
            this.pending.delete(cacheKey);
            if (write) {
                this.writeFn(write.key, write.filePath, write.content).catch((err) => {
                    console.error(`debounced S3 write failed for ${filePath}:`, err);
                });
            }
        }, this.debounceMs);
        this.timers.set(cacheKey, timer);
    }

    // Writes out every pending file immediately and cancels their timers -
    // used on socket disconnect, /shutdown, and SIGTERM, so a save made just
    // before any of those doesn't get lost waiting out the debounce window.
    async flush(): Promise<void> {
        const writes = Array.from(this.pending.values());
        for (const timer of this.timers.values()) clearTimeout(timer);
        this.timers.clear();
        this.pending.clear();
        await Promise.all(writes.map((write) => this.writeFn(write.key, write.filePath, write.content)));
    }

    pendingCount(): number {
        return this.pending.size;
    }
}
