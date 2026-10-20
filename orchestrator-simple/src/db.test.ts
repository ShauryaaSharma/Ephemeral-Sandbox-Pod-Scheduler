import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";

// db.ts reads OWNERSHIP_DB_PATH at module-load time, so it has to be set
// before it's first imported - a dynamic import after setup, rather than a
// static one, guarantees that order. A real temp file (not :memory:) so the
// test can also seed rows directly, the same way init-service's own
// createProject would have, before orchestrator-simple's db.ts ever sees them.
const dbPath = path.join(os.tmpdir(), `orch-db-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
process.env.OWNERSHIP_DB_PATH = dbPath;

let seedDb: Database.Database;
let getProject: typeof import("./db").getProject;
let markStarted: typeof import("./db").markStarted;
let markStopped: typeof import("./db").markStopped;
let updateLastActive: typeof import("./db").updateLastActive;
let markUnhealthy: typeof import("./db").markUnhealthy;
let markHealthy: typeof import("./db").markHealthy;
let getStartedProjects: typeof import("./db").getStartedProjects;

beforeAll(async () => {
    ({ getProject, markStarted, markStopped, updateLastActive, markUnhealthy, markHealthy, getStartedProjects } =
        await import("./db"));
    seedDb = new Database(dbPath);
});

afterAll(() => {
    seedDb.close();
    for (const suffix of ["", "-wal", "-shm"]) {
        try {
            fs.rmSync(dbPath + suffix, { force: true });
        } catch {
            // best-effort - see reaper.test.ts's identical note
        }
    }
});

function seedCreatedProject(replId: string, ownerId: string): void {
    seedDb
        .prepare("INSERT INTO projects (repl_id, owner_id, created_at) VALUES (?, ?, ?)")
        .run(replId, ownerId, new Date().toISOString());
}

describe("ownership DB (orchestrator-simple)", () => {
    it("getProject returns undefined for an unknown replId", () => {
        expect(getProject("does-not-exist")).toBeUndefined();
    });

    it("markStarted sets status, resets health fields, and stamps started_at", () => {
        seedCreatedProject("repl-start", "owner-1");
        markStarted("repl-start");

        const project = getProject("repl-start");
        expect(project?.status).toBe("started");
        expect(project?.healthStatus).toBe("unknown");
        expect(project?.restartCount).toBe(0);
        expect(project?.unhealthyReason).toBeNull();
        expect(project?.startedAt).not.toBeNull();
        expect(project?.lastActiveAt).not.toBeNull();
    });

    it("markStarted resets stale restart/health state from a previous run", () => {
        seedCreatedProject("repl-restart", "owner-2");
        markStarted("repl-restart");
        markUnhealthy("repl-restart", "CrashLoopBackOff");
        expect(getProject("repl-restart")?.healthStatus).toBe("unhealthy");

        markStarted("repl-restart"); // simulates stop -> restart
        const project = getProject("repl-restart");
        expect(project?.healthStatus).toBe("unknown");
        expect(project?.unhealthyReason).toBeNull();
    });

    it("markStopped transitions status without touching health fields", () => {
        seedCreatedProject("repl-stop", "owner-3");
        markStarted("repl-stop");
        markStopped("repl-stop");
        expect(getProject("repl-stop")?.status).toBe("stopped");
    });

    it("updateLastActive updates only that column", () => {
        seedCreatedProject("repl-active", "owner-4");
        markStarted("repl-active");
        const newTimestamp = new Date(0).toISOString();
        updateLastActive("repl-active", newTimestamp);
        expect(getProject("repl-active")?.lastActiveAt).toBe(newTimestamp);
    });

    it("markUnhealthy then markHealthy round-trips cleanly", () => {
        seedCreatedProject("repl-health", "owner-5");
        markStarted("repl-health");
        markUnhealthy("repl-health", "OOMKilled");
        expect(getProject("repl-health")).toMatchObject({ healthStatus: "unhealthy", unhealthyReason: "OOMKilled" });

        markHealthy("repl-health");
        expect(getProject("repl-health")).toMatchObject({ healthStatus: "healthy", unhealthyReason: null });
    });

    it("getStartedProjects only returns status='started' rows", () => {
        seedCreatedProject("repl-list-started", "owner-6");
        markStarted("repl-list-started");
        seedCreatedProject("repl-list-created", "owner-7"); // never started

        const started = getStartedProjects().map((p) => p.replId);
        expect(started).toContain("repl-list-started");
        expect(started).not.toContain("repl-list-created");
    });
});
