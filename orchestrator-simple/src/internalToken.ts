import { createHmac } from "crypto";
import { CoreV1Api } from "@kubernetes/client-node";

const INTERNAL_API_MASTER_KEY = process.env.INTERNAL_API_MASTER_KEY;
if (!INTERNAL_API_MASTER_KEY) {
    throw new Error("INTERNAL_API_MASTER_KEY environment variable is required");
}

// Secret written into each project's own namespace, holding only that
// project's derived token - never the master key itself (see
// k8s/create-secret.sh / k8s/scheduler-services.yaml for where the master
// key actually lives: a secretRef only on orchestrator-simple's own
// deployment, never copied into a project namespace).
export const POD_TOKEN_SECRET_NAME = "sandbox-internal-token";

// Deterministic per-project token - orchestrator-simple never stores or
// looks up a per-pod secret, it just recomputes this from the master key it
// already holds plus the replId already in scope. A leaked pod token only
// ever exposes that one project's /health and /shutdown, not every
// project's shared secret the way a single static INTERNAL_API_TOKEN did.
export function derivePodToken(replId: string): string {
    return createHmac("sha256", INTERNAL_API_MASTER_KEY as string).update(replId).digest("hex");
}

// Idempotent, matching sts.ts's writeProjectCredentialsSecret pattern.
export async function writePodTokenSecret(coreV1Api: CoreV1Api, namespace: string, replId: string): Promise<void> {
    const body = {
        metadata: { name: POD_TOKEN_SECRET_NAME },
        stringData: { INTERNAL_API_TOKEN: derivePodToken(replId) },
    };
    try {
        await coreV1Api.createNamespacedSecret(namespace, body);
    } catch (err) {
        if ((err as { statusCode?: number })?.statusCode !== 409) throw err;
        await coreV1Api.replaceNamespacedSecret(POD_TOKEN_SECRET_NAME, namespace, body);
    }
}
