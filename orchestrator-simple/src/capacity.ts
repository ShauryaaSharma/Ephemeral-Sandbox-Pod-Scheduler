import { CoreV1Api } from "@kubernetes/client-node";
import { namespaceForProject } from "./namespace";

const SCHEDULE_CHECK_DELAY_MS = 4000; // give the scheduler a moment to react first
const SCHEDULE_CHECK_TIMEOUT_MS = 8000;
const SCHEDULE_POLL_INTERVAL_MS = 1000;

// Best-effort retry for transient k8s API errors (e.g. a brief apiserver
// hiccup). NOT for scheduling failures - those don't surface as thrown
// errors from the create calls at all, see checkPodSchedulable below.
export async function withRetry<T>(fn: () => Promise<T>, attempts = 3, baseDelayMs = 500): Promise<T> {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            const statusCode = (err as { statusCode?: number })?.statusCode;
            // A 4xx (bad request, conflict, quota) will never succeed on
            // retry - only retry things that look transient/server-side.
            if (statusCode && statusCode < 500) throw err;
            if (i < attempts - 1) {
                await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** i));
            }
        }
    }
    throw lastErr;
}

export interface SchedulabilityResult {
    schedulable: boolean;
    reason?: string;
}

// Kubernetes happily accepts a Deployment even when no node can ever
// schedule its pod - that failure shows up later as the pod sitting in
// Pending with a PodScheduled=False/Unschedulable condition, not as a
// thrown error from the create call. This gives the scheduler a short
// window to react and polls for that specific signal.
export async function checkPodSchedulable(coreV1Api: CoreV1Api, replId: string): Promise<SchedulabilityResult> {
    await new Promise((resolve) => setTimeout(resolve, SCHEDULE_CHECK_DELAY_MS));

    const namespace = namespaceForProject(replId);
    const deadline = Date.now() + SCHEDULE_CHECK_TIMEOUT_MS;

    while (Date.now() < deadline) {
        const { body } = await coreV1Api.listNamespacedPod(
            namespace,
            undefined,
            undefined,
            undefined,
            undefined,
            `app=${replId}`
        );
        const pod = body.items[0];
        if (pod) {
            const scheduledCondition = pod.status?.conditions?.find((c) => c.type === "PodScheduled");
            if (scheduledCondition?.status === "False" && scheduledCondition.reason === "Unschedulable") {
                return { schedulable: false, reason: scheduledCondition.message ?? "Insufficient cluster resources" };
            }
            if (scheduledCondition?.status === "True" || pod.status?.phase === "Running") {
                return { schedulable: true };
            }
        }
        await new Promise((resolve) => setTimeout(resolve, SCHEDULE_POLL_INTERVAL_MS));
    }

    // Ambiguous (still pending, no clear Unschedulable signal within the
    // check window) - treat as schedulable rather than roll back a project
    // that's just taking a bit longer to bind; the crash-loop health monitor
    // will catch it later if it's genuinely stuck.
    return { schedulable: true };
}

export interface TranslatedError {
    status: number;
    message: string;
}

// Never leak a raw Kubernetes API error body to the frontend - translate the
// common cases into something a user-facing error message can show.
export function translateK8sError(err: unknown): TranslatedError {
    const statusCode = (err as { statusCode?: number })?.statusCode;
    const body = (err as { body?: { message?: string } })?.body;
    const bodyMessage = body?.message ?? "";

    if (statusCode === 409) {
        return {
            status: 409,
            message: "This project's resources already exist - a previous start may still be in progress.",
        };
    }
    if (statusCode === 403 && /quota/i.test(bodyMessage)) {
        return {
            status: 503,
            message: "Cluster capacity limit reached (resource quota exceeded). Please try again later.",
        };
    }
    return { status: 500, message: "Failed to create resources due to an unexpected cluster error." };
}
