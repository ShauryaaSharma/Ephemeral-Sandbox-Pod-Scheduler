import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

// Shares a SQLite file with init-service (see that service's src/db.ts for
// the full rationale). The row itself is created by init-service at
// POST /project time; orchestrator-simple owns the lifecycle/health columns
// added below, updated by /start, /stop, the idle-timeout reaper, and the
// crash-loop health monitor.
const DB_PATH = process.env.OWNERSHIP_DB_PATH ?? path.resolve(__dirname, "../../data/ownership.db");

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
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

// Defensive migration for a DB file created before these columns existed
// (e.g. during Priority 2/3 development) - CREATE TABLE IF NOT EXISTS above
// is a no-op against an already-existing table, so an older file would
// otherwise be missing these and fail at query time.
function addColumnIfMissing(sql: string) {
    try {
        db.exec(sql);
    } catch (err: any) {
        if (!/duplicate column/i.test(err?.message ?? "")) throw err;
    }
}
addColumnIfMissing("ALTER TABLE projects ADD COLUMN status TEXT NOT NULL DEFAULT 'created'");
addColumnIfMissing("ALTER TABLE projects ADD COLUMN last_active_at TEXT");
addColumnIfMissing("ALTER TABLE projects ADD COLUMN health_status TEXT NOT NULL DEFAULT 'unknown'");
addColumnIfMissing("ALTER TABLE projects ADD COLUMN restart_count INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("ALTER TABLE projects ADD COLUMN unhealthy_reason TEXT");

export type ProjectStatus = "created" | "started" | "stopped";
// Orthogonal to ProjectStatus: a "started" project (a pod exists) can still
// be unhealthy (crash-looping). Reset to "unknown" on every fresh /start.
export type HealthStatus = "unknown" | "healthy" | "unhealthy";

export interface ProjectRecord {
    replId: string;
    ownerId: string;
    createdAt: string;
    status: ProjectStatus;
    lastActiveAt: string | null;
    healthStatus: HealthStatus;
    restartCount: number;
    unhealthyReason: string | null;
}

const SELECT_COLUMNS = `
    repl_id as replId,
    owner_id as ownerId,
    created_at as createdAt,
    status,
    last_active_at as lastActiveAt,
    health_status as healthStatus,
    restart_count as restartCount,
    unhealthy_reason as unhealthyReason
`;

export function getProject(replId: string): ProjectRecord | undefined {
    return db.prepare(`SELECT ${SELECT_COLUMNS} FROM projects WHERE repl_id = ?`).get(replId) as
        | ProjectRecord
        | undefined;
}

export function markStarted(replId: string): void {
    // A fresh start gets a clean health slate - stale restart counts/reasons
    // from a previous run of this replId shouldn't carry over.
    db.prepare(
        "UPDATE projects SET status = 'started', last_active_at = ?, health_status = 'unknown', restart_count = 0, unhealthy_reason = NULL WHERE repl_id = ?"
    ).run(new Date().toISOString(), replId);
}

export function markStopped(replId: string): void {
    db.prepare("UPDATE projects SET status = 'stopped' WHERE repl_id = ?").run(replId);
}

export function updateLastActive(replId: string, lastActiveAtIso: string): void {
    db.prepare("UPDATE projects SET last_active_at = ? WHERE repl_id = ?").run(lastActiveAtIso, replId);
}

export function updateRestartCount(replId: string, restartCount: number): void {
    db.prepare("UPDATE projects SET restart_count = ? WHERE repl_id = ?").run(restartCount, replId);
}

export function markUnhealthy(replId: string, reason: string): void {
    db.prepare("UPDATE projects SET health_status = 'unhealthy', unhealthy_reason = ? WHERE repl_id = ?").run(
        reason,
        replId
    );
}

export function markHealthy(replId: string): void {
    db.prepare("UPDATE projects SET health_status = 'healthy', unhealthy_reason = NULL WHERE repl_id = ?").run(
        replId
    );
}

export function getStartedProjects(): ProjectRecord[] {
    return db.prepare(`SELECT ${SELECT_COLUMNS} FROM projects WHERE status = 'started'`).all() as ProjectRecord[];
}
