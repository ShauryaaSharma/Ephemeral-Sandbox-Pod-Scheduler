import { CoreV1Api } from "@kubernetes/client-node";

// One namespace per project, not a single shared "default" - real isolation
// (RBAC/quota/naming boundaries) to sit alongside the NetworkPolicy work,
// and a side benefit: tearing a project down is one deleteNamespace call
// instead of four separate resource deletes.
export function namespaceForProject(replId: string): string {
    return `sandbox-${replId}`;
}

// Kubernetes Secrets are namespace-scoped - the sandbox-secrets Secret
// created once by k8s/create-secret.sh only exists in whatever namespace it
// was created in (SECRETS_SOURCE_NAMESPACE, default "default"). Found by
// actually starting a project: the runner pod's secretKeyRef envs couldn't
// resolve at all in its own fresh namespace, since nothing had ever copied
// the Secret there.
const SECRETS_SOURCE_NAMESPACE = process.env.SECRETS_SOURCE_NAMESPACE ?? "default";
const SANDBOX_SECRET_NAME = "sandbox-secrets";

// Every project pod needs the public verify key; the bucket-wide AWS keys
// are only copied in the legacy (no AWS_STS_ROLE_ARN) fallback - once STS is
// configured, the pod gets its own per-project scoped credentials instead
// (see sts.ts), so there's no reason to also hand it bucket-wide ones.
const BASE_COPIED_KEYS = ["JWT_PUBLIC_KEY"];
const LEGACY_AWS_KEYS = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"];

function isConflict(err: unknown): boolean {
    return (err as { statusCode?: number })?.statusCode === 409;
}

function isNotFound(err: unknown): boolean {
    return (err as { statusCode?: number })?.statusCode === 404;
}

// Copies only the listed keys from the source Secret, not the whole thing -
// a project namespace (and the pod inside it) should only ever receive what
// it actually needs, not every credential the cluster-wide Secret happens to
// hold (e.g. nothing here ever copies JWT_PRIVATE_KEY - that key doesn't
// even live in this Secret, see auth.ts/create-secret.sh).
async function copySandboxSecret(coreV1Api: CoreV1Api, targetNamespace: string, keys: string[]): Promise<void> {
    const { body: source } = await coreV1Api.readNamespacedSecret(SANDBOX_SECRET_NAME, SECRETS_SOURCE_NAMESPACE);
    const data: Record<string, string> = {};
    for (const key of keys) {
        if (source.data?.[key]) data[key] = source.data[key];
    }
    try {
        await coreV1Api.createNamespacedSecret(targetNamespace, {
            metadata: { name: SANDBOX_SECRET_NAME },
            type: source.type,
            data,
        });
    } catch (err) {
        if (!isConflict(err)) throw err;
    }
}

// Idempotent: safe to call even if the namespace already exists (e.g. a
// retried /start, or restarting a previously-stopped project).
export async function ensureNamespace(
    coreV1Api: CoreV1Api,
    replId: string,
    includeLegacyAwsKeys: boolean
): Promise<string> {
    const namespace = namespaceForProject(replId);
    try {
        await coreV1Api.createNamespace({
            metadata: { name: namespace, labels: { "sandbox-scheduler/repl-id": replId } },
        });
    } catch (err) {
        if (!isConflict(err)) throw err;
    }
    const keys = includeLegacyAwsKeys ? [...BASE_COPIED_KEYS, ...LEGACY_AWS_KEYS] : BASE_COPIED_KEYS;
    await copySandboxSecret(coreV1Api, namespace, keys);
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
