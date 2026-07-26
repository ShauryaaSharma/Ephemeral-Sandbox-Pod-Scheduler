import { CoreV1Api } from "@kubernetes/client-node";

// One namespace per project, not a single shared "default" - real isolation
// (RBAC/quota/naming boundaries) to sit alongside the NetworkPolicy work,
// and a side benefit: tearing a project down is one deleteNamespace call
// instead of four separate resource deletes.
export function namespaceForProject(replId: string): string {
    return `sandbox-${replId}`;
}

function isConflict(err: unknown): boolean {
    return (err as { statusCode?: number })?.statusCode === 409;
}

function isNotFound(err: unknown): boolean {
    return (err as { statusCode?: number })?.statusCode === 404;
}

// Idempotent: safe to call even if the namespace already exists (e.g. a
// retried /start, or restarting a previously-stopped project).
export async function ensureNamespace(coreV1Api: CoreV1Api, replId: string): Promise<string> {
    const namespace = namespaceForProject(replId);
    try {
        await coreV1Api.createNamespace({
            metadata: { name: namespace, labels: { "sandbox-scheduler/repl-id": replId } },
        });
    } catch (err) {
        if (!isConflict(err)) throw err;
    }
    return namespace;
}

// Namespace deletion is asynchronous in Kubernetes (Terminating phase,
// finalizers) - this call returning doesn't mean the namespace (or its
// contents) is actually gone yet. A rapid stop-then-restart of the same
// replId may need to wait for the old one to fully terminate before a new
// namespace with the same name can be created again.
export async function deleteProjectNamespace(coreV1Api: CoreV1Api, replId: string): Promise<void> {
    const namespace = namespaceForProject(replId);
    try {
        await coreV1Api.deleteNamespace(namespace);
    } catch (err) {
        if (!isNotFound(err)) throw err;
    }
}
