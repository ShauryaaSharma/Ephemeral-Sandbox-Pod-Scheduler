# Ephemeral Sandbox Pod Scheduler

Browser IDE that provisions a real, isolated Kubernetes pod per project on demand. `init-service` seeds the project into S3/R2; `orchestrator-simple` creates a Deployment/Service/Ingress/NetworkPolicy via the k8s API; `runner` streams a live terminal (node-pty) and editor over Socket.IO; nginx-ingress routes each project by subdomain. An anonymous JWT + SQLite ownership record gates `/project`, `/start`, and the runner's socket connection so only the creator of a `replId` can reach it.

## What this is

A browser-based code editor and terminal where every project gets its **own isolated compute** instead of sharing one host. Opening a project schedules a dedicated Kubernetes pod just for it, with its own filesystem, CPU/memory limits, and a real shell, reachable at its own subdomain, and torn down independently of every other project.

## How it works

1. **Auth bootstrap** : on first load, the frontend calls `POST /auth/session` on `init-service` and caches the anonymous session token it gets back (see [Auth & ownership](#auth--ownership)). Every request below carries this token.
2. **Project creation** : `POST /project` on `init-service` verifies the token, rejects an already-taken `replId` (409), copies a base template (`node-js` or `python`) from S3/R2 into `code/<replId>`, and records `(replId, ownerId)` in a shared SQLite table. This step only prepares storage; it does not start any compute.
3. **Pod scheduling** : when a user opens a project, the frontend calls `POST /start` on `orchestrator-simple` with the `replId`. The orchestrator verifies the token, checks the caller owns this `replId` (403/404 otherwise), then reads a parameterized Kubernetes manifest ([`service.yaml`](orchestrator-simple/service.yaml)), substitutes `service_name` → `replId` and `owner_id_placeholder` → the verified owner across every document, and creates each resource via the Kubernetes API (`@kubernetes/client-node`):
   - a **Deployment** running the `runner` image, with an **init container** that `aws s3 cp`s that project's files from the bucket into a mounted `emptyDir` volume before the main container starts
   - a **Service** exposing the pod's port `3001` (WebSocket) and `3000` (the user's own running app)
   - an **Ingress** routing `<replId>.<domain>` (two configured hostnames) to those ports
   - a **NetworkPolicy** scoping that pod's ingress/egress (see [Network policy](#network-policy))
4. **Editing & terminal** : the frontend connects a Socket.IO client directly to `ws://<replId>.<domain>`, presenting its token in the handshake. The `runner` inside that specific pod identifies which project it's serving from its own `REPL_ID` env var (injected by the orchestrator at pod-creation time - not the request's Host header, which is client-controlled and not trustworthy for this, and not a query param either, since there's exactly one project per pod), and rejects the connection unless the token's owner matches the pod's own `OWNER_ID`. File read/write and terminal I/O work the same way as the single-host version, except everything happens inside `/workspace` (the volume the init container populated) rather than a shared local `tmp/` folder, and every path is resolved and bounds-checked against `/workspace` before any filesystem or S3 access (see [Path safety](#path-safety)).
5. **Live preview** : the frontend's Output panel points its iframe at `http://<replId>.<domain>`, which the Ingress routes to the pod's port `3000`. On boot, the runner also auto-detects the project type and runs its install+start command in the background (see [Automatic run step](#automatic-run-step)), so this is usually already live; the user can still run their own commands manually in the terminal too.

## Architecture

```
Frontend (Vite + React)
   │
   ├─ POST /project  ────────────▶  init-service  ──▶ copy base/<lang> → S3/R2: code/<replId>
   │                                  (:3001)
   │
   ├─ POST /start {replId} ──────▶  orchestrator-simple  ──▶ Kubernetes API
   │                                  (:3002)                    │
   │                                                              ├─ Deployment (runner + init container)
   │                                                              ├─ Service (:3001 ws, :3000 user app)
   │                                                              └─ Ingress (<replId>.<domain>)
   │
   └─ Socket.IO + iframe ────────▶  <replId>.<domain>  ──▶  nginx-ingress  ──▶  runner pod
                                                                                    │
                                                                              init container:
                                                                              aws s3 cp (S3/R2 → /workspace)
                                                                                    │
                                                                              node-pty (terminal)
                                                                              file read/write
                                                                              user's own process on :3000
```

- **One pod per project.** Each `replId` gets its own Deployment, Service, and Ingress. Real isolation (separate filesystem, CPU/memory requests+limits) instead of every user sharing one backend process.
- **Subdomain-based routing, not path-based.** Two ingress hosts are wired per project (`<replId>.peetcode.com`, `<replId>.autogpt-cloud.com` by default). Config-driven via `WS_DOMAIN`/`APP_DOMAIN` - see [Configurable domains](#configurable-domains) - not edited into `service.yaml` directly.
- **Storage is still the source of truth.** Pods are disposable; nothing written outside `/workspace` survives a pod restart, and `/workspace` itself is only ever seeded once, at pod startup, by the init container.

## Tech stack

| Service | Role | Key dependencies |
|---|---|---|
| `init-service` | Project creation (template → storage) | Express, AWS SDK (S3), `jsonwebtoken`, `better-sqlite3` |
| `orchestrator-simple` | Schedules per-project k8s resources, lifecycle + health monitoring | Express, `@kubernetes/client-node` (incl. Metrics API), `yaml`, `jsonwebtoken`, `better-sqlite3`, `axios` |
| `runner` | Per-pod backend: terminal + file sync | Express, Socket.IO, `node-pty`, AWS SDK (S3), `jsonwebtoken` |
| `frontend` | Editor UI, triggers `/start`, connects to the pod | React, Vite, Monaco Editor, xterm.js |
| `k8s/` | Cluster-level ingress controller manifests | nginx-ingress |

## Project structure

```
init-service/
  src/
    index.ts    # POST /project, POST /auth/session — copies base template to S3/R2
    aws.ts       # S3/R2 client + copy helpers
    auth.ts      # JWT sign/verify + requireAuth middleware
    db.ts        # SQLite ownership store (replId -> ownerId)
    rateLimit.ts # per-user token-bucket limiter on POST /project
  Dockerfile     # builds init-service for deployment (see "Deploying the schedulers")

orchestrator-simple/
  src/
    index.ts        # POST /start, POST /stop, GET /status, GET /projects/:replId/status
    auth.ts          # JWT verify + requireAuth middleware
    db.ts            # SQLite ownership store + lifecycle/health status, restart count
    stop.ts          # shared stop-with-final-sync logic, used by POST /stop and the reaper
    reaper.ts        # background loop: polls started projects' /health, auto-stops idle ones
    monitor.ts       # pod status (crash-loop/OOM) + resource usage via the k8s API/Metrics API
    healthMonitor.ts # background loop: marks projects unhealthy on crash-loop, fires alerts
    namespace.ts     # per-project namespace (sandbox-<replId>) create/delete helpers
    capacity.ts      # retry-with-backoff + Unschedulable-pod detection + error translation
    rateLimit.ts     # per-user token-bucket limiter on POST /start
  service.yaml   # parameterized manifest template (service_name / owner_id_placeholder / ws_domain_placeholder / app_domain_placeholder)
  Dockerfile     # builds orchestrator-simple for deployment (see "Deploying the schedulers")

runner/
  src/
    index.ts    # entrypoint — HTTP + WS server for a single pod; GET /health, POST /shutdown
    ws.ts        # Socket.IO handlers — replId from REPL_ID env, tracks last-activity
    auth.ts      # JWT verify (validates the socket handshake against OWNER_ID)
    autorun.ts   # detects project type in /workspace, auto-runs install+start on pod boot
    sync.ts      # recursively re-syncs /workspace to S3/R2 on /shutdown or SIGTERM
    pty.ts       # TerminalManager — same PTY-per-session model, scoped to one pod
    fs.ts        # local filesystem helpers (operates on /workspace)
    aws.ts       # S3/R2 helpers (saveToS3 on file updates)
  Dockerfile      # builds the runner image the orchestrator deploys per pod

frontend/
  src/
    lib/
      auth.ts        # bootstraps/caches the anonymous session token
      config.ts       # every deployment-configurable backend address (init-service, orchestrator, TLS)
    components/
      Landing.tsx     # create a project (calls init-service)
      CodingPage.tsx  # calls orchestrator /start, waits for pod, polls per-project health
      Output.tsx      # iframe at http://<replId>.<domain>

k8s/
  ingress-controller.yaml   # nginx-ingress-controller cluster setup
  create-secret.sh          # creates the sandbox-secrets k8s Secret from your shell env
  cluster-issuer.yaml       # cert-manager Let's Encrypt ClusterIssuer (DNS01)
  rbac.yaml                 # ServiceAccount/ClusterRole/ClusterRoleBinding for in-cluster orchestrator-simple
  scheduler-services.yaml   # optional: Deployments/Services/Ingress to run init-service + orchestrator-simple in-cluster
  wildcard-certificate.yaml # one wildcard cert covering both project domains
```

## Getting started

### Prerequisites

- A Kubernetes cluster you have `kubectl`/API access to, with `nginx-ingress` installed (see `k8s/ingress-controller.yaml`)
- A domain (or two) with wildcard DNS pointed at your ingress controller's external IP, so `<anything>.yourdomain.com` resolves
- An S3-compatible bucket — AWS S3 or Cloudflare R2 — with `base/node-js` and `base/python` template folders pre-seeded
- A container registry to push the `runner` image to (the sample manifest references `ghcr.io/shauryaasharma/runner:latest` — replace with your own)
- Node.js 18+
- **Optional but recommended**: [`metrics-server`](https://github.com/kubernetes-sigs/metrics-server) installed in your cluster, for `/status`'s per-pod CPU/memory numbers. Without it, resource usage just reports as `null` - everything else still works.

### 1. Build and push the runner image

```bash
cd runner
docker build -t <your-registry>/runner:latest .
docker push <your-registry>/runner:latest
```

Update the `image:` field in `orchestrator-simple/service.yaml` to match.

### 2. Configure the manifest template

Edit `orchestrator-simple/service.yaml`:
- set your registry image
- replace the ingress-controller namespace label in the `NetworkPolicy` doc if yours isn't `ingress-nginx` - the pod/service CIDRs no longer need editing here directly, set `POD_CIDR`/`SERVICE_CIDR` on `orchestrator-simple` instead (see comments in the file, and [Network policy](#network-policy) below)
- `S3_BUCKET` / `S3_ENDPOINT` on the `runner` container are literal placeholder values in the template — edit them directly, same as the image above

The Ingress hostnames are **not** edited directly anymore - `ws_domain_placeholder`/`app_domain_placeholder` are substituted at `/start` time from orchestrator-simple's `WS_DOMAIN`/`APP_DOMAIN` env vars (step 5), the same mechanism already used for `service_name`. This is what makes the domains config-driven instead of baked into the committed template - see [Configurable domains](#configurable-domains).

**RBAC note**: since each project now gets its own namespace (see [Namespace isolation](#namespace-isolation)), the credentials `orchestrator-simple` runs with need **cluster-scoped** permissions - not just a Role in one namespace - to create/delete Namespaces and to create/delete Deployments/Services/Ingresses/NetworkPolicies inside them. A `kubectl` admin kubeconfig already has this; a locked-down in-cluster ServiceAccount needs a `ClusterRole`/`ClusterRoleBinding` covering `namespaces` (create, delete, get) plus the existing resource kinds at cluster scope.

### 3. Create the credentials Secret

Real credentials no longer live in `service.yaml` — they're read from Kubernetes `Secret`s at pod-creation time via `secretKeyRef`/`secretRef`.

**Generating the JWT key pair**: session tokens are signed with an asymmetric ES256 (ECDSA P-256) key pair, not a shared symmetric secret — only `init-service` ever holds the private key; `orchestrator-simple` and `runner` only get the public key and can only verify tokens, never mint them. See [JWT keys](#jwt-keys) below for why ES256 and not EdDSA, and for rotating keys later without logging every user out.

```bash
openssl ecparam -genkey -name prime256v1 -noout -out jwt-private.pem
openssl ec -in jwt-private.pem -pubout -out jwt-public.pem
```

Then create both Secrets with the provided script (never commit the filled-in values or the `.pem` files):

```bash
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
export JWT_PRIVATE_KEY="$(cat jwt-private.pem)"
export JWT_PUBLIC_KEY="$(cat jwt-public.pem)"
./k8s/create-secret.sh   # defaults to the "default" namespace; pass one as an arg otherwise
```

This creates a `sandbox-secrets` Secret with `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `JWT_PUBLIC_KEY` keys (copied into every project namespace and referenced by the `runner` container), and a separate `init-service-secrets` Secret with `JWT_PRIVATE_KEY` (referenced only by `init-service`'s own deployment in `k8s/scheduler-services.yaml` — never copied into a project namespace).

### 4. Install the ingress controller

```bash
kubectl apply -f k8s/ingress-controller.yaml
```

### 5. Run the services

`init-service` needs `JWT_PRIVATE_KEY` (to sign anonymous session tokens); `orchestrator-simple` needs the matching `JWT_PUBLIC_KEY` (to verify them) — see [Generating the JWT key pair](#3-create-the-credentials-secret). Both also need the **same** `OWNERSHIP_DB_PATH` (a shared SQLite file recording which user owns which `replId` — see [Auth & ownership](#auth--ownership)).

**Note the copy destination below**: `dotenv.config()` loads `.env` from the process's working directory (i.e. the service root when you run `npm run dev` from there), *not* from `src/`, even though the template lives at `src/.env.example`. Copying it to `src/.env` (an easy mistake - the original version of this README did exactly that) means none of these variables actually load.

```bash
# init-service
cd init-service
npm install
cp src/.env.example .env   # fill in S3_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, S3_ENDPOINT, JWT_PRIVATE_KEY, OWNERSHIP_DB_PATH
npm run dev                     # :3001

# orchestrator-simple
cd orchestrator-simple
npm install
cp src/.env.example .env   # JWT_PUBLIC_KEY matching init-service's JWT_PRIVATE_KEY, same OWNERSHIP_DB_PATH
npm run dev                     # :3002 — needs kubeconfig access to your cluster (loadFromDefault())
```

### 6. Frontend

```bash
cd frontend
npm install
cp .env.example .env   # only needed if your domains aren't peetcode.com/autogpt-cloud.com
npm run dev                     # :5173
```

Create a project, open it, and the frontend will call `/start` and wait for its pod before connecting. On first load it also silently calls `POST /auth/session` on `init-service` and caches the returned token in `localStorage` — see [Auth & ownership](#auth--ownership).

### 7. (Optional) Enable TLS

Everything above runs over plain HTTP. To serve `<replId>.<domain>` over HTTPS, see [TLS via cert-manager](#tls-via-cert-manager) - it's a few extra one-time cluster steps, deliberately kept separate so the base setup above keeps working without them.

## Environment variables

| Variable | Used by | Description |
|---|---|---|
| `S3_BUCKET` | init-service, runner | Bucket holding templates and per-project storage |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | init-service, runner, init container | Storage credentials. In the cluster these come from the `sandbox-secrets` Secret (see [setup step 3](#3-create-the-credentials-secret)), not plaintext YAML. |
| `S3_ENDPOINT` | init-service, runner | Override for S3-compatible storage (e.g. Cloudflare R2) |
| `PORT` | init-service, orchestrator-simple, runner | Service port (defaults: `3001`, `3002`, `3001`) |
| `REPL_ID` | runner | The project's `replId`, injected by the orchestrator via the same `service_name` substitution used elsewhere in `service.yaml`. Used to label the auto-run terminal session in logs. |
| `JWT_PRIVATE_KEY` | init-service | ES256 (ECDSA P-256) private key (PEM) used to **sign** anonymous session tokens. Only init-service has this. See [JWT keys](#jwt-keys). |
| `JWT_PUBLIC_KEY` | orchestrator-simple, runner | ES256 public key (PEM) used to **verify** tokens signed by `JWT_PRIVATE_KEY`. Neither service can mint tokens with this. |
| `JWT_PUBLIC_KEY_PREVIOUS` | orchestrator-simple, runner | Optional previous public key, accepted alongside `JWT_PUBLIC_KEY` during a key rotation so already-issued tokens don't suddenly stop working. See [Rotating JWT keys](#jwt-keys). |
| `OWNER_ID` | runner | The verified owner's user id, injected by the orchestrator at pod-creation time (from the ownership row it already checked in `POST /start`). The runner's socket handshake rejects any token whose `userId` doesn't match this. |
| `OWNERSHIP_DB_PATH` | init-service, orchestrator-simple | Path to the shared SQLite file mapping `replId` → owning user. Defaults to `<repo root>/data/ownership.db`, which only works if both services run on the same host/volume - see the trade-off note below. |
| `WS_DOMAIN` / `APP_DOMAIN` | orchestrator-simple | The two domains projects are reachable at - `<replId>.<WS_DOMAIN>` for the terminal/editor socket (default `peetcode.com`), `<replId>.<APP_DOMAIN>` for the user's running app (default `autogpt-cloud.com`). Substituted into `service.yaml`'s Ingress at `/start` time; `WS_DOMAIN` is also used directly to reach a pod's `/shutdown`/`/health`. See [Configurable domains](#configurable-domains). |
| `IDLE_TIMEOUT_MINUTES` | orchestrator-simple | How long a project can sit idle before the reaper auto-stops it. Default `15`. |
| `REAPER_INTERVAL_SECONDS` | orchestrator-simple | How often the idle-timeout reaper checks started projects. Default `60`. |
| `HEALTH_CHECK_INTERVAL_SECONDS` | orchestrator-simple | How often the crash-loop health monitor checks started projects. Default `30`. |
| `CRASH_RESTART_THRESHOLD` | orchestrator-simple | Restart count at which a pod is considered crash-looping, even without an explicit `CrashLoopBackOff` reason yet. Default `5`. |
| `ALERT_WEBHOOK_URL` | orchestrator-simple | Optional Slack-compatible webhook (`{text: "..."}`) fired when a project starts crash-looping. Unset = no alerting. |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_SECONDS` | init-service, orchestrator-simple | Per-user token-bucket rate limit on `POST /project` / `POST /start` - burst size (default `5`) and refill window in seconds (default `60`). See [Rate limiting](#rate-limiting). |
| `AWS_STS_ROLE_ARN` | orchestrator-simple | IAM role ARN to assume (`sts:AssumeRole`) for per-project, prefix-scoped S3 credentials. Unset = legacy bucket-wide fallback. See [Scoped S3 credentials](#scoped-s3-credentials). |
| `AWS_STS_SESSION_DURATION_SECONDS` | orchestrator-simple | How long a project's STS session credentials are valid for. Default `3600` (1h). Not refreshed mid-session - see [Scoped S3 credentials](#scoped-s3-credentials). |
| `AWS_SESSION_TOKEN` | runner, init container | STS session token, present only when the pod was issued per-project scoped credentials (see above). Unset in the legacy fallback. |
| `WORKSPACE_STORAGE_REQUEST` / `WORKSPACE_STORAGE_LIMIT` | orchestrator-simple | `/workspace`'s disk ceiling - substituted into `service.yaml`'s `emptyDir` `sizeLimit` and both containers' `ephemeral-storage` requests/limits. Defaults `512Mi`/`1Gi`. |
| `INTERNAL_API_TOKEN` | orchestrator-simple, runner | Shared secret gating the runner's internal `/health`/`/shutdown` endpoints - sent as `x-internal-token` by `stop.ts`/`reaper.ts`, checked with `crypto.timingSafeEqual`. **Must be identical in both.** Generate with e.g. `openssl rand -hex 32`. |
| `ALLOWED_ORIGINS` | init-service, orchestrator-simple, runner | Comma-separated frontend origin(s) allowed by CORS (and, for the runner, the Socket.IO handshake). **Required when `NODE_ENV=production`** (startup fails otherwise); defaults to `http://localhost:5173` in development. `orchestrator-simple` also substitutes its own value into every project pod's `ALLOWED_ORIGINS` at `/start` time - set it once there, not per-service. |
| `NODE_ENV` | init-service, orchestrator-simple, runner | Standard Node env flag - `production` enforces `ALLOWED_ORIGINS` being set (see above). |
| `MAX_FILE_UPDATE_BYTES` | runner | Max size accepted for a single `updateContent` (file save) payload. Default `1048576` (1MB); larger payloads are silently dropped (logged, no ack either way today). |
| `S3_WRITE_DEBOUNCE_MS` | runner | Trailing debounce before a saved file's S3 write actually fires, coalescing a burst of edits into one write per file. Default `1500`. Flushed immediately on socket disconnect, `/shutdown`, and `SIGTERM`. |
| `ADMIN_USER_IDS` | orchestrator-simple | Comma-separated userIds allowed the cluster-wide view on `GET /status`/`GET /projects/:replId/status`. Unset (default) = every caller only sees their own projects. |
| `POD_CIDR` / `SERVICE_CIDR` | orchestrator-simple | Cluster pod/service CIDRs, substituted into `service.yaml`'s `NetworkPolicy` egress exceptions. Defaults `10.42.0.0/16`/`10.43.0.0/16` (k3s). See [Network policy](#network-policy). |
| `VITE_WS_DOMAIN` / `VITE_APP_DOMAIN` | frontend | Must match `WS_DOMAIN`/`APP_DOMAIN` above. Only need a `.env` at all if your domains differ from the defaults. |
| `VITE_INIT_SERVICE_URL` / `VITE_ORCHESTRATOR_URL` | frontend | Full base URLs (protocol+host+port) for init-service/orchestrator-simple, wherever you deploy them. Defaults (`http://localhost:3001`/`:3002`) only work when running everything on one machine - **required** for any real deployment, since the frontend runs in the user's browser, not on your server. |
| `VITE_USE_TLS` | frontend | Set to `"true"` once [TLS via cert-manager](#tls-via-cert-manager) is set up - switches the per-project socket/iframe connections from `ws`/`http` to `wss`/`https`. Default `false`. |

`orchestrator-simple` authenticates to Kubernetes via `KubeConfig().loadFromDefault()` — it needs a valid kubeconfig (or in-cluster service account) available in its own environment, not an env var. See the RBAC note in [setup step 2](#2-configure-the-manifest-template) - namespace-per-project means this now needs cluster-scoped permissions, not just access to `default`.

## Lifecycle: stop, graceful shutdown, idle timeout

- **`POST /stop`** (orchestrator-simple, auth + ownership gated like `/start`) tears a project down: it first calls the pod's `POST /shutdown` (see below) to flush any pending file state to S3/R2, then deletes the Deployment/Service/Ingress/NetworkPolicy. Deleting an already-missing resource (e.g. a retried or partial `/stop`) is treated as success, not failure - only genuine API errors surface as a 500.
- **Graceful shutdown**: the runner exposes `POST /shutdown`, which first flushes any pending debounced S3 write (see `ws.ts`'s `updateContent` handler and `S3_WRITE_DEBOUNCE_MS` above) and then recursively re-uploads every file under `/workspace` to S3/R2 (`runner/src/sync.ts`) as a belt-and-suspenders pass covering any edit whose debounced write hadn't fired yet. The same sequence also runs on `SIGTERM` as a safety net, in case a pod is torn down without `/stop` being called first (e.g. `kubectl delete pod` directly). Both paths are bounded to 8s internally, and orchestrator's call to `/shutdown` is bounded to 10s - a stuck or unreachable pod never blocks teardown, it just proceeds anyway and logs a warning.
- **Idle-timeout reaper**: the runner tracks its own last-activity timestamp in memory (`ws.ts`, updated on connect and on every terminal/file event) and exposes it via `GET /health`. A background loop in orchestrator-simple (`src/reaper.ts`) polls every `REAPER_INTERVAL_SECONDS` for all projects it thinks are running, refreshes their last-active time from `/health`, and calls the same stop-with-sync logic on anything idle longer than `IDLE_TIMEOUT_MINUTES` - logging `[reaper] AUTO-TEARDOWN ...` so it's auditable. A pod that's temporarily unreachable doesn't get force-reaped off one failed check; the reaper falls back to the last known activity time instead.
- Project status (`created` / `started` / `stopped`) and last-active time live in the same SQLite ownership table used for auth (see [Auth & ownership](#auth--ownership)), with a migration that adds these columns to a pre-existing DB file if needed.
- **`/shutdown` and `/health` require an internal token.** They're internal, orchestrator-only endpoints reachable at the same ingress host as the user-facing app, so both require an `x-internal-token` header equal to `INTERNAL_API_TOKEN` (compared with `crypto.timingSafeEqual`), returning `401` otherwise. Only `orchestrator-simple`'s `stop.ts`/`reaper.ts` send this header; the shared secret itself is never exposed to the user's own terminal (see the env whitelist in [runner/src/pty.ts](runner/src/pty.ts)/`shellEnv.ts`).
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

1. Generate a new pair (same `openssl` commands as [setup step 3](#3-create-the-credentials-secret)).
2. Set `JWT_PUBLIC_KEY_PREVIOUS` to the **old** public key (the one currently in `JWT_PUBLIC_KEY`), and `JWT_PUBLIC_KEY` to the **new** one, on `orchestrator-simple` and in the `sandbox-secrets` Secret (`k8s/create-secret.sh` now accepts `JWT_PUBLIC_KEY_PREVIOUS` as an optional env var).
3. Set `JWT_PRIVATE_KEY` to the new private key on `init-service`.
4. Restart both. Tokens already out in users' `localStorage`, signed with the old key, keep verifying (matched by their `kid` header against the old key's own derived id) until each is naturally replaced by a fresh `POST /auth/session` call or the user clears `localStorage`.
5. Once you're confident the old key is no longer needed (or after your own chosen grace period - there's no automatic expiry, see below), remove `JWT_PUBLIC_KEY_PREVIOUS` everywhere. Any token still signed with the old key then stops verifying.

**No `exp` claim, by design**: these tokens never expire. Clearing `localStorage` already forfeits access to a project with no recovery path (see the trade-off above) - an anonymous, device-bound identity has no real session to expire in the first place, so adding `exp` would only be one more way to get silently locked out of your own project, not a real security boundary. The only thing that invalidates an existing token today is rotating past it (above).

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

*Trade-off:* auto-run output currently goes to the pod's stdout logs only, not to the user's terminal UI — piping it into the frontend would mean extending the Socket.IO protocol with a second output stream, which felt like more surface area than this fix warranted. Worth revisiting if users want to see install/start logs live.

## Network policy

Each project's Deployment/Service/Ingress is now accompanied by a fourth manifest doc, a `NetworkPolicy` scoped to that pod (`app: <replId>`), created and torn down the same way as the others:

- **Ingress**: only the ingress controller (namespace `ingress-nginx` by default - matches `k8s/ingress-controller.yaml`) may reach the pod's ports `3001`/`3000`. Every other pod, including other projects' runner pods, is blocked from connecting directly.
- **Egress**: DNS is allowed unconditionally (needed for S3/R2 and npm/pip registries); everything else is allowed **except** the cloud metadata endpoint (`169.254.169.254/32` - the classic SSRF-to-instance-credential-theft target on AWS/GCP/Azure), the RFC1918 private ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), and the cluster's own pod/service CIDRs - which together stop a pod from reaching another project's pod, the Kubernetes API server, the cloud metadata service, or anything else on the cluster's private network, while still permitting normal internet access (installs, S3/R2).

Things to check before relying on this:
- **Your CNI must enforce `NetworkPolicy`.** Calico, Cilium, and Weave Net do; plain flannel does **not** - the objects get created but silently ignored. If you're on flannel, switch to Canal or a policy-enforcing CNI.
- **The pod/service CIDRs are configurable**, not hardcoded into the committed template - `POD_CIDR`/`SERVICE_CIDR` env vars on `orchestrator-simple` (default `10.42.0.0/16`/`10.43.0.0/16`, k3s's defaults), substituted into `service.yaml` at `/start` time the same way `WS_DOMAIN`/`APP_DOMAIN` are. Confirm yours (`kubectl cluster-info dump | grep -m1 cluster-cidr`, and check your provider's docs for the service CIDR - EKS/GKE/AKS/k3s all differ) rather than relying on the defaults in production.
- **This is IP/CIDR-level only, not an FQDN allowlist.** Any public IP is still reachable (needed for npm/pip registries and S3/R2, which this policy can't name by hostname). Restricting egress to only the actual hostnames those need requires a CNI with FQDN-based `NetworkPolicy` support (e.g. Cilium) or an egress proxy - **not implemented in this repo**.

## Namespace isolation

Every project now gets its own Kubernetes namespace (`sandbox-<replId>`, `orchestrator-simple/src/namespace.ts`), not a shared `default` - real RBAC/quota/naming isolation to sit alongside the NetworkPolicy work above, and it simplifies teardown to a single `deleteNamespace` call instead of four separate resource deletes (`stop.ts`).

- `POST /start` creates the namespace first (idempotent - a 409 "already exists" is treated as success, not an error, so retrying or restarting a previously-stopped project both just work).
- `POST /stop` and the idle reaper delete the whole namespace, which cascades the Deployment/Service/Ingress/NetworkPolicy automatically.
- The crash-loop health monitor and resource-usage checks look up pods in the project's own namespace, not `default`.
- **Trade-off**: namespace deletion is asynchronous in Kubernetes (a `Terminating` phase with finalizers) - this repo's `deleteNamespace` call returning doesn't mean the namespace is actually gone yet. A rapid stop-then-immediately-restart of the *same* `replId` can hit a conflict creating the new namespace while the old one is still terminating. In practice this resolves itself within seconds to a couple minutes; there's no special handling for it here (a fixed retry-with-backoff on `ensureNamespace` would be the natural next step if this becomes a real pain point).
- **RBAC trade-off**: see the note in [Getting started, step 2](#2-configure-the-manifest-template) - this needs cluster-scoped permissions now, not a namespace-scoped Role.

## Scoped S3 credentials

By default (if `AWS_STS_ROLE_ARN` is unset), every project's pod is handed the same bucket-wide `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` from `sandbox-secrets` - **this mode is not isolated per project**: a malicious user's pod can read or write any other project's files in the bucket, not just their own.

Setting `AWS_STS_ROLE_ARN` (an IAM role `orchestrator-simple` can `sts:AssumeRole`) turns this on:

1. At `POST /start`, `orchestrator-simple` (`src/sts.ts`) calls `AssumeRole` with a session policy restricting the resulting temporary credentials to `s3:GetObject`/`PutObject` on `code/<replId>/*` and `s3:ListBucket` on the bucket with an `s3:prefix` condition matching that same prefix - nothing else in the bucket is reachable.
2. The temporary `AccessKeyId`/`SecretAccessKey`/`SessionToken` are written to a `sandbox-project-credentials` Secret in that project's own namespace (next to the copied `sandbox-secrets`), which both the init container and the `runner` container read via `secretKeyRef` (the manifest's `aws_credentials_secret_placeholder` is substituted to this Secret's name instead of `sandbox-secrets`).
3. `namespace.ts`'s `ensureNamespace` only copies the bucket-wide AWS keys into a project's `sandbox-secrets` Secret when STS is **not** configured - when it is, that Secret only ever carries `JWT_PUBLIC_KEY` into the namespace, and the pod's actual S3 credentials come from the scoped Secret above.

`orchestrator-simple` itself needs its own AWS identity capable of `sts:AssumeRole` on the configured role - wherever it runs (a plain credential-chain lookup via the AWS SDK: env vars, a shared credentials file, an EC2 instance profile, or IRSA on EKS). This repo doesn't provision that identity or the IAM role/trust policy for you - see "Needs your decision" in any security review of this feature.

**Trade-off**: the STS session (default `AWS_STS_SESSION_DURATION_SECONDS=3600`, 1h) is not refreshed mid-session - a project open longer than that keeps working for everything already cached, but a fresh S3 call after expiry will start failing with an expired-credentials error until the project is restarted (which re-assumes a fresh session). Raise the duration (up to your role's `MaxSessionDuration`) or restart long-running projects periodically until this is addressed.

## Cluster capacity & retries

Kubernetes accepts a Deployment even when no node can ever schedule its pod - that failure only shows up later as the pod sitting in `Pending` with a `PodScheduled=False`/`Unschedulable` condition, not as a thrown error from the create call. `orchestrator-simple/src/capacity.ts` handles both halves of this:

- **Retry-with-backoff** (`withRetry`) around each resource-create call, for transient apiserver errors (5xx) - up to 3 attempts with exponential backoff. A 4xx (bad request, conflict, quota exceeded) never gets retried, since retrying won't change the outcome.
- **Schedulability check** (`checkPodSchedulable`): after creating resources, `/start` waits a few seconds and polls the new pod's status for that `Unschedulable` condition. If found, it rolls back (deletes the namespace) and returns a clear `503` with a `Retry-After` header instead of falsely reporting success on a pod that will never run. If the pod's still ambiguously `Pending` when the check window closes, it's treated as schedulable rather than false-positive a rollback - the crash-loop health monitor catches genuinely stuck pods later regardless.
- **Clean error responses** (`translateK8sError`): raw Kubernetes API error bodies never reach the frontend - a 409 becomes "resources already exist," a quota-exceeded 403 becomes a 503 capacity message, everything else becomes a generic "unexpected cluster error."
- **Trade-off**: the schedulability check adds a real, unavoidable ~4-8s of latency to every successful `/start` call (the fixed delay before the scheduler could plausibly have reacted, plus a bounded poll window). A **queued-start pattern** (accept the request immediately, poll asynchronously, let the frontend poll a status endpoint) would avoid blocking the request but is meaningfully more infrastructure - a queue, a worker, client-side polling for "still starting" - and wasn't pursued; see [Roadmap](#roadmap).

## Rate limiting

`POST /project` (init-service) and `POST /start` (orchestrator-simple) are both rate-limited per authenticated **user** (the JWT's `userId`), not per IP - an IP-based limit is trivially bypassed with multiple devices/browsers and doesn't distinguish two different users behind the same NAT. Each service has its own small token-bucket middleware (`src/rateLimit.ts`, duplicated rather than shared, matching this project's existing pattern for small self-contained modules): a burst of `RATE_LIMIT_MAX` requests (default 5) is allowed immediately, then tokens refill continuously over `RATE_LIMIT_WINDOW_SECONDS` (default 60s). Exceeding it returns `429` with a `Retry-After` header.

**Trade-off**: buckets live in memory, per process - they reset if the service restarts, and wouldn't be shared across multiple replicas if either service were ever horizontally scaled (a Redis-backed limiter would be the natural upgrade there). A periodic sweep evicts buckets idle for over an hour so memory doesn't grow unbounded over a long-running process.

## Configurable domains

The two hostnames every project is reachable at are no longer hardcoded into the committed `service.yaml` - `service.yaml` now contains `ws_domain_placeholder`/`app_domain_placeholder` tokens, substituted at `/start` time from orchestrator-simple's `WS_DOMAIN`/`APP_DOMAIN` env vars (same mechanism as `service_name`). The frontend needs the matching `VITE_WS_DOMAIN`/`VITE_APP_DOMAIN` build-time env vars (only required if you're not using the `peetcode.com`/`autogpt-cloud.com` defaults) - see `frontend/.env.example`.

All frontend-side backend addresses now live in one place, `frontend/src/lib/config.ts`:
- `VITE_INIT_SERVICE_URL` / `VITE_ORCHESTRATOR_URL` - full base URLs for init-service/orchestrator-simple. These are **not** subdomains of anything, unlike the per-project hosts - they're two ordinary services you host wherever you like, so the defaults (`http://localhost:3001`/`:3002`) only work when everything runs on one machine. **This is the one env var pair you must set for any deployment that isn't local dev** - without it, every browser that loads the deployed frontend tries to reach its own `localhost`, which has nothing listening on it.
- `VITE_USE_TLS` - a single flag switching the per-project socket (`ws`/`wss`) and iframe (`http`/`https`) connections together, since both project domains share one wildcard cert (see [TLS via cert-manager](#tls-via-cert-manager)). Enabling TLS backend-side does nothing for the browser until this is also set.

Verified in a real dev-server session (not just by reading the code): with no `.env`, the auth-bootstrap request correctly targeted `http://localhost:3001`; after setting a `.env` with distinct custom values for `VITE_INIT_SERVICE_URL`/`VITE_ORCHESTRATOR_URL` and restarting Vite, inspecting the actual transformed module in the browser confirmed both constants resolved to the overridden values.

## TLS via cert-manager

By default everything in this repo runs over plain HTTP. Enabling HTTPS for every `<replId>.<domain>` subdomain deliberately does **not** mean issuing a new Let's Encrypt certificate per project - Let's Encrypt rate-limits certificates per registered domain per week, and this architecture can create and destroy projects (and their subdomains) far faster than that. Instead:

1. Install [cert-manager](https://cert-manager.io/docs/installation/): `kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.14.5/cert-manager.yaml`
2. Apply `k8s/cluster-issuer.yaml` - a Let's Encrypt `ClusterIssuer` using a DNS01 challenge (required for wildcard certs; HTTP01 doesn't support them). The template uses Cloudflare as the DNS solver - fill in your API token and email, and swap the `cloudflare` block for [your provider's solver](https://cert-manager.io/docs/configuration/acme/dns01/) if you're not on Cloudflare.
3. Apply `k8s/wildcard-certificate.yaml` - **one** certificate covering `*.<WS_DOMAIN>` and `*.<APP_DOMAIN>` (edit the two domains in the file first). This is issued once and renewed automatically by cert-manager, producing a single `wildcard-tls` Secret in the `ingress-nginx` namespace.
4. Uncomment the `--default-ssl-certificate=ingress-nginx/wildcard-tls` line in `k8s/ingress-controller.yaml` and re-apply it (`kubectl apply -f k8s/ingress-controller.yaml`).

That's the whole mechanism: every project's Ingress deliberately has **no** `tls:` block of its own - the ingress controller's cluster-wide default certificate (step 4) covers every subdomain via SNI automatically, so HTTPS "just works" for new projects with zero additional cert-manager activity per project. Steps 1-4 are one-time cluster setup, not something `/start` does per project.

**Why this is commented out / opt-in by default**: uncommenting `--default-ssl-certificate` before the referenced secret exists makes the ingress controller pod fail to start entirely - not just break TLS, break HTTP too. Leaving it commented keeps the base HTTP-only setup working for anyone who hasn't done the cert-manager steps yet.

## Deploying the schedulers

Everything above assumes `init-service` and `orchestrator-simple` are just running via `npm run dev` somewhere - that's still completely valid (a VM, a plain Docker host, anywhere with network access to your cluster's API server), and the two `Dockerfile`s below are all you need for that path. This section is for running them **inside** the same cluster they manage, which is the more self-contained option.

Both Dockerfiles were actually built and run (Docker was available in this environment) rather than just written and assumed correct, which caught two real, pre-existing bugs neither of which had anything to do with the Dockerfiles themselves:
- **No `.dockerignore` anywhere in the repo** (all three services). Without one, `COPY . .` copies the *host's* `node_modules` into the image, silently overwriting the correctly-Linux-compiled native `better-sqlite3` binary that `npm install` had just built *inside* the container - the container crashed on startup with `invalid ELF header`. Added `.dockerignore` (excluding `node_modules`, `dist`, `.env`) to all three services - this bug was equally latent in `runner`'s Dockerfile, just never triggered.
- **`orchestrator-simple/tsconfig.json` never had `outDir`/`rootDir` set** (unlike `init-service`'s otherwise-identical config), so `tsc -b` compiled every `.ts` file to a `.js` file *next to it inside `src/`* instead of into `dist/` - meaning `node dist/index.js` (this Dockerfile's `CMD`, and `npm run start`) has never actually worked for orchestrator-simple. Fixed by setting `rootDir: "./src"` / `outDir: "./dist"` to match `init-service`.

After both fixes, each image was built, run, and hit with real HTTP requests: `init-service`'s container correctly issued a signed JWT from `POST /auth/session`; `orchestrator-simple`'s container started its reaper and health-monitor background loops and correctly returned `401` on unauthenticated `/status` and `/start` calls.

### 1. Build and push both images

```bash
cd init-service && docker build -t <your-registry>/init-service:latest . && docker push <your-registry>/init-service:latest && cd ..
cd orchestrator-simple && docker build -t <your-registry>/orchestrator-simple:latest . && docker push <your-registry>/orchestrator-simple:latest && cd ..
```

### 2. Grant orchestrator-simple in-cluster permissions

```bash
kubectl apply -f k8s/rbac.yaml
```

This creates a `sandbox-orchestrator` ServiceAccount + `ClusterRole` + `ClusterRoleBinding` covering exactly what orchestrator-simple needs: create/delete `namespaces` (see [Namespace isolation](#namespace-isolation)), create/delete Deployments/Services/Ingresses/NetworkPolicies inside them, read-only `pods` (crash-loop detection) and `metrics.k8s.io` (resource usage). `@kubernetes/client-node`'s `loadFromDefault()` picks this ServiceAccount's mounted token up automatically once the Deployment below references it - no kubeconfig file, no extra env var.

### 3. Apply the Secret, config, storage, and Deployments

```bash
./k8s/create-secret.sh   # if you haven't already (see step 3 of the main setup)
kubectl apply -f k8s/scheduler-services.yaml
```

Edit the image references, `S3_BUCKET`/`S3_ENDPOINT`/`WS_DOMAIN`/`APP_DOMAIN` in the `ConfigMap`, and the two `host:` values in the `Ingress` before applying - same pattern as `service.yaml`, just edited directly since this file is applied once, not templated per-project.

**Storage note**: init-service and orchestrator-simple share the SQLite ownership file (see the trade-off note under [Auth & ownership](#auth--ownership)) via a single `PersistentVolumeClaim` mounted `ReadWriteMany` into both pods. **Not every cluster supports RWX out of the box** - AWS EBS, GCE PD, and Azure Disk are all `ReadWriteOnce`-only; you need something like EFS/Filestore/Azure Files/NFS/Longhorn. If that's not available to you, the fallback is running both containers in one Pod sharing a plain `emptyDir` instead of a PVC - works everywhere, at the cost of coupling their restarts/scaling together (a straightforward adaptation of the manifest, not provided as a separate file here).

**Networking note**: `init.<WS_DOMAIN>` and `api.<WS_DOMAIN>` are ordinary single-level subdomains, so if you've done the [TLS setup](#tls-via-cert-manager) they're already covered by the same wildcard certificate - no extra cert-manager work.

### 4. Point the frontend at them

```
VITE_INIT_SERVICE_URL=http://init.peetcode.com
VITE_ORCHESTRATOR_URL=http://api.peetcode.com
```

(`https://` once TLS is enabled - see [`VITE_USE_TLS`](#environment-variables)).

### Trade-off: orchestrator-simple's own outbound calls and hairpin NAT

`/stop`'s final-sync call and the idle reaper's health checks (`stop.ts`/`reaper.ts`) reach a runner pod via its **public** ingress hostname (`http://<replId>.<WS_DOMAIN>/shutdown`) - orchestrator-simple has no other network path to it today. That's harmless when orchestrator-simple runs outside the cluster (normal internet routing), but once it runs *inside* the same cluster, that request has to leave the cluster via the ingress controller's external IP/LoadBalancer and route back in - "hairpin NAT" - which not every cloud provider or bare-metal LoadBalancer setup supports cleanly. Where it doesn't work, every `/stop` call's final sync and every reaper health check will time out (harmlessly - both paths are already bounded and fail gracefully - but the graceful-shutdown and idle-detection features effectively stop doing anything useful).

**Not fixed here** - the correct fix is having orchestrator-simple reach runner pods via in-cluster Service DNS (`http://<replId>.sandbox-<replId>.svc.cluster.local:3001`) instead of the public hostname when it's running in-cluster, which also means extending the NetworkPolicy's ingress rule to allow orchestrator-simple's own namespace, not just `ingress-nginx`. That's a real architecture change to the request path (not just a deployment manifest), so it wasn't made unilaterally - flagging it clearly here instead. If you deploy orchestrator-simple in-cluster and rely on `/stop`'s final sync or the idle reaper, test whether hairpin NAT works on your cluster first.

## Features

Everything here is also covered in depth in its own section earlier in this README - this is a quick index.

- **Per-project isolation**: one Kubernetes namespace, Deployment, Service, Ingress, and NetworkPolicy per project, including egress restrictions (cloud metadata endpoint, RFC1918 ranges, the cluster's own pod/service CIDRs) - see [Network policy](#network-policy), [Namespace isolation](#namespace-isolation).
- **Anonymous JWT auth + SQLite ownership**, enforced on `/project`, `/start`, and the runner's socket handshake, with path and payload-size guards on file access - see [Auth & ownership](#auth--ownership), [Path safety](#path-safety).
- **Lifecycle management**: graceful `/stop` with a final S3 sync, an idle-timeout reaper, and crash-loop/OOM detection with an optional alerting webhook - see [Lifecycle](#lifecycle-stop-graceful-shutdown-idle-timeout), [Monitoring & guardrails](#monitoring--guardrails).
- **Cluster capacity handling**: retry-with-backoff, `Unschedulable`-pod detection with rollback, and clean error responses instead of raw Kubernetes errors reaching the frontend - see [Cluster capacity & retries](#cluster-capacity--retries).
- **Per-user rate limiting** on `/project` and `/start` - see [Rate limiting](#rate-limiting).
- **Configurable domains and TLS** via a shared wildcard certificate - see [Configurable domains](#configurable-domains), [TLS via cert-manager](#tls-via-cert-manager).
- **Scoped, per-project S3 credentials via STS**, opt-in - see [Scoped S3 credentials](#scoped-s3-credentials).
- **Automatic run step** on pod boot (Procfile/npm/pip detection) - see [Automatic run step](#automatic-run-step).
- **Deployment packaging** for `init-service`/`orchestrator-simple`: Dockerfiles, RBAC, a shared-storage manifest, and an Ingress - see [Deploying the schedulers](#deploying-the-schedulers).

## Status

No live Kubernetes cluster was available while building this, so nothing here has been verified against one end to end. Short of that, everything below was checked with real functional tests against fake or real dependencies as noted, not just type-checking or code review:

- **Terminal session cleanup**: a real repro (two sessions, one exited naturally) confirmed the exited session is untracked and its process is dead, the other is untouched, and cleanup is idempotent on an unknown id. This also caught and fixed a real bug: the exit handler had been deleting sessions by OS pid instead of the caller-supplied session id, making it a no-op on every natural shell exit, and a related leak where `ws.ts`'s `disconnect` handler never cleared the terminal session.
- **JWT auth + SQLite ownership**: `signToken`/`verifyToken` round-tripped, and `createProject`/`getProject` exercised against a real SQLite file, confirming ownership lookups, the duplicate-`replId` unique constraint, and invalid-token rejection.
- **Idle-timeout reaper**: the full `reapOnce` loop run against a real SQLite DB and a local HTTP server standing in for two pods (one idle 20 minutes, one fresh) - only the idle one gets torn down, its status flips to `stopped`, the fresh one is untouched, and all four k8s resource types get deleted for the idle one.
- **Crash-loop/OOM detection**: `checkPodHealth` correctly classified a `CrashLoopBackOff` pod, an `OOMKilled` pod, a healthy pod, and a missing pod against fake Kubernetes API responses; a full `monitorOnce` pass against a real SQLite DB correctly marked two crash-looping projects `unhealthy` (one via explicit reason, one via restart-count threshold) and left a healthy one untouched; the alert webhook's payload (project id, owner, reason, restart count) was confirmed actually reaching an HTTP endpoint.
- **Cluster capacity handling**: `withRetry` retries a flaky 503 twice then succeeds, never retries a 400, and exhausts its attempts correctly; `checkPodSchedulable` was tested against three fake pod states (explicit `Unschedulable`, `Running`, and ambiguously `Pending`), including actually waiting out its ~12s check window rather than just inspecting the code.
- **Namespace isolation**: `ensureNamespace`'s idempotent handling of a 409 (and correct rethrow of non-409 errors), and `deleteProjectNamespace`'s tolerance of a 404.
- **Rate limiting**: a burst of `RATE_LIMIT_MAX` requests succeeds and the next is blocked with `429`+`Retry-After`; a second user's bucket is unaffected by the first user exhausting theirs; requests succeed again after the refill window.
- **Configurable domains and TLS**: all the k8s YAML parses without errors, and the full manifest substitution (every placeholder together) was re-validated end to end; the frontend's `lib/config.ts` was verified live in a dev-server session - with no `.env`, requests correctly targeted `localhost`, and with one set, they correctly targeted the configured values.
- **Deployment packaging**: both `init-service` and `orchestrator-simple` Docker images were actually built and run, which caught two real pre-existing bugs - a missing `.dockerignore` that let the host's Windows-compiled `node_modules` shadow the container's correctly Linux-compiled ones, and `orchestrator-simple/tsconfig.json` never having `outDir`/`rootDir` set, meaning its production build (`dist/index.js`) had never actually worked. Both were confirmed fixed by rebuilding, running each container, and hitting it with real HTTP requests - `init-service` correctly issued a signed JWT, and `orchestrator-simple` started its background loops and correctly returned `401` on unauthenticated requests.
- **A systemic unhandled-rejection crash bug**, found by connecting a real `socket.io-client` to the runner container instead of just curling HTTP endpoints: an unguarded `await fetchDir(...)` in `ws.ts`'s connection handler crashed the entire pod on an empty `/workspace`, since Node terminates the process on an unhandled rejection by default - every session in the pod died with it, not just the bad connection. The same unguarded-async pattern turned out to be systemic (`init-service`'s `POST /project`, `orchestrator-simple`'s `GET /status`) and was fixed everywhere it was found, plus a top-level `process.on("unhandledRejection", ...)` safety net added to all three services. Verified by reproducing the exact crash and confirming the same connection now completes the handshake and the container stays running, across multiple restarts.

## Roadmap

Not implemented, with the reasoning for why:

- **Pod pre-warming.** Cold starts pay the full init-container S3 copy + image pull cost every time. Warm-pool management (claim/release, relabeling, a pre-creation loop against an empty workspace) is a meaningfully larger subsystem than anything else here, and hasn't been started.
- **Queued-start pattern.** A cluster with no capacity returns a clear `503` (see [Cluster capacity & retries](#cluster-capacity--retries)), but the client has to retry itself - there's no server-side queue that automatically starts a project once capacity frees up. Would need a real queue, a worker, and client-side polling for "still starting".
- **Frontend "Stop" button.** `POST /stop` is fully functional and tested, just not called from the UI yet.
- **Send diffs instead of full files.** `updateContent` (`runner/src/ws.ts`) sends and writes the whole file on every edit. S3 writes are debounced per file (default 1500ms, see `S3_WRITE_DEBOUNCE_MS`) so a burst of edits doesn't fire one S3 PUT per keystroke, but the local disk write and the socket payload itself are still the full file, not a diff.

## Known limitations

- **Auth is anonymous/device-bound, not a real identity system** - see [Auth & ownership](#auth--ownership). Good enough to stop strangers from hijacking a `replId` they don't own; not a substitute for real accounts.
- **init-service and orchestrator-simple must share a filesystem** for the SQLite ownership store today (see the trade-off note under [Auth & ownership](#auth--ownership)) - a shared volume (a `ReadWriteMany` PVC in-cluster, see [Deploying the schedulers](#deploying-the-schedulers)) satisfies this, but not every cluster has RWX storage available.
- **orchestrator-simple's own outbound calls (final sync, health checks) go through the public ingress**, which can hit hairpin-NAT issues once it runs inside the same cluster it manages - see the trade-off note in [Deploying the schedulers](#deploying-the-schedulers). Not an issue when it runs outside the cluster (the default assumption everywhere else in this README).
- **Resource usage monitoring requires `metrics-server`.** Without it, CPU/memory numbers in `/status` are always `null` (fails closed, doesn't break anything else) - the static `resources.limits` in the manifest are still enforced by Kubernetes itself either way, this only affects the *visibility* into usage.
- **`/start` has an unavoidable ~4-8s capacity-check delay**, and a rapid stop-then-restart of the same `replId` can occasionally race a still-terminating namespace - see [Cluster capacity & retries](#cluster-capacity--retries) and [Namespace isolation](#namespace-isolation).
- **Rate-limit buckets, and alert/teardown-history, are in-memory, per-process** - none of it survives a restart or would be shared across replicas if either service were ever horizontally scaled. See [Rate limiting](#rate-limiting).
- **S3 credential isolation is opt-in.** Without `AWS_STS_ROLE_ARN` set, every project's pod shares the same bucket-wide credentials - see [Scoped S3 credentials](#scoped-s3-credentials) for the opt-in per-project-scoped alternative and its own trade-off (STS sessions aren't refreshed mid-session).
- **TLS is opt-in and cluster-wide, not per-project.** Every project shares one wildcard certificate rather than getting its own - see [TLS via cert-manager](#tls-via-cert-manager) for why, and note it's commented out by default so a fresh setup isn't forced through the cert-manager steps just to get HTTP working.

## License

MIT
