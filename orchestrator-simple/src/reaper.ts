import axios from "axios";
import { getStartedProjects, updateLastActive } from "./db";
import { StopProjectFn } from "./stop";

const IDLE_TIMEOUT_MS = (Number(process.env.IDLE_TIMEOUT_MINUTES) || 15) * 60 * 1000;
const REAP_INTERVAL_MS = (Number(process.env.REAPER_INTERVAL_SECONDS) || 60) * 1000;
const WS_DOMAIN = process.env.WS_DOMAIN ?? "peetcode.com";
const HEALTH_CHECK_TIMEOUT_MS = 5000;
const MAX_TEARDOWN_EVENTS = 50;

export interface TeardownEvent {
    replId: string;
    ownerId: string;
    idleMinutes: number;
    timestamp: string;
}

const recentTeardowns: TeardownEvent[] = [];

// Consumed by GET /status - auto-teardowns only ever lived in console logs
// before this, which isn't queryable from a status endpoint.
export function getRecentAutoTeardowns(): TeardownEvent[] {
    return recentTeardowns.slice(-MAX_TEARDOWN_EVENTS);
}

// Orchestrator-simple has no visibility into a pod's actual activity - the
// frontend talks to the pod directly over Socket.IO, bypassing this service
// entirely. So the reaper polls each "started" project's own /health for its
// self-reported lastActivityAt (see runner/src/ws.ts's touch()), and only
// treats a project as idle once that timestamp is old enough.
export function startReaper(stopProject: StopProjectFn) {
    console.log(
        `[reaper] started - checking every ${REAP_INTERVAL_MS / 1000}s for projects idle > ${IDLE_TIMEOUT_MS / 60000}min`
    );
    setInterval(() => {
        reapOnce(stopProject).catch((err) => console.error("[reaper] tick failed", err));
    }, REAP_INTERVAL_MS);
}

export async function reapOnce(stopProject: StopProjectFn): Promise<void> {
    const started = getStartedProjects();

    for (const project of started) {
        let lastActiveAt = project.lastActiveAt;

        try {
            const { data } = await axios.get(`http://${project.replId}.${WS_DOMAIN}/health`, {
                timeout: HEALTH_CHECK_TIMEOUT_MS,
            });
            if (typeof data.lastActivityAt === "number") {
                lastActiveAt = new Date(data.lastActivityAt).toISOString();
                updateLastActive(project.replId, lastActiveAt);
            }
        } catch (err) {
            // Pod unreachable this tick (transient network blip, or it's
            // already gone) - fall back to the last known activity rather
            // than force a teardown off a single failed check.
            console.warn(
                `[reaper] health check failed for ${project.replId}, using last known activity:`,
                err instanceof Error ? err.message : err
            );
        }

        const referenceTime = lastActiveAt ?? project.createdAt;
        const idleMs = Date.now() - new Date(referenceTime).getTime();

        if (idleMs > IDLE_TIMEOUT_MS) {
            const idleMinutes = Math.round(idleMs / 60000);
            console.log(`[reaper] AUTO-TEARDOWN ${project.replId} (owner ${project.ownerId}) - idle ${idleMinutes}min`);
            try {
                await stopProject(project.replId);
                console.log(`[reaper] AUTO-TEARDOWN complete for ${project.replId}`);
                recentTeardowns.push({
                    replId: project.replId,
                    ownerId: project.ownerId,
                    idleMinutes,
                    timestamp: new Date().toISOString(),
                });
                if (recentTeardowns.length > MAX_TEARDOWN_EVENTS) recentTeardowns.shift();
            } catch (err) {
                console.error(`[reaper] AUTO-TEARDOWN failed for ${project.replId}:`, err);
            }
        }
    }
}
