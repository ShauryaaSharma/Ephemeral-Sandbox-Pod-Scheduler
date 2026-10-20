import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import http from "http";
import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";

// reaper.ts (via db.ts/internalToken.ts) reads these env vars at module-load
// time, so they have to be set before it's first imported - a dynamic
// import after setup, rather than a static one, guarantees that order.
const dbPath = path.join(os.tmpdir(), `reaper-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
process.env.OWNERSHIP_DB_PATH = dbPath;
process.env.INTERNAL_API_MASTER_KEY = "test-master-key";

// A real local HTTP server standing in for every project's pod - the
// runner's own /health response shape ({ lastActivityAt }), keyed by the
// Host header's first label (the replId), exactly like the real ingress
// routes by subdomain. Listens on an OS-assigned port so no privileged
// port or hosts-file entry is needed; "*.localhost" already resolves to
// loopback without any extra setup.
let server: http.Server;
let healthResponses: Record<string, { lastActivityAt: number } | "fail"> = {};
let reapOnce: typeof import("./reaper").reapOnce;
let getProject: typeof import("./db").getProject;

beforeAll(async () => {
    server = http.createServer((req, res) => {
        const replId = (req.headers.host ?? "").split(".")[0];
        const canned = healthResponses[replId];
        if (canned === "fail" || !canned) {
            res.writeHead(500);
            res.end();
            return;
        }
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(canned));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    // Must be set before reaper.ts is first imported, since it reads
    // WS_DOMAIN into a module-level constant at import time.
    process.env.WS_DOMAIN = `localhost:${port}`;
    ({ reapOnce } = await import("./reaper"));
    ({ getProject } = await import("./db"));
});

afterAll(() => {
    server.close();
    seedDb.close();
    // Best-effort: db.ts also holds its own open connection to this same
    // file (module-level, never closed) - on Windows that keeps the file
    // locked even after our own connection closes, so deleting it can fail
    // with EPERM. Harmless either way; it's in the OS temp dir.
    for (const suffix of ["", "-wal", "-shm"]) {
        try {
            fs.rmSync(dbPath + suffix, { force: true });
        } catch {
            // ignore - see above
        }
    }
});

afterEach(() => {
    healthResponses = {};
    // Each test seeds its own projects - without this, a previous test's
    // rows (still status='started') would also get evaluated by the next
    // test's reapOnce call and pollute its stopProject assertions.
    seedDb.exec("DELETE FROM projects");
});

const seedDb = new Database(dbPath);
seedDb.exec(`
    CREATE TABLE IF NOT EXISTS projects (
        repl_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'created',
        last_active_at TEXT,
        health_status TEXT NOT NULL DEFAULT 'unknown',
        restart_count INTEGER NOT NULL DEFAULT 0,
        unhealthy_reason TEXT,
        started_at TEXT
    )
`);

function seedStartedProject(replId: string, ownerId: string, startedAt: Date, lastActiveAt: Date): void {
    seedDb
        .prepare(
            `INSERT INTO projects (repl_id, owner_id, created_at, status, last_active_at, started_at)
             VALUES (?, ?, ?, 'started', ?, ?)`
        )
        .run(replId, ownerId, startedAt.toISOString(), lastActiveAt.toISOString(), startedAt.toISOString());
}

describe("reapOnce", () => {
    it("tears down an idle project but leaves a fresh one alone", async () => {
        const now = new Date();
        seedStartedProject("project-idle", "owner-1", now, now);
        seedStartedProject("project-fresh", "owner-2", now, now);

        // The runner's own /health is the source of truth for activity -
        // reapOnce refreshes last_active_at from this before deciding.
        healthResponses["project-idle"] = { lastActivityAt: now.getTime() - 20 * 60 * 1000 };
        healthResponses["project-fresh"] = { lastActivityAt: now.getTime() };

        const stopProject = vi.fn().mockResolvedValue(undefined);
        await reapOnce(stopProject);

        expect(stopProject).toHaveBeenCalledTimes(1);
        expect(stopProject).toHaveBeenCalledWith("project-idle");
        expect(stopProject).not.toHaveBeenCalledWith("project-fresh");
    });

    it("falls back to the last known activity when a pod is unreachable, instead of force-reaping it", async () => {
        const now = new Date();
        seedStartedProject("project-unreachable", "owner-3", now, now);
        healthResponses["project-unreachable"] = "fail";

        const stopProject = vi.fn().mockResolvedValue(undefined);
        await reapOnce(stopProject);

        // last_active_at is "now" (just seeded), so even though the health
        // check failed, it's not idle yet by the fallback timestamp.
        expect(stopProject).not.toHaveBeenCalled();
    });

    it("tears down a project past its max lifetime even though it's still active", async () => {
        const now = new Date();
        const longAgo = new Date(now.getTime() - 11.9 * 60 * 60 * 1000); // past the 11h45m cutoff of the 12h default
        seedStartedProject("project-old", "owner-4", longAgo, now);
        // Fully active right now - would NOT be caught by the idle check alone.
        healthResponses["project-old"] = { lastActivityAt: now.getTime() };

        const stopProject = vi.fn().mockResolvedValue(undefined);
        await reapOnce(stopProject);

        expect(stopProject).toHaveBeenCalledWith("project-old");
    });

    it("does not touch a project that is neither idle nor over its max lifetime", async () => {
        const now = new Date();
        seedStartedProject("project-ok", "owner-5", now, now);
        healthResponses["project-ok"] = { lastActivityAt: now.getTime() };

        const stopProject = vi.fn().mockResolvedValue(undefined);
        await reapOnce(stopProject);

        expect(stopProject).not.toHaveBeenCalled();
        expect(getProject("project-ok")?.status).toBe("started");
    });
});
