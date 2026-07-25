import axios from "axios";
import { AppsV1Api, CoreV1Api, NetworkingV1Api } from "@kubernetes/client-node";
import { markStopped } from "./db";

// Must match the ws-facing Ingress host in service.yaml (`<replId>.<WS_DOMAIN>`)
// so this can reach the pod's Express app through the ingress controller -
// orchestrator-simple has no direct network path to pods otherwise.
const WS_DOMAIN = process.env.WS_DOMAIN ?? "peetcode.com";
const NAMESPACE = "default";
const SHUTDOWN_TIMEOUT_MS = 10_000;

function isNotFoundError(err: unknown): boolean {
    return (err as { statusCode?: number })?.statusCode === 404;
}

interface K8sApis {
    appsV1Api: AppsV1Api;
    coreV1Api: CoreV1Api;
    networkingV1Api: NetworkingV1Api;
}

export function createStopper(apis: K8sApis) {
    return async function stopProject(replId: string): Promise<void> {
        // Best-effort final sync, bounded so a stuck/unreachable pod can't
        // block teardown indefinitely - proceed regardless of the outcome.
        try {
            await axios.post(`http://${replId}.${WS_DOMAIN}/shutdown`, {}, { timeout: SHUTDOWN_TIMEOUT_MS });
        } catch (err) {
            console.warn(
                `[stop] final sync for ${replId} failed or timed out, proceeding with teardown anyway:`,
                err instanceof Error ? err.message : err
            );
        }

        const results = await Promise.allSettled([
            apis.appsV1Api.deleteNamespacedDeployment(replId, NAMESPACE),
            apis.coreV1Api.deleteNamespacedService(replId, NAMESPACE),
            apis.networkingV1Api.deleteNamespacedIngress(replId, NAMESPACE),
            apis.networkingV1Api.deleteNamespacedNetworkPolicy(replId, NAMESPACE),
        ]);

        const realFailures = results.filter(
            (r): r is PromiseRejectedResult => r.status === "rejected" && !isNotFoundError(r.reason)
        );
        if (realFailures.length > 0) {
            throw new Error(
                `failed to delete ${realFailures.length} resource(s) for ${replId}: ` +
                    realFailures.map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason))).join("; ")
            );
        }

        markStopped(replId);
    };
}

export type StopProjectFn = ReturnType<typeof createStopper>;
