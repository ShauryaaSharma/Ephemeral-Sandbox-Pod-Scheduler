import axios from "axios";
import { CoreV1Api } from "@kubernetes/client-node";
import { markStopped } from "./db";
import { deleteProjectNamespace } from "./namespace";

// Must match the ws-facing Ingress host in service.yaml (`<replId>.<WS_DOMAIN>`)
// so this can reach the pod's Express app through the ingress controller -
// orchestrator-simple has no direct network path to pods otherwise.
const WS_DOMAIN = process.env.WS_DOMAIN ?? "peetcode.com";
const SHUTDOWN_TIMEOUT_MS = 10_000;

interface K8sApis {
    coreV1Api: CoreV1Api;
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

        // Each project has its own namespace (see namespace.ts), so deleting
        // it cascades the Deployment/Service/Ingress/NetworkPolicy in one
        // call instead of four separate deletes. Note this is asynchronous
        // on the API server's side - the namespace may still be Terminating
        // for a while after this resolves.
        await deleteProjectNamespace(apis.coreV1Api, replId);

        markStopped(replId);
    };
}

export type StopProjectFn = ReturnType<typeof createStopper>;
