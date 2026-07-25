import axios from "axios";
import { CoreV1Api } from "@kubernetes/client-node";
import { getStartedProjects, markUnhealthy, markHealthy, updateRestartCount, ProjectRecord } from "./db";
import { checkPodHealth } from "./monitor";

const MONITOR_INTERVAL_MS = (Number(process.env.HEALTH_CHECK_INTERVAL_SECONDS) || 30) * 1000;
const ALERT_WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL;
const MAX_ALERTS = 50;

export interface AlertEvent {
    replId: string;
    ownerId: string;
    reason: string;
    restartCount: number;
    timestamp: string;
}

const recentAlerts: AlertEvent[] = [];

export function getRecentAlerts(): AlertEvent[] {
    return recentAlerts.slice(-MAX_ALERTS);
}

// Slack-compatible payload shape ({text: ...}) - also works as a generic
// "post this JSON somewhere" hook for Discord (via a Slack-compatible
// webhook URL) or any endpoint that just wants the message. Best-effort:
// failures here must never break health monitoring itself.
async function fireAlertWebhook(event: AlertEvent): Promise<void> {
    if (!ALERT_WEBHOOK_URL) return;
    try {
        await axios.post(
            ALERT_WEBHOOK_URL,
            {
                text: `:rotating_light: Project *${event.replId}* (owner ${event.ownerId}) is crash-looping - reason: ${event.reason}, restarts: ${event.restartCount}`,
            },
            { timeout: 5000 }
        );
    } catch (err) {
        console.error("[health] failed to send alert webhook:", err instanceof Error ? err.message : err);
    }
}

export function startHealthMonitor(coreV1Api: CoreV1Api): void {
    console.log(
        `[health] started - checking every ${MONITOR_INTERVAL_MS / 1000}s, crash-loop threshold ${
            process.env.CRASH_RESTART_THRESHOLD || 5
        } restarts`
    );
    setInterval(() => {
        monitorOnce(coreV1Api).catch((err) => console.error("[health] tick failed", err));
    }, MONITOR_INTERVAL_MS);
}

export async function monitorOnce(coreV1Api: CoreV1Api): Promise<void> {
    const projects = getStartedProjects();

    for (const project of projects) {
        await checkOneProject(coreV1Api, project);
    }
}

async function checkOneProject(coreV1Api: CoreV1Api, project: ProjectRecord): Promise<void> {
    let health;
    try {
        health = await checkPodHealth(coreV1Api, project.replId);
    } catch (err) {
        console.warn(`[health] failed to check pod status for ${project.replId}:`, err instanceof Error ? err.message : err);
        return;
    }

    // Pod not found (not yet scheduled, or gone) - nothing to report yet;
    // teardown bookkeeping for genuinely deleted pods is handled elsewhere
    // (POST /stop, the idle reaper), not this monitor's job.
    if (!health.found) return;

    updateRestartCount(project.replId, health.restartCount);

    const wasUnhealthy = project.healthStatus === "unhealthy";

    if (health.crashLooping && !wasUnhealthy) {
        const reason = health.oomKilled ? "OOMKilled" : health.reason ?? "CrashLoopBackOff";
        console.error(
            `[health] ALERT: ${project.replId} (owner ${project.ownerId}) is crash-looping - reason=${reason} restarts=${health.restartCount}`
        );
        markUnhealthy(project.replId, reason);
        const event: AlertEvent = {
            replId: project.replId,
            ownerId: project.ownerId,
            reason,
            restartCount: health.restartCount,
            timestamp: new Date().toISOString(),
        };
        recentAlerts.push(event);
        if (recentAlerts.length > MAX_ALERTS) recentAlerts.shift();
        await fireAlertWebhook(event);
    } else if (!health.crashLooping && wasUnhealthy) {
        console.log(`[health] RECOVERED: ${project.replId} is healthy again`);
        markHealthy(project.replId);
    }
}
