# Roadmap

Things deliberately not built yet, with enough of a design that building them later doesn't start from zero.

## S3 credential-refresh endpoint (not built - optional unless you're on IRSA)

**Why this exists**: a project's STS credentials (see README "Scoped S3 credentials") are minted once, at `/start`, for `AWS_STS_SESSION_DURATION_SECONDS` (default 12h). `reaper.ts`'s `MAX_PROJECT_LIFETIME_HOURS` check force-stops a project 15 minutes before that expires, so in the normal case the session simply never runs out while the pod is up. This endpoint is only needed if that assumption breaks - which it does under **IRSA role chaining** (EKS): if `orchestrator-simple` itself assumes a role via IRSA (`AWS_WEB_IDENTITY_TOKEN_FILE` set) and then calls `AssumeRole` again for a project's scoped credentials, AWS caps the resulting session at **1 hour**, regardless of `DurationSeconds`/`MaxSessionDuration`. `scripts/aws/setup-iam.sh` detects this and warns; **on IRSA, this design is mandatory, not optional** - without it, every project's S3 access breaks after an hour whether or not the pod is still within its 12h lifetime.

**Design**:
1. Runner gains a new internal endpoint, `POST /refresh-credentials`, gated by the same per-pod `x-internal-token` check as `/health`/`/shutdown` (see README "Per-pod internal token & process isolation") - no new auth mechanism needed.
2. A background timer in the runner (or a call from `orchestrator-simple` itself, symmetric with how `reaper.ts` already polls every started project) fires well before the *actual* session lifetime (on IRSA: comfortably under 1h, e.g. every 45 minutes) and calls `/refresh-credentials`.
3. `orchestrator-simple` re-runs `sts.assumeRoleForProject(replId)` (already written, `orchestrator-simple/src/sts.ts`) and calls `writeProjectCredentialsSecret` again - this already replaces the existing `sandbox-project-credentials` Secret idempotently, no new k8s API surface needed.
4. The runner's own `aws.ts` S3 client is constructed once at module load from `process.env.AWS_ACCESS_KEY_ID`/etc - it would need to either re-read the refreshed env vars (Kubernetes updates a `Secret`-sourced env var's *file* mount live, but **not** a `secretKeyRef` env var already injected into a running process - env vars are fixed at container start) or switch from `secretKeyRef` env vars to a mounted Secret volume for just these three keys, re-reading the files per S3 call (or on a timer) instead of relying on `process.env`. That volume-mount switch is the main actual code change this needs - propagating a credential rotation into a *already-running* pod's env vars doesn't work via `secretKeyRef` alone.

**Effort**: medium - mostly plumbing (a new gated endpoint, a timer, switching `aws.ts` from env vars to a re-read-able file mount for the three STS fields) rather than new concepts, since the actual AssumeRole/Secret-write logic already exists and is reused as-is.

**Status**: not built. `scripts/aws/setup-iam.sh` could not be run against a real AWS account in the environment this was built in (no AWS CLI installed, no account available), so whether the orchestrator's own identity uses IRSA is unconfirmed either way - build this before relying on STS-scoped credentials on EKS specifically.

## Admin view, if one is ever needed

`ADMIN_USER_IDS` (see README "Monitoring & guardrails") is empty by default, meaning nobody gets the cluster-wide `/status` view. If an admin view becomes genuinely necessary: use a **separate admin token** (a distinct credential/auth path, checked independently of the anonymous per-browser `userId`), not a hardcoded or specially-flagged anonymous `userId`. An anonymous, device-bound identity (see README "Auth & ownership") is the wrong kind of credential to grant elevated, cluster-wide read access to - it's trivially re-mintable by anyone (`POST /auth/session` takes no auth at all) and was never designed to carry privilege.
