# Architecture & design notes

Deep-dive reference for this project: request flow, security model, every
environment variable, and the trade-offs behind each decision. The
[README](../README.md) covers what the project is and how to run it; this
doc covers *why* it's built the way it is. See the README's architecture
diagram for the high-level picture before reading the walkthrough below.

## How it works

1. **Auth bootstrap**: on first load, the frontend calls `POST /auth/session` on `init-service` and caches the anonymous session token it gets back (see [Auth & ownership](#auth--ownership)). Every request below carries this token.
2. **Project creation**: `POST /project` on `init-service` verifies the token, rejects an already-taken `replId` (409), copies a base template (`node-js` or `python`) from S3/R2 into `code/<replId>`, and records `(replId, ownerId)` in a shared SQLite table. This step only prepares storage; it does not start any compute.
3. **Pod scheduling**: when a user opens a project, the frontend calls `POST /start` on `orchestrator-simple` with the `replId`. The orchestrator verifies the token, checks the caller owns this `replId` (403/404 otherwise), then reads a parameterized Kubernetes manifest ([`service.yaml`](../orchestrator-simple/service.yaml)), substitutes `service_name` → `replId` and `owner_id_placeholder` → the verified owner across every document, and creates each resource via the Kubernetes API (`@kubernetes/client-node`):
   - a **Deployment** running the `runner` image, with an **init container** that `aws s3 cp`s that project's files from the bucket into a mounted `emptyDir` volume before the main container starts
   - a **Service** exposing the pod's port `3001` (WebSocket) and `3000` (the user's own running app)
   - an **Ingress** routing `<replId>.<domain>` (two configured hostnames) to those ports
   - a **NetworkPolicy** scoping that pod's ingress/egress (see [Network policy](#network-policy))
4. **Editing & terminal**: the frontend connects a Socket.IO client directly to `ws://<replId>.<domain>`, presenting its token in the handshake. The `runner` inside that specific pod identifies which project it's serving from its own `REPL_ID` env var (injected by the orchestrator at pod-creation time - not the request's Host header, which is client-controlled and not trustworthy for this, and not a query param either, since there's exactly one project per pod), and rejects the connection unless the token's owner matches the pod's own `OWNER_ID`. File read/write and terminal I/O work the same way as the single-host version, except everything happens inside `/workspace` (the volume the init container populated) rather than a shared local `tmp/` folder, and every path is resolved and bounds-checked against `/workspace` before any filesystem or S3 access (see [Path safety](#path-safety)).
5. **Live preview**: the frontend's Output panel points its iframe at `http://<replId>.<domain>`, which the Ingress routes to the pod's port `3000`. On boot, the runner also auto-detects the project type and runs its install+start command in the background (see [Automatic run step](#automatic-run-step)), so this is usually already live; the user can still run their own commands manually in the terminal too.

## Lifecycle: stop, graceful shutdown, idle timeout

- **`POST /stop`** (orchestrator-simple, auth + ownership gated like `/start`) tears a project down: it first calls the pod's `POST /shutdown` (see below) to flush any pending file state to S3/R2, then deletes the Deployment/Service/Ingress/NetworkPolicy. Deleting an already-missing resource (e.g. a retried or partial `/stop`) is treated as success, not failure - only genuine API errors surface as a 500.
- **Graceful shutdown**: the runner exposes `POST /shutdown`, which first flushes any pending debounced S3 write (see `ws.ts`'s `updateContent` handler and `S3_WRITE_DEBOUNCE_MS`) and then recursively re-uploads every file under `/workspace` to S3/R2 (`runner/src/sync.ts`) as a belt-and-suspenders pass covering any edit whose debounced write hadn't fired yet. The same sequence also runs on `SIGTERM` as a safety net, in case a pod is torn down without `/stop` being called first (e.g. `kubectl delete pod` directly). Both paths are bounded to 8s internally, and orchestrator's call to `/shutdown` is bounded to 10s - a stuck or unreachable pod never blocks teardown, it just proceeds anyway and logs a warning.
- **Idle-timeout reaper**: the runner tracks its own last-activity timestamp in memory (`ws.ts`, updated on connect and on every terminal/file event) and exposes it via `GET /health`. A background loop in orchestrator-simple (`src/reaper.ts`) polls every `REAPER_INTERVAL_SECONDS` for all projects it thinks are running, refreshes their last-active time from `/health`, and calls the same stop-with-sync logic on anything idle longer than `IDLE_TIMEOUT_MINUTES` - logging `[reaper] AUTO-TEARDOWN ...` so it's auditable. A pod that's temporarily unreachable doesn't get force-reaped off one failed check; the reaper falls back to the last known activity time instead.
- **Max project lifetime**: the same reaper tick also force-stops any project older than `MAX_PROJECT_LIFETIME_HOURS` minus 15 minutes (tracked via a `started_at` column, set fresh on every `/start`, distinct from `last_active_at`) - regardless of activity. This exists for [Scoped S3 credentials](#scoped-s3-credentials): it guarantees a project's STS session is torn down before its credentials would expire, not just after it goes idle.
- Project status (`created` / `started` / `stopped`) and last-active time live in the same SQLite ownership table used for auth (see [Auth & ownership](#auth--ownership)), with a migration that adds these columns to a pre-existing DB file if needed.
- **`/shutdown` and `/health` require an internal token.** They're internal, orchestrator-only endpoints reachable at the same ingress host as the user-facing app, so both require an `x-internal-token` header equal to this pod's own derived token (compared with `crypto.timingSafeEqual`), returning `401` otherwise. See [Per-pod internal token & process isolation](#per-pod-internal-token--process-isolation).
- `/healthz`/`/readyz` (unauthenticated, no data) exist separately for Kubernetes probes - see [Probes & termination](#probes--termination).
- **Not implemented**: pod pre-warming - see [Roadmap](#roadmap).

## Monitoring & guardrails

- **Per-pod resource usage** (`orchestrator-simple/src/monitor.ts`): reads live CPU/memory from the Kubernetes Metrics API (`metrics.k8s.io`, via `@kubernetes/client-node`'s `Metrics` client), not just the static `resources.limits` already in the manifest. **Requires `metrics-server` installed in your cluster** - if it's not, this fails closed (returns `null` per project) rather than breaking health checks or `/status`.
- **Crash-loop / OOM detection** (`src/healthMonitor.ts`): a background loop, separate from the idle reaper, checks every started project's pod status via the Kubernetes API every `HEALTH_CHECK_INTERVAL_SECONDS`. A pod is considered crash-looping if its container reports the `CrashLoopBackOff` waiting reason **or** its restart count reaches `CRASH_RESTART_THRESHOLD` (whichever fires first - the threshold catches the slower-burning case where kubelet hasn't reported that reason yet). `OOMKilled` is detected separately from the container's last-terminated reason and reported alongside.
- **Throttled response, not silent auto-restart**: this project never restarts pods itself (kubelet already owns that via `restartPolicy`). What "stop trying to auto-recover" means here concretely: once a project crosses the crash-loop threshold, it's marked `unhealthy` in the ownership table (a `health_status` column, orthogonal to the `started`/`stopped` lifecycle `status` - a pod can be started *and* unhealthy at the same time) and stops being silently treated as fine. Recovery is automatic and symmetric: the next check that finds the pod no longer crash-looping flips it back to `healthy`.
- **`GET /status`** (orchestrator-simple, auth required, ownership-scoped by default): returns only the caller's own active pods - total count, unhealthy count, each one's health/restart-count/resource-usage, and only that caller's recent auto-teardowns/crash-loop alerts. Set `ADMIN_USER_IDS` (comma-separated userIds) to opt specific users into the old cluster-wide view instead.
- **`GET /projects/:replId/status`**: the single-project counterpart, for the frontend - returns just one project's lifecycle status, health status, restart count, and reason. Also ownership-scoped (403 for a project you don't own), with the same `ADMIN_USER_IDS` bypass. `CodingPage.tsx` polls this every 20s and shows a banner ("this project's pod is unhealthy...") when it comes back unhealthy, instead of a silently broken terminal.
- **Alerting webhook** (optional): set `ALERT_WEBHOOK_URL` to a Slack incoming-webhook URL (or any endpoint that accepts `{text: "..."}` - Discord and log-sink proxies both work this way) and a message fires the moment a project crosses into `unhealthy`. No webhook configured = alerts still land in `/status` and logs, just no push notification.

## Auth & ownership

There is no login/password/email anywhere in this project - adding real user accounts was out of scope. Instead:

1. On first load, the frontend calls `POST /auth/session` on `init-service` (no auth required - this **is** the bootstrap), which generates a random `userId` (`crypto.randomUUID()`), signs a JWT `{ userId }` with its `JWT_PRIVATE_KEY` (ES256 - see [JWT keys](#jwt-keys)), and returns it. The frontend caches this token in `localStorage` and sends it as `Authorization: Bearer <token>` on `/project` and `/start`, and as `{ auth: { token } }` on the Socket.IO connection to the pod. `orchestrator-simple` and the `runner` pod only ever hold the matching `JWT_PUBLIC_KEY` and can verify a token but never mint one.
2. `POST /project` (init-service) requires a valid bearer token, rejects a `replId` that's already taken (409), and records `(replId, ownerId, createdAt)` in a shared SQLite table.
3. `POST /start` (orchestrator-simple) requires a valid bearer token, looks up the `replId`'s owner, and rejects with `404` if the project doesn't exist or `403` if the caller isn't the owner. On success, it injects the verified `ownerId` into the pod as `OWNER_ID` (same substitution mechanism as `REPL_ID`) - no DB access needed inside the pod itself.
4. The runner's Socket.IO connection handler verifies the token in the handshake (`socket.handshake.auth.token`) and disconnects unless the token's `userId` matches the pod's own `OWNER_ID`.

**This is intentionally a lightweight, anonymous, device-bound identity, not a real auth system** - a token just proves "the same browser that created this project is asking again." Clearing `localStorage` forfeits access to your own projects (no recovery mechanism), and there's no protection against someone deliberately exporting/sharing their token. Swapping in a real identity provider later would only require changing how `/auth/session` issues tokens - everything downstream (the bearer-token middleware, the ownership table, the socket check) stays the same.

**Trade-off on `OWNERSHIP_DB_PATH`:** init-service and orchestrator-simple both read/write the same SQLite file directly rather than one service calling the other's API. That's the lightest option for two services that, today, are expected to run on the same host - but it means they **must** share a filesystem. If you deploy them on separate hosts/containers, either point `OWNERSHIP_DB_PATH` at a shared volume, or (better, for real multi-host deployment) replace the direct file access with a tiny internal ownership API that one service exposes and the other calls.

## JWT keys

**Why ES256, not EdDSA**: EdDSA (Ed25519) would be the first choice for a new asymmetric JWT setup - smaller keys, faster, no nonce-related footguns - but the installed `jsonwebtoken`/`jwa` version in this repo doesn't support it at all (confirmed by actually trying to sign with `algorithm: "EdDSA"`: `"algorithm" must be a valid string enum value` - `jwa`'s supported list is `HS256/384/512, RS256/384/512, PS256/384/512, ES256/384/512, none`, no EdDSA entry). ES256 (ECDSA P-256) is the next best fit already supported by the installed library, and keeps keys small (a public key is ~90 bytes of PEM) compared to RS256's ~2KB RSA keys.

**Algorithm pinning**: every `jwt.verify` call across all three services passes `algorithms: ["ES256"]` explicitly (never left to default to "whatever the token's own header claims"), plus the expected `issuer`/`audience`. This is what actually stops an algorithm-confusion attack - without it, a forged token claiming `alg: "HS256"` and signed with the public key (treated as an HMAC secret) would otherwise be accepted, since a public key is, after all, just bytes. Every signed token also carries a `kid` header - see rotation below.

**Rotating JWT keys**: because verification accepts a current and a previous public key, rotating doesn't log anyone out mid-rotation:

1. Generate a new pair (see HOSTING_GUIDE.md's credential-generation step for the `openssl` commands).
2. Set `JWT_PUBLIC_KEY_PREVIOUS` to the **old** public key (the one currently in `JWT_PUBLIC_KEY`), and `JWT_PUBLIC_KEY` to the **new** one, on `orchestrator-simple` and in the `sandbox-secrets` Secret (`k8s/create-secret.sh` accepts `JWT_PUBLIC_KEY_PREVIOUS` as an optional env var).
3. Set `JWT_PRIVATE_KEY` to the new private key on `init-service`.
4. Restart both. Tokens already out in users' `localStorage`, signed with the old key, keep verifying (matched by their `kid` header against the old key's own derived id) until each is naturally replaced by a fresh `POST /auth/session` call or the user clears `localStorage`.
5. Once you're confident the old key is no longer needed (or after your own chosen grace period - there's no automatic expiry, see below), remove `JWT_PUBLIC_KEY_PREVIOUS` everywhere. Any token still signed with the old key then stops verifying.

**No `exp` claim, by design**: these tokens never expire. Clearing `localStorage` already forfeits access to a project with no recovery path (see the trade-off above) - an anonymous, device-bound identity has no real session to expire in the first place, so adding `exp` would only be one more way to get silently locked out of your own project, not a real security boundary. The only thing that invalidates an existing token today is rotating past it (above).

## Per-pod internal token & process isolation

**Derived, not shared, internal tokens**: `orchestrator-simple` holds one `INTERNAL_API_MASTER_KEY`, kept only in its own Secret (`orchestrator-secrets`) and never set on a project pod. Each project's own `x-internal-token` (the one gating its `/health`/`/shutdown`, above) is `HMAC-SHA256(INTERNAL_API_MASTER_KEY, replId)` in hex (`orchestrator-simple/src/internalToken.ts`), written into that project's own `sandbox-internal-token` Secret at `/start` time. `stop.ts`/`reaper.ts` recompute it from the master key on every call instead of storing or looking anything up. A leaked per-pod token only ever exposes that one project's two internal endpoints, not every project's.

**The user's shell runs as a different uid than the runner process**: before this, `cat /proc/1/environ` inside a project's own terminal could read the `runner` process's full environment (`JWT_PUBLIC_KEY`, the per-pod internal token, and the bucket-wide AWS keys in the legacy S3 fallback) - the per-terminal env whitelist (see [runner/src/pty.ts](../runner/src/pty.ts)/`shellEnv.ts`) only limits what a *new* shell process inherits at spawn time, it does nothing to stop that shell from directly reading an *already-running*, same-uid process's `/proc/<pid>/environ` (Linux grants that read to either a matching uid or `CAP_SYS_PTRACE` - same-uid was all it took here).

The fix changes which uid each piece runs as, not whether the whitelist still applies (it does, unchanged):
- The `runner` container now runs as uid 0 (root) with every capability dropped **except** `CAP_SETUID`/`CAP_SETGID` - explicitly on the Pod Security Admission "baseline" allow-list this namespace already enforces (unlike "restricted", baseline has no non-root requirement). Without `CAP_DAC_OVERRIDE`/`CAP_DAC_READ_SEARCH`, this uid-0 process gets **no** file-permission bypass - it reads/writes `/workspace` through the exact same group-permission path (`gid 1000`, matching the pod's `fsGroup`) as everything else here, not because it's root.
- Every terminal session (and autorun - both go through the same `TerminalManager.createPty`) is spawned via `node-pty`'s `uid`/`gid` options as `SANDBOX_SHELL_UID`/`SANDBOX_SHELL_GID` (default `1001`/`1000` in `service.yaml`) - a uid distinct from the runner container's own (0).
- Without `CAP_SYS_PTRACE`, the runner process can no longer read a different-uid process's `/proc/<pid>/environ` either - and, critically, the reverse: the user's shell (uid 1001, no special capabilities at all once node-pty has dropped to it) cannot read the runner's (uid 0) `/proc/1/environ`, since that read also requires `CAP_SYS_PTRACE` on the *reader's* side, which the shell never has.

`scripts/verify-isolation.sh`, run inside a live pod's terminal, checks exactly this (`env`, `/proc/1/environ`, the mounted-service-account-token check, and the egress rules below) and prints PASS/FAIL for each. This has not been run against a live cluster - no cluster was available in the environment this was built in.

## Probes & termination

`runner` exposes unauthenticated, no-data `/healthz` (process alive) and `/readyz` (server listening and `/workspace` populated); `init-service`/`orchestrator-simple` expose `/healthz`. All three wire into `startupProbe`/`readinessProbe`/`livenessProbe` on their respective Deployments. `terminationGracePeriodSeconds: 20` on the project pod gives the runner's 8s graceful-shutdown sync room to finish before Kubernetes sends `SIGKILL`.

## Path safety

Every `fetchDir`/`fetchContent`/`updateContent` call goes through `resolveInWorkspace` (`runner/src/fs.ts`) before touching the filesystem: it joins the caller-supplied path onto `/workspace` and rejects the result unless it still resolves inside `/workspace` (e.g. a `../../etc/passwd`-style traversal). `updateContent`'s S3 key is built from that same resolved path, not the raw client-supplied string, so a traversal attempt can't produce a different S3 key than the file it actually wrote to on disk. `updateContent` also rejects payloads over `MAX_FILE_UPDATE_BYTES` (default 1MB).

The runner also no longer trusts the Socket.IO connection's Host header to determine which project it's serving - that header is entirely client-controlled, so a client that could reach the pod directly (bypassing the ingress's subdomain routing) could previously claim to be any project. It now reads its own `REPL_ID` env var instead, injected by the orchestrator at pod-creation time and identical to what every other per-pod identity check (`OWNER_ID`, `/health`, autorun) already relies on.

## Automatic run step

On startup, the runner scans `/workspace` (already populated by the init container by the time the main container starts) and, best-effort, kicks off an install+start command in a dedicated background terminal session (`runner/src/autorun.ts`) so the Output iframe has something listening on port 3000 without the user typing commands manually:

1. **`Procfile`** at the workspace root (`web: <command>`) — wins over everything else, for projects that need a start command the heuristics below don't cover.
2. **`package.json`** — `npm install`, then `npm run dev` if a `dev` script exists, else `npm start` if a `start` script exists, else install only.
3. **`requirements.txt`** — `pip install -r requirements.txt`, then `python app.py`/`main.py`/`server.py` (first one found), else install only.
4. Otherwise, autorun does nothing and the pod behaves exactly as before (manual terminal use).

This never blocks or crashes pod startup — detection and command failures are caught and logged (visible via pod logs, prefixed `[autorun]`), leaving the pod up so the user can intervene manually. The auto-run session lives in the same `TerminalManager` registry as user terminals but under its own session id, so it's fully independent of whatever terminal(s) the user opens.

*Trade-off:* auto-run output currently goes to the pod's stdout logs only, not to the user's terminal UI — piping it into the frontend would mean extending the Socket.IO protocol with a second output stream, which felt like more surface area than this fix warranted.

## Network policy

Each project's Deployment/Service/Ingress is accompanied by a fourth manifest doc, a `NetworkPolicy` scoped to that pod (`app: <replId>`), created and torn down the same way as the others:

- **Ingress**: only the ingress controller (namespace `ingress-nginx` by default) may reach the pod's ports `3001`/`3000`. Every other pod, including other projects' runner pods, is blocked from connecting directly.
- **Egress**: DNS is allowed unconditionally (needed for S3/R2 and npm/pip registries); everything else is allowed **except** the cloud metadata endpoint (`169.254.169.254/32` - the classic SSRF-to-instance-credential-theft target on AWS/GCP/Azure), the RFC1918 private ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), and the cluster's own pod/service CIDRs - which together stop a pod from reaching another project's pod, the Kubernetes API server, the cloud metadata service, or anything else on the cluster's private network, while still permitting normal internet access (installs, S3/R2).

Things to check before relying on this:
- **Your CNI must enforce `NetworkPolicy`.** Calico, Cilium, and Weave Net do; plain flannel does **not**.
- **The pod/service CIDRs are configurable** - `POD_CIDR`/`SERVICE_CIDR` env vars on `orchestrator-simple` (default `10.42.0.0/16`/`10.43.0.0/16`, k3s's defaults). Confirm yours rather than relying on the defaults in production.
- **This is IP/CIDR-level only, not an FQDN allowlist.** Restricting egress to specific hostnames needs a CNI with FQDN-based `NetworkPolicy` support (e.g. Cilium) or an egress proxy - not implemented here; accepted as a documented limitation.
- `scripts/verify-isolation.sh` actually attempts connections to the metadata endpoint, all three RFC1918 ranges, and the cluster's specific pod/service CIDRs, confirming each is blocked while the open internet still isn't.

## Namespace isolation

Every project gets its own Kubernetes namespace (`sandbox-<replId>`, `orchestrator-simple/src/namespace.ts`), not a shared `default` - real RBAC/quota/naming isolation to sit alongside the NetworkPolicy work above, and it simplifies teardown to a single `deleteNamespace` call instead of four separate resource deletes.

- `POST /start` creates the namespace first (idempotent - a 409 "already exists" is treated as success).
- `POST /stop` and the idle reaper delete the whole namespace, which cascades the Deployment/Service/Ingress/NetworkPolicy automatically.
- **Trade-off**: namespace deletion is asynchronous in Kubernetes (a `Terminating` phase with finalizers) - a rapid stop-then-immediately-restart of the *same* `replId` can hit a conflict creating the new namespace while the old one is still terminating. In practice this resolves within seconds to a couple minutes.
- **RBAC trade-off**: namespace-per-project means `orchestrator-simple`'s credentials need cluster-scoped permissions - create/delete `namespaces`, plus the usual resource kinds inside them (see `k8s/rbac.yaml`).

## Scoped S3 credentials

By default (if `AWS_STS_ROLE_ARN` is unset), every project's pod is handed the same bucket-wide `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` from `sandbox-secrets` - **this mode is not isolated per project**: a malicious user's pod can read or write any other project's files in the bucket, not just their own.

Setting `AWS_STS_ROLE_ARN` (an IAM role `orchestrator-simple` can `sts:AssumeRole`) turns this on:

1. At `POST /start`, `orchestrator-simple` (`src/sts.ts`) calls `AssumeRole` with a session policy restricting the resulting temporary credentials to `s3:GetObject`/`PutObject` on `code/<replId>/*` and `s3:ListBucket` on the bucket with an `s3:prefix` condition matching that same prefix - nothing else in the bucket is reachable.
2. The temporary `AccessKeyId`/`SecretAccessKey`/`SessionToken` are written to a `sandbox-project-credentials` Secret in that project's own namespace, which both the init container and the `runner` container read via `secretKeyRef`.
3. `namespace.ts`'s `ensureNamespace` only copies the bucket-wide AWS keys into a project's `sandbox-secrets` Secret when STS is **not** configured.

`orchestrator-simple` itself needs its own AWS identity capable of `sts:AssumeRole` on the configured role. `scripts/aws/setup-iam.sh` creates the role and both the trust policy (restricted to that one identity) and the `sts:AssumeRole`-only inline policy it needs - dry-run by default, `--apply` to actually run it.

**Lifetime**: the STS session defaults to `AWS_STS_SESSION_DURATION_SECONDS=43200` (12h), matching `MAX_PROJECT_LIFETIME_HOURS` - the idle reaper force-stops a project (running the normal final sync first) 15 minutes before that expires regardless of activity, so credentials never actually run out mid-session. **On EKS with IRSA**, role chaining caps the actual session at 1h no matter what's requested here - `scripts/aws/setup-iam.sh` detects and warns about this, and in that case the credential-refresh endpoint designed (not built) in [ROADMAP.md](ROADMAP.md) is mandatory, not optional.

## Cluster capacity & retries

Kubernetes accepts a Deployment even when no node can ever schedule its pod - that failure only shows up later as the pod sitting in `Pending` with a `PodScheduled=False`/`Unschedulable` condition, not as a thrown error from the create call. `orchestrator-simple/src/capacity.ts` handles both halves of this:

- **Retry-with-backoff** (`withRetry`) around each resource-create call, for transient apiserver errors (5xx) - up to 3 attempts with exponential backoff. A 4xx (bad request, conflict, quota exceeded) never gets retried.
- **Schedulability check** (`checkPodSchedulable`): after creating resources, `/start` waits a few seconds and polls the new pod's status for that `Unschedulable` condition. If found, it rolls back (deletes the namespace) and returns a clear `503` with a `Retry-After` header instead of falsely reporting success on a pod that will never run.
- **Clean error responses** (`translateK8sError`): raw Kubernetes API error bodies never reach the frontend - a 409 becomes "resources already exist," a quota-exceeded 403 becomes a 503 capacity message, everything else becomes a generic "unexpected cluster error."
- **Trade-off**: the schedulability check adds a real, unavoidable ~4-8s of latency to every successful `/start` call. A queued-start pattern (accept immediately, poll asynchronously) would avoid this but is meaningfully more infrastructure - see [Roadmap](#roadmap).

## Rate limiting

`POST /project` (init-service) and `POST /start` (orchestrator-simple) are both rate-limited per authenticated **user** (the JWT's `userId`), not per IP. Each service has its own small token-bucket middleware (`src/rateLimit.ts`, intentionally duplicated rather than shared - a CI step diffs the two copies so they can't silently drift): a burst of `RATE_LIMIT_MAX` requests (default 5) is allowed immediately, then tokens refill continuously over `RATE_LIMIT_WINDOW_SECONDS` (default 60s). Exceeding it returns `429` with a `Retry-After` header.

**Trade-off**: buckets live in memory, per process - they reset on restart and wouldn't be shared across replicas if either service were ever horizontally scaled (a Redis-backed limiter would be the natural upgrade there).

## Configurable domains

The two hostnames every project is reachable at aren't hardcoded into the committed `service.yaml` - it contains `ws_domain_placeholder`/`app_domain_placeholder` tokens, substituted at `/start` time from orchestrator-simple's `WS_DOMAIN`/`APP_DOMAIN` env vars. The frontend needs the matching `VITE_WS_DOMAIN`/`VITE_APP_DOMAIN` build-time env vars (only required if you're not using the defaults).

All frontend-side backend addresses live in one place, `frontend/src/lib/config.ts`:
- `VITE_INIT_SERVICE_URL` / `VITE_ORCHESTRATOR_URL` - full base URLs for init-service/orchestrator-simple, wherever you host them.
- `VITE_USE_TLS` - a single flag switching the per-project socket (`ws`/`wss`) and iframe (`http`/`https`) connections together, since both project domains share one wildcard cert.

## TLS via cert-manager

By default everything in this repo runs over plain HTTP. Enabling HTTPS for every `<replId>.<domain>` subdomain deliberately does **not** mean issuing a new Let's Encrypt certificate per project - Let's Encrypt rate-limits certificates per registered domain per week, and this architecture can create and destroy projects (and their subdomains) far faster than that. Instead:

1. Install [cert-manager](https://cert-manager.io/docs/installation/).
2. Apply `k8s/cluster-issuer.yaml` - a Let's Encrypt `ClusterIssuer` using a DNS01 challenge (required for wildcard certs).
3. Apply `k8s/wildcard-certificate.yaml` - **one** certificate covering `*.<WS_DOMAIN>` and `*.<APP_DOMAIN>`, renewed automatically.
4. Uncomment `--default-ssl-certificate=ingress-nginx/wildcard-tls` in `k8s/ingress-controller.yaml` and re-apply it.

Every project's Ingress deliberately has **no** `tls:` block of its own - the ingress controller's cluster-wide default certificate covers every subdomain via SNI automatically, so HTTPS "just works" for new projects with zero per-project cert-manager activity.

## Deploying the schedulers in-cluster

`init-service`/`orchestrator-simple` can run anywhere with network access to the cluster's API server (a VM, a plain Docker host) via their `Dockerfile`s - see [HOSTING_GUIDE.md](../HOSTING_GUIDE.md). Running them **inside** the same cluster they manage is the more self-contained option:

1. Build and push both images, apply `k8s/rbac.yaml` (grants the `sandbox-orchestrator` ServiceAccount exactly the cluster-scoped permissions it needs - `@kubernetes/client-node`'s `loadFromDefault()` picks up its mounted token automatically).
2. Apply the Secret (`k8s/create-secret.sh`) and `k8s/scheduler-services.yaml` (ConfigMap, a `ReadWriteMany` PVC for the shared SQLite file, both Deployments, and an Ingress).
3. Point the frontend's `VITE_INIT_SERVICE_URL`/`VITE_ORCHESTRATOR_URL` at the two resulting hostnames.

**Storage note**: not every cluster supports `ReadWriteMany` out of the box (AWS EBS/GCE PD/Azure Disk are all `ReadWriteOnce`-only) - you need EFS/Filestore/Azure Files/NFS/Longhorn, or fall back to both containers sharing a plain `emptyDir` in one Pod instead (couples their restarts/scaling together).

**Trade-off: hairpin NAT.** `/stop`'s final-sync call and the idle reaper's health checks reach a runner pod via its **public** ingress hostname - harmless when orchestrator-simple runs outside the cluster, but once it runs *inside* the same cluster, that request has to leave via the ingress controller's external IP and route back in ("hairpin NAT"), which not every cloud/bare-metal LoadBalancer supports. Where it doesn't, those two paths time out harmlessly (already bounded) but stop doing anything useful. The correct fix - reaching runner pods via in-cluster Service DNS instead of the public hostname when running in-cluster - is a real change to the request path and wasn't made unilaterally; test hairpin NAT on your cluster first if you deploy this way.

## Environment variables

| Variable | Used by | Description |
|---|---|---|
| `S3_BUCKET` | init-service, runner | Bucket holding templates and per-project storage |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | init-service, runner, init container | Storage credentials. In the cluster these come from the `sandbox-secrets` Secret, not plaintext YAML. |
| `S3_ENDPOINT` | init-service, runner | Override for S3-compatible storage (e.g. Cloudflare R2) |
| `PORT` | init-service, orchestrator-simple, runner | Service port (defaults: `3001`, `3002`, `3001`) |
| `REPL_ID` | runner | The project's `replId`, injected by the orchestrator. |
| `JWT_PRIVATE_KEY` | init-service | ES256 (ECDSA P-256) private key (PEM) used to **sign** anonymous session tokens. Only init-service has this. |
| `JWT_PUBLIC_KEY` | orchestrator-simple, runner | ES256 public key (PEM) used to **verify** tokens. Neither service can mint tokens with this. |
| `JWT_PUBLIC_KEY_PREVIOUS` | orchestrator-simple, runner | Optional previous public key, accepted during a key rotation so already-issued tokens don't stop working. |
| `OWNER_ID` | runner | The verified owner's user id, injected at pod-creation time. The socket handshake rejects any token whose `userId` doesn't match. |
| `OWNERSHIP_DB_PATH` | init-service, orchestrator-simple | Path to the shared SQLite file mapping `replId` → owning user. |
| `WS_DOMAIN` / `APP_DOMAIN` | orchestrator-simple | The two domains projects are reachable at. |
| `IDLE_TIMEOUT_MINUTES` | orchestrator-simple | How long a project can sit idle before the reaper auto-stops it. Default `15`. |
| `MAX_PROJECT_LIFETIME_HOURS` | orchestrator-simple | Hard cap on how long a project stays started regardless of activity. Default `12`. |
| `REAPER_INTERVAL_SECONDS` | orchestrator-simple | How often the idle-timeout reaper checks started projects. Default `60`. |
| `HEALTH_CHECK_INTERVAL_SECONDS` | orchestrator-simple | How often the crash-loop health monitor checks started projects. Default `30`. |
| `CRASH_RESTART_THRESHOLD` | orchestrator-simple | Restart count at which a pod is considered crash-looping. Default `5`. |
| `ALERT_WEBHOOK_URL` | orchestrator-simple | Optional Slack-compatible webhook fired when a project starts crash-looping. |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_SECONDS` | init-service, orchestrator-simple | Per-user token-bucket rate limit - burst size (default `5`) and refill window in seconds (default `60`). |
| `AWS_STS_ROLE_ARN` | orchestrator-simple | IAM role ARN to assume for per-project, prefix-scoped S3 credentials. Unset = legacy bucket-wide fallback. |
| `AWS_STS_SESSION_DURATION_SECONDS` | orchestrator-simple | How long a project's STS session credentials are valid for. Default `43200` (12h). |
| `AWS_SESSION_TOKEN` | runner, init container | STS session token, present only when the pod was issued scoped credentials. |
| `WORKSPACE_STORAGE_REQUEST` / `WORKSPACE_STORAGE_LIMIT` | orchestrator-simple | `/workspace`'s disk ceiling. Defaults `512Mi`/`1Gi`. |
| `INTERNAL_API_MASTER_KEY` | orchestrator-simple | Master key only orchestrator-simple ever holds; never set on a project pod. |
| `INTERNAL_API_TOKEN` | runner | This one project's derived token, gating `/health`/`/shutdown`. Written by orchestrator-simple at `/start` time. |
| `SANDBOX_SHELL_UID` / `SANDBOX_SHELL_GID` | runner | uid/gid every terminal session is spawned as - deliberately different from the runner process's own uid. |
| `ALLOWED_ORIGINS` | init-service, orchestrator-simple, runner | Comma-separated frontend origin(s) allowed by CORS/Socket.IO. **Required when `NODE_ENV=production`.** |
| `NODE_ENV` | init-service, orchestrator-simple, runner | `production` enforces `ALLOWED_ORIGINS` being set. |
| `LOG_LEVEL` | orchestrator-simple | `debug`\|`info`\|`warn`\|`error` (default `info`). `debug` also logs every project pod's substituted manifest at `/start` time. |
| `MAX_FILE_UPDATE_BYTES` | runner | Max size accepted for a single file-save payload. Default `1048576` (1MB). |
| `S3_WRITE_DEBOUNCE_MS` | runner | Trailing debounce before a saved file's S3 write fires. Default `1500`. |
| `ADMIN_USER_IDS` | orchestrator-simple | Comma-separated userIds allowed the cluster-wide view on `/status`. Unset (default) = every caller only sees their own projects. |
| `POD_CIDR` / `SERVICE_CIDR` | orchestrator-simple | Cluster pod/service CIDRs, substituted into the `NetworkPolicy`. Defaults `10.42.0.0/16`/`10.43.0.0/16` (k3s). |
| `VITE_WS_DOMAIN` / `VITE_APP_DOMAIN` | frontend | Must match `WS_DOMAIN`/`APP_DOMAIN` above. |
| `VITE_INIT_SERVICE_URL` / `VITE_ORCHESTRATOR_URL` | frontend | Full base URLs for init-service/orchestrator-simple. **Required** for any real deployment. |
| `VITE_USE_TLS` | frontend | Set to `"true"` once TLS is set up. Default `false`. |

`orchestrator-simple` authenticates to Kubernetes via `KubeConfig().loadFromDefault()` - it needs a valid kubeconfig (or in-cluster service account), not an env var.

## Status

No live Kubernetes cluster was available while building most of this, so the end-to-end flow hasn't been verified against one. Short of that, individual pieces were checked with real functional tests against fake or real dependencies, not just type-checking:

- **Terminal session cleanup, JWT auth + SQLite ownership, the idle-timeout reaper, crash-loop/OOM detection, cluster capacity handling, namespace isolation, rate limiting, and configurable domains** were each exercised with a real repro or a real SQLite DB/local HTTP server standing in for pods, not just read for correctness.
- **A systemic unhandled-rejection crash bug** was found by connecting a real `socket.io-client` to the runner container: an unguarded `await` in a connection handler crashed the entire pod (and every session in it) on an empty `/workspace`, since Node terminates the process on an unhandled rejection by default. Fixed everywhere the same pattern appeared, plus a top-level safety net added to all three services.
- **The test suite** (~128 vitest tests across all three backends) and **GitHub Actions CI** (build/test/lint, Docker builds, hadolint, `npm audit`, kubeconform manifest validation) were added later and run green, but a kind-based end-to-end smoke test is still manual-trigger-only and unverified against a real cluster.
- **Docker images**: `init-service`/`orchestrator-simple`/`runner` were all actually built and run (not just written), which caught several real bugs along the way - a missing `.dockerignore` letting the host's `node_modules` shadow the container's own, a `tsconfig.json` missing `outDir`/`rootDir` so the production build silently never worked, and a `groupadd` collision with the base image's pre-existing `node` user.

## Roadmap

Not implemented, with the reasoning for why:

- **Pod pre-warming.** Cold starts pay the full init-container S3 copy + image pull cost every time. Warm-pool management is a meaningfully larger subsystem than anything else here.
- **Queued-start pattern.** A cluster with no capacity returns a clear `503`, but the client has to retry itself - no server-side queue auto-starts a project once capacity frees up.
- **Frontend "Stop" button.** `POST /stop` is fully functional and tested, just not called from the UI yet.
- **Send diffs instead of full files.** `updateContent` sends and writes the whole file on every edit, debounced per file so a burst of edits doesn't fire one S3 PUT per keystroke - but still the full file, not a diff.
- **STS credential refresh endpoint.** Designed, not built - see [ROADMAP.md](ROADMAP.md). Only becomes mandatory on IRSA, where role chaining caps sessions at 1h.

## Known limitations

- **Auth is anonymous/device-bound, not a real identity system.**
- **init-service and orchestrator-simple must share a filesystem** for the SQLite ownership store today.
- **orchestrator-simple's own outbound calls (final sync, health checks) go through the public ingress**, which can hit hairpin-NAT issues once it runs inside the same cluster it manages.
- **Resource usage monitoring requires `metrics-server`.** Without it, CPU/memory numbers in `/status` are always `null` (fails closed).
- **`/start` has an unavoidable ~4-8s capacity-check delay**, and a rapid stop-then-restart of the same `replId` can occasionally race a still-terminating namespace.
- **Rate-limit buckets, and alert/teardown history, are in-memory, per-process** - none of it survives a restart or would be shared across replicas if either service were ever horizontally scaled.
- **S3 credential isolation is opt-in.** Without `AWS_STS_ROLE_ARN` set, every project's pod shares the same bucket-wide credentials.
- **TLS is opt-in and cluster-wide, not per-project.** Every project shares one wildcard certificate rather than getting its own.
- **The optional kind-based CI smoke test is unverified** - no Docker/kind available in the environment this was built in.
