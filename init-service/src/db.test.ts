import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// db.ts reads OWNERSHIP_DB_PATH at module-load time, so it has to be set
// before it's first imported - a dynamic import after setup, rather than a
// static one, guarantees that order.
const dbPath = path.join(os.tmpdir(), `init-db-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
process.env.OWNERSHIP_DB_PATH = dbPath;

let getProject: typeof import("./db").getProject;
let createProject: typeof import("./db").createProject;
let deleteProject: typeof import("./db").deleteProject;

beforeAll(async () => {
    ({ getProject, createProject, deleteProject } = await import("./db"));
});

afterAll(() => {
    for (const suffix of ["", "-wal", "-shm"]) {
        try {
            fs.rmSync(dbPath + suffix, { force: true });
        } catch {
            // best-effort - see orchestrator-simple/src/reaper.test.ts's identical note
        }
    }
});

describe("ownership DB (init-service)", () => {
    it("getProject returns undefined for an unknown replId", () => {
        expect(getProject("does-not-exist")).toBeUndefined();
    });

    it("createProject then getProject round-trips ownership", () => {
        createProject("repl-create", "owner-1");
        const project = getProject("repl-create");
        expect(project?.replId).toBe("repl-create");
        expect(project?.ownerId).toBe("owner-1");
        expect(project?.status).toBe("created");
    });

    it("createProject rejects a duplicate replId (the unique constraint POST /project relies on)", () => {
        createProject("repl-dup", "owner-2");
        expect(() => createProject("repl-dup", "owner-3")).toThrow();
    });

    it("deleteProject rolls back a reservation, freeing the replId for reuse", () => {
        createProject("repl-rollback", "owner-4");
        expect(getProject("repl-rollback")).toBeDefined();

        deleteProject("repl-rollback");
        expect(getProject("repl-rollback")).toBeUndefined();

        // The whole point: creating it again afterwards must not throw.
        expect(() => createProject("repl-rollback", "owner-5")).not.toThrow();
        expect(getProject("repl-rollback")?.ownerId).toBe("owner-5");
    });
});
