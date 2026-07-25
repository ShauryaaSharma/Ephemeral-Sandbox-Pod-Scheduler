import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

// init-service and orchestrator-simple both need to read/write this table -
// since neither runs as a hosted DB today, the lightest option is a SQLite
// file on a filesystem they both have access to (same host/volume). Override
// OWNERSHIP_DB_PATH for your deployment; the default assumes both services
// are checked out side-by-side, as in this repo.
const DB_PATH = process.env.OWNERSHIP_DB_PATH ?? path.resolve(__dirname, "../../data/ownership.db");

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
// status/last_active_at/health_status/restart_count/unhealthy_reason are
// owned by orchestrator-simple (start/stop lifecycle, idle reaper, crash-loop
// health monitor) but declared here too, since whichever service boots first
// is the one that actually creates the table.
db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
        repl_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'created',
        last_active_at TEXT,
        health_status TEXT NOT NULL DEFAULT 'unknown',
        restart_count INTEGER NOT NULL DEFAULT 0,
        unhealthy_reason TEXT
    )
`);

export interface ProjectRecord {
    replId: string;
    ownerId: string;
    createdAt: string;
    status: "created" | "started" | "stopped";
    lastActiveAt: string | null;
    healthStatus: "unknown" | "healthy" | "unhealthy";
    restartCount: number;
    unhealthyReason: string | null;
}

export function getProject(replId: string): ProjectRecord | undefined {
    return db
        .prepare(
            `SELECT repl_id as replId, owner_id as ownerId, created_at as createdAt, status,
                    last_active_at as lastActiveAt, health_status as healthStatus,
                    restart_count as restartCount, unhealthy_reason as unhealthyReason
             FROM projects WHERE repl_id = ?`
        )
        .get(replId) as ProjectRecord | undefined;
}

export function createProject(replId: string, ownerId: string): void {
    db.prepare("INSERT INTO projects (repl_id, owner_id, created_at) VALUES (?, ?, ?)").run(
        replId,
        ownerId,
        new Date().toISOString()
    );
}
