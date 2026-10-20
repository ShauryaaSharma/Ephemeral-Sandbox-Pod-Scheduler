import { STS } from "aws-sdk";
import { CoreV1Api } from "@kubernetes/client-node";

// Secret created in the project namespace (next to the copied sandbox-secrets
// Secret - see namespace.ts) holding this project's scoped, temporary S3
// credentials. Only populated when AWS_STS_ROLE_ARN is set.
export const PROJECT_CREDENTIALS_SECRET_NAME = "sandbox-project-credentials";

const AWS_STS_ROLE_ARN = process.env.AWS_STS_ROLE_ARN;
const S3_BUCKET = process.env.S3_BUCKET ?? "";
const SESSION_DURATION_SECONDS = Number(process.env.AWS_STS_SESSION_DURATION_SECONDS) || 3600;

if (!AWS_STS_ROLE_ARN) {
    // eslint-disable-next-line no-console
    console.warn(
        "[sts] AWS_STS_ROLE_ARN is not set - project pods will be issued the bucket-wide " +
            "AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY from the 'sandbox-secrets' Secret instead of " +
            "credentials scoped to their own S3 prefix. This mode is NOT isolated per project: any " +
            "project's pod can read/write any other project's files in the bucket. See the README " +
            "'Scoped S3 credentials' section to configure STS-based isolation."
    );
}

export function isStsEnabled(): boolean {
    return Boolean(AWS_STS_ROLE_ARN);
}

const sts = new STS();

export interface ScopedCredentials {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken: string;
}

// Scoped to exactly what a project's pod needs: read/write its own files
// under code/<replId>/, and list only that prefix (not the whole bucket).
function sessionPolicy(replId: string): string {
    const objectPrefix = `code/${replId}/*`;
    return JSON.stringify({
        Version: "2012-10-17",
        Statement: [
            {
                Effect: "Allow",
                Action: ["s3:GetObject", "s3:PutObject"],
                Resource: `arn:aws:s3:::${S3_BUCKET}/${objectPrefix}`,
            },
            {
                Effect: "Allow",
                Action: ["s3:ListBucket"],
                Resource: `arn:aws:s3:::${S3_BUCKET}`,
                Condition: { StringLike: { "s3:prefix": [objectPrefix] } },
            },
        ],
    });
}

export async function assumeRoleForProject(replId: string): Promise<ScopedCredentials> {
    const { Credentials } = await sts
        .assumeRole({
            RoleArn: AWS_STS_ROLE_ARN as string,
            RoleSessionName: `sandbox-${replId}`.slice(0, 64),
            DurationSeconds: SESSION_DURATION_SECONDS,
            Policy: sessionPolicy(replId),
        })
        .promise();
    if (!Credentials) {
        throw new Error(`STS AssumeRole for ${replId} returned no credentials`);
    }
    return {
        accessKeyId: Credentials.AccessKeyId,
        secretAccessKey: Credentials.SecretAccessKey,
        sessionToken: Credentials.SessionToken,
    };
}

// Idempotent: a retried /start (or a restart within the same STS session
// lifetime) replaces rather than conflicts on an already-existing secret.
export async function writeProjectCredentialsSecret(
    coreV1Api: CoreV1Api,
    namespace: string,
    creds: ScopedCredentials
): Promise<void> {
    const body = {
        metadata: { name: PROJECT_CREDENTIALS_SECRET_NAME },
        stringData: {
            AWS_ACCESS_KEY_ID: creds.accessKeyId,
            AWS_SECRET_ACCESS_KEY: creds.secretAccessKey,
            AWS_SESSION_TOKEN: creds.sessionToken,
        },
    };
    try {
        await coreV1Api.createNamespacedSecret(namespace, body);
    } catch (err) {
        if ((err as { statusCode?: number })?.statusCode !== 409) throw err;
        await coreV1Api.replaceNamespacedSecret(PROJECT_CREDENTIALS_SECRET_NAME, namespace, body);
    }
}
