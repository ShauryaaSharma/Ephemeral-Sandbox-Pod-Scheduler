import { CoreV1Api, Metrics } from "@kubernetes/client-node";
import { namespaceForProject } from "./namespace";

const RESTART_THRESHOLD = Number(process.env.CRASH_RESTART_THRESHOLD) || 5;

export interface PodHealth {
    found: boolean;
    phase?: string;
    restartCount: number;
    crashLooping: boolean;
    oomKilled: boolean;
    reason?: string;
}

// Pods are labeled `app: <replId>` (see service.yaml), same selector the
// Service/NetworkPolicy already use to target this project's pod.
export async function checkPodHealth(coreV1Api: CoreV1Api, replId: string): Promise<PodHealth> {
    const { body } = await coreV1Api.listNamespacedPod(
        namespaceForProject(replId),
        undefined,
        undefined,
        undefined,
        undefined,
        `app=${replId}`
    );
    const pod = body.items[0];
    if (!pod) {
        return { found: false, restartCount: 0, crashLooping: false, oomKilled: false };
    }

    const containerStatus =
        pod.status?.containerStatuses?.find((c) => c.name === "runner") ?? pod.status?.containerStatuses?.[0];
    const restartCount = containerStatus?.restartCount ?? 0;
    const waitingReason = containerStatus?.state?.waiting?.reason;
    const lastTerminatedReason = containerStatus?.lastState?.terminated?.reason;
    const oomKilled = lastTerminatedReason === "OOMKilled";
    // CrashLoopBackOff is Kubernetes' own signal for "kubelet gave up
    // restarting this quickly" - the restart-count threshold catches the
    // slower-burning case where it's crashing but backoff hasn't kicked in
    // hard enough yet to report that reason.
    const crashLooping = waitingReason === "CrashLoopBackOff" || restartCount >= RESTART_THRESHOLD;

    return {
        found: true,
        phase: pod.status?.phase,
        restartCount,
        crashLooping,
        oomKilled,
        reason: waitingReason ?? lastTerminatedReason,
    };
}

export interface PodResourceUsage {
    cpu: string;
    memory: string;
}

// Best-effort: requires metrics-server installed in the cluster. Returns
// null (not a thrown error up to the caller) if it's unavailable, since a
// missing metrics-server shouldn't break health checks or /status.
export async function getPodResourceUsage(
    metricsClient: Metrics,
    replId: string
): Promise<PodResourceUsage | null> {
    try {
        const metrics = await metricsClient.getPodMetrics(namespaceForProject(replId), { labelSelector: `app=${replId}` });
        const pod = metrics.items[0];
        const container = pod?.containers.find((c) => c.name === "runner") ?? pod?.containers[0];
        if (!container) return null;
        return { cpu: container.usage.cpu, memory: container.usage.memory };
    } catch {
        return null;
    }
}
