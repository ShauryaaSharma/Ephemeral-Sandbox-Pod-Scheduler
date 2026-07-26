# Ephemeral Sandbox Pod Scheduler

Browser IDE that provisions a real, isolated Kubernetes pod per project on demand. `init-service` seeds the project into S3/R2; `orchestrator-simple` creates a Deployment/Service/Ingress/NetworkPolicy via the k8s API; `runner` streams a live terminal (node-pty) and editor over Socket.IO; nginx-ingress routes each project by subdomain. An anonymous JWT + SQLite ownership record gates `/project`, `/start`, and the runner's socket connection so only the creator of a `replId` can reach it.

## What this is

A browser-based code editor and terminal, like [Session Multiplexer Code Shell](#), rebuilt so every project gets its **own isolated compute** instead of sharing one host. Opening a project schedules a dedicated Kubernetes pod just for it, with its own filesystem, CPU/memory limits, and a real shell, reachable at its own subdomain, and torn down independently of every other project.

## How it works

1. **Auth bootstrap** : on first load, the frontend calls `POST /auth/session` on `init-service` and caches the anonymous session token it gets back (see [Auth & ownership](#auth--ownership)). Every request below carries this token.
2. **Project creation** : `POST /project` on `init-service` verifies the token, rejects an already-taken `replId` (409), copies a base template (`node-js` or `python`) from S3/R2 into `code/<replId>`, and records `(replId, ownerId)` in a shared SQLite table. This step only prepares storage; it does not start any compute.
3. **Pod scheduling** : when a user opens a project, the frontend calls `POST /start` on `orchestrator-simple` with the `replId`. The orchestrator verifies the token, checks the caller owns this `replId` (403/404 otherwise), then reads a parameterized Kubernetes manifest ([`service.yaml`](orchestrator-simple/service.yaml)), substitutes `service_name` → `replId` and `owner_id_placeholder` → the verified owner across every document, and creates each resource via the Kubernetes API (`@kubernetes/client-node`):
   - a **Deployment** running the `runner` image, with an **init container** that `aws s3 cp`s that project's files from the bucket into a mounted `emptyDir` volume before the main container starts
   - a **Service** exposing the pod's port `3001` (WebSocket) and `3000` (the user's own running app)
   - an **Ingress** routing `<replId>.<domain>` (two configured hostnames) to those ports
   - a **NetworkPolicy** scoping that pod's ingress/egress (see [Network policy](#network-policy))
4. **Editing & terminal** : the frontend connects a Socket.IO client directly to `ws://<replId>.<domain>`, presenting its token in the handshake. The `runner` inside that specific pod identifies which project it's serving from the **subdomain in the request's Host header** (not a query param, since there's exactly one project per pod), and rejects the connection unless the token's owner matches the pod's own `OWNER_ID`. File read/write and terminal I/O work the same way as the single-host version, except everything happens inside `/workspace` (the volume the init container populated) rather than a shared local `tmp/` folder.
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
    ws.ts        # Socket.IO handlers — replId derived from Host header, tracks last-activity
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
- A container registry to push the `runner` image to (the sample manifest references `100xdevs/runner:latest` — replace with your own)
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
- replace the ingress-controller namespace label in the `NetworkPolicy` doc if yours isn't `ingress-nginx`, and fill in your cluster's pod/service CIDRs (see comments in the file, and [Network policy](#network-policy) below)
- `S3_BUCKET` / `S3_ENDPOINT` on the `runner` container are literal placeholder values in the template — edit them directly, same as the image above

The Ingress hostnames are **not** edited directly anymore - `ws_domain_placeholder`/`app_domain_placeholder` are substituted at `/start` time from orchestrator-simple's `WS_DOMAIN`/`APP_DOMAIN` env vars (step 5), the same mechanism already used for `service_name`. This is what makes the domains config-driven instead of baked into the committed template - see [Configurable domains](#configurable-domains).

**RBAC note**: since each project now gets its own namespace (see [Namespace isolation](#namespace-isolation)), the credentials `orchestrator-simple` runs with need **cluster-scoped** permissions - not just a Role in one namespace - to create/delete Namespaces and to create/delete Deployments/Services/Ingresses/NetworkPolicies inside them. A `kubectl` admin kubeconfig already has this; a locked-down in-cluster ServiceAccount needs a `ClusterRole`/`ClusterRoleBinding` covering `namespaces` (create, delete, get) plus the existing resource kinds at cluster scope.

### 3. Create the credentials Secret

Real credentials no longer live in `service.yaml` — they're read from a Kubernetes `Secret` at pod-creation time via `secretKeyRef`. Create it with the provided script (never commit the filled-in values):

```bash
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
export JWT_SECRET=$(openssl rand -hex 32)   # must be the same value used by init-service/orchestrator-simple below
./k8s/create-secret.sh   # defaults to the "default" namespace; pass one as an arg otherwise
```

This creates a single `sandbox-secrets` Secret with `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `JWT_SECRET` keys, referenced by both the init container and the `runner` container in `service.yaml`.

### 4. Install the ingress controller

```bash
kubectl apply -f k8s/ingress-controller.yaml
```

### 5. Run the services

`init-service` and `orchestrator-simple` both need the **same** `JWT_SECRET` (used to sign/verify anonymous session tokens) and the **same** `OWNERSHIP_DB_PATH` (a shared SQLite file recording which user owns which `replId` — see [Auth & ownership](#auth--ownership)).

**Note the copy destination below**: `dotenv.config()` loads `.env` from the process's working directory (i.e. the service root when you run `npm run dev` from there), *not* from `src/`, even though the template lives at `src/.env.example`. Copying it to `src/.env` (an easy mistake - the original version of this README did exactly that) means none of these variables actually load.

```bash
# init-service
cd init-service
npm install
cp src/.env.example .env   # fill in S3_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, S3_ENDPOINT, JWT_SECRET, OWNERSHIP_DB_PATH
npm run dev                     # :3001

# orchestrator-simple
cd orchestrator-simple
npm install
cp src/.env.example .env   # same JWT_SECRET and OWNERSHIP_DB_PATH as init-service
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
| `JWT_SECRET` | init-service, orchestrator-simple, runner | Shared HMAC secret for signing/verifying anonymous session tokens. **Must be identical across all three services.** Generate with e.g. `openssl rand -hex 32`. |
| `OWNER_ID` | runner | The verified owner's user id, injected by the orchestrator at pod-creation time (from the ownership row it already checked in `POST /start`). The runner's socket handshake rejects any token whose `userId` doesn't match this. |
| `OWNERSHIP_DB_PATH` | init-service, orchestrator-simple | Path to the shared SQLite file mapping `replId` → owning user. Defaults to `<repo root>/data/ownership.db`, which only works if both services run on the same host/volume - see the trade-off note below. |
| `WS_DOMAIN` / `APP_DOMAIN` | orchestrator-simple | The two domains projects are reachable at - `<replId>.<WS_DOMAIN>` for the terminal/editor socket (default `peetcode.com`), `<replId>.<APP_DOMAIN>` for the user's running app (default `autogpt-cloud.com`). Substituted into `service.yaml`'s Ingress at `/start` time; `WS_DOMAIN` is also used directly to reach a pod's `/shutdown`/`/health`. See [Configurable domains](#configurable-domains). |
| `IDLE_TIMEOUT_MINUTES` | orchestrator-simple | How long a project can sit idle before the reaper auto-stops it. Default `15`. |
| `REAPER_INTERVAL_SECONDS` | orchestrator-simple | How often the idle-timeout reaper checks started projects. Default `60`. |
| `HEALTH_CHECK_INTERVAL_SECONDS` | orchestrator-simple | How often the crash-loop health monitor checks started projects. Default `30`. |
| `CRASH_RESTART_THRESHOLD` | orchestrator-simple | Restart count at which a pod is considered crash-looping, even without an explicit `CrashLoopBackOff` reason yet. Default `5`. |
| `ALERT_WEBHOOK_URL` | orchestrator-simple | Optional Slack-compatible webhook (`{text: "..."}`) fired when a project starts crash-looping. Unset = no alerting. |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_SECONDS` | init-service, orchestrator-simple | Per-user token-bucket rate limit on `POST /project` / `POST /start` - burst size (default `5`) and refill window in seconds (default `60`). See [Rate limiting](#rate-limiting). |
| `VITE_WS_DOMAIN` / `VITE_APP_DOMAIN` | frontend | Must match `WS_DOMAIN`/`APP_DOMAIN` above. Only need a `.env` at all if your domains differ from the defaults. |
| `VITE_INIT_SERVICE_URL` / `VITE_ORCHESTRATOR_URL` | frontend | Full base URLs (protocol+host+port) for init-service/orchestrator-simple, wherever you deploy them. Defaults (`http://localhost:3001`/`:3002`) only work when running everything on one machine - **required** for any real deployment, since the frontend runs in the user's browser, not on your server. |
| `VITE_USE_TLS` | frontend | Set to `"true"` once [TLS via cert-manager](#tls-via-cert-manager) is set up - switches the per-project socket/iframe connections from `ws`/`http` to `wss`/`https`. Default `false`. |

`orchestrator-simple` authenticates to Kubernetes via `KubeConfig().loadFromDefault()` — it needs a valid kubeconfig (or in-cluster service account) available in its own environment, not an env var. See the RBAC note in [setup step 2](#2-configure-the-manifest-template) - namespace-per-project means this now needs cluster-scoped permissions, not just access to `default`.

## Lifecycle: stop, graceful shutdown, idle timeout

- **`POST /stop`** (orchestrator-simple, auth + ownership gated like `/start`) tears a project down: it first calls the pod's `POST /shutdown` (see below) to flush any pending file state to S3/R2, then deletes the Deployment/Service/Ingress/NetworkPolicy. Deleting an already-missing resource (e.g. a retried or partial `/stop`) is treated as success, not failure - only genuine API errors surface as a 500.
- **Graceful shutdown**: the runner exposes `POST /shutdown`, which recursively re-uploads every file under `/workspace` to S3/R2 (`runner/src/sync.ts`). This isn't recovering buffered writes - individual edits already sync to S3 immediately (see `ws.ts`'s `updateContent` handler) - it's a belt-and-suspenders pass covering any edit whose S3 write raced with pod teardown. The same sync also runs on `SIGTERM` as a safety net, in case a pod is torn down without `/stop` being called first (e.g. `kubectl delete pod` directly). Both paths are bounded to 8s internally, and orchestrator's call to `/shutdown` is bounded to 10s - a stuck or unreachable pod never blocks teardown, it just proceeds anyway and logs a warning.
- **Idle-timeout reaper**: the runner tracks its own last-activity timestamp in memory (`ws.ts`, updated on connect and on every terminal/file event) and exposes it via `GET /health`. A background loop in orchestrator-simple (`src/reaper.ts`) polls every `REAPER_INTERVAL_SECONDS` for all projects it thinks are running, refreshes their last-active time from `/health`, and calls the same stop-with-sync logic on anything idle longer than `IDLE_TIMEOUT_MINUTES` - logging `[reaper] AUTO-TEARDOWN ...` so it's auditable. A pod that's temporarily unreachable doesn't get force-reaped off one failed check; the reaper falls back to the last known activity time instead.
- Project status (`created` / `started` / `stopped`) and last-active time live in the same SQLite ownership table from Priority 2, with a migration that adds these columns to a pre-existing DB file if needed.
- **Trade-off**: `/shutdown` and `/health` are not token-gated like the rest of the API (see [Auth & ownership](#auth--ownership)) - they're internal, orchestrator-only endpoints reachable at the same ingress host as the user-facing app. Worst case impact is low (an unauthenticated caller can force an early resync or read a timestamp, nothing destructive), but a shared internal secret would be a natural hardening step if this matters for your deployment.
- **Not implemented**: pod pre-warming (Priority 3's explicit stretch goal) - deferred since 1-3 needed to be solid first, and warm-pool management is a meaningfully bigger scope than the rest of this tier.

## Monitoring & guardrails

- **Per-pod resource usage** (`orchestrator-simple/src/monitor.ts`): reads live CPU/memory from the Kubernetes Metrics API (`metrics.k8s.io`, via `@kubernetes/client-node`'s `Metrics` client), not just the static `resources.limits` already in the manifest. **Requires `metrics-server` installed in your cluster** - if it's not, this fails closed (returns `null` per project) rather than breaking health checks or `/status`.
- **Crash-loop / OOM detection** (`src/healthMonitor.ts`): a background loop, separate from the idle reaper, checks every started project's pod status via the Kubernetes API every `HEALTH_CHECK_INTERVAL_SECONDS`. A pod is considered crash-looping if its container reports the `CrashLoopBackOff` waiting reason **or** its restart count reaches `CRASH_RESTART_THRESHOLD` (whichever fires first - the threshold catches the slower-burning case where kubelet hasn't reported that reason yet). `OOMKilled` is detected separately from the container's last-terminated reason and reported alongside.
- **Throttled response, not silent auto-restart**: this project never restarts pods itself (kubelet already owns that via `restartPolicy`). What "stop trying to auto-recover" means here concretely: once a project crosses the crash-loop threshold, it's marked `unhealthy` in the ownership table (a `health_status` column, orthogonal to the `started`/`stopped` lifecycle `status` - a pod can be started *and* unhealthy at the same time) and stops being silently treated as fine. Recovery is automatic and symmetric: the next check that finds the pod no longer crash-looping flips it back to `healthy`.
- **`GET /status`** (orchestrator-simple, auth required, **not** ownership-scoped - see trade-off below): the cluster-wide operational view - total active pods, unhealthy count, each active project's health/restart-count/resource-usage, recent auto-teardowns (from the idle reaper), and recent crash-loop alerts.
- **`GET /projects/:replId/status`**: the ownership-scoped counterpart, for the frontend - returns just one project's lifecycle status, health status, restart count, and reason. `CodingPage.tsx` polls this every 20s and shows a banner ("this project's pod is unhealthy...") when it comes back unhealthy, instead of a silently broken terminal.
- **Alerting webhook** (optional): set `ALERT_WEBHOOK_URL` to a Slack incoming-webhook URL (or any endpoint that accepts `{text: "..."}` - Discord and log-sink proxies both work this way) and a message fires the moment a project crosses into `unhealthy`. No webhook configured = alerts still land in `/status` and logs, just no push notification.
- **Trade-off**: `/status` requires a valid token but isn't restricted to an admin role (there is no role concept in this project) - any authenticated caller can see every project's `replId`/`ownerId`/health data, not just their own. Acceptable for a portfolio-scale deployment; real multi-tenant use would need an admin flag on top of the existing auth.

## Auth & ownership

There is no login/password/email anywhere in this project - adding real user accounts was out of scope. Instead:

1. On first load, the frontend calls `POST /auth/session` on `init-service` (no auth required - this **is** the bootstrap), which generates a random `userId` (`crypto.randomUUID()`), signs a JWT `{ userId }`, and returns it. The frontend caches this token in `localStorage` and sends it as `Authorization: Bearer <token>` on `/project` and `/start`, and as `{ auth: { token } }` on the Socket.IO connection to the pod.
2. `POST /project` (init-service) requires a valid bearer token, rejects a `replId` that's already taken (409), and records `(replId, ownerId, createdAt)` in a shared SQLite table.
3. `POST /start` (orchestrator-simple) requires a valid bearer token, looks up the `replId`'s owner, and rejects with `404` if the project doesn't exist or `403` if the caller isn't the owner. On success, it injects the verified `ownerId` into the pod as `OWNER_ID` (same substitution mechanism as `REPL_ID`) - no DB access needed inside the pod itself.
4. The runner's Socket.IO connection handler verifies the token in the handshake (`socket.handshake.auth.token`) and disconnects unless the token's `userId` matches the pod's own `OWNER_ID`.

**This is intentionally a lightweight, anonymous, device-bound identity, not a real auth system** - a token just proves "the same browser that created this project is asking again." Clearing `localStorage` forfeits access to your own projects (no recovery mechanism), and there's no protection against someone deliberately exporting/sharing their token. Swapping in a real identity provider later would only require changing how `/auth/session` issues tokens - everything downstream (the bearer-token middleware, the ownership table, the socket check) stays the same.

**Trade-off on `OWNERSHIP_DB_PATH`:** init-service and orchestrator-simple both read/write the same SQLite file directly rather than one service calling the other's API. That's the lightest option for two services that, today, are expected to run on the same host - but it means they **must** share a filesystem. If you deploy them on separate hosts/containers, either point `OWNERSHIP_DB_PATH` at a shared volume, or (better, for real multi-host deployment) replace the direct file access with a tiny internal ownership API that one service exposes and the other calls.

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
- **Egress**: DNS is allowed unconditionally (needed for S3/R2 and npm/pip registries); everything else is allowed **except** the cluster's own pod and service CIDRs - which is what stops a pod from reaching another project's pod or the Kubernetes API server, while still permitting normal internet access (installs, S3/R2).

Two things to check before relying on this:
- **Your CNI must enforce `NetworkPolicy`.** Calico, Cilium, and Weave Net do; plain flannel does **not** - the objects get created but silently ignored. If you're on flannel, switch to Canal or a policy-enforcing CNI.
- **The CIDR placeholders are generic kubeadm defaults** (`10.244.0.0/16` pod CIDR, `10.96.0.0/12` service CIDR) and will be wrong for many managed clusters (EKS/GKE/AKS/k3s all differ). Confirm yours (`kubectl cluster-info dump | grep -m1 cluster-cidr`, and check your provider's docs for the service CIDR) and edit `orchestrator-simple/service.yaml` before relying on this in production.

## Namespace isolation

Every project now gets its own Kubernetes namespace (`sandbox-<replId>`, `orchestrator-simple/src/namespace.ts`), not a shared `default` - real RBAC/quota/naming isolation to sit alongside the NetworkPolicy work above, and it simplifies teardown to a single `deleteNamespace` call instead of four separate resource deletes (`stop.ts`).

- `POST /start` creates the namespace first (idempotent - a 409 "already exists" is treated as success, not an error, so retrying or restarting a previously-stopped project both just work).
- `POST /stop` and the idle reaper delete the whole namespace, which cascades the Deployment/Service/Ingress/NetworkPolicy automatically.
- The crash-loop health monitor and resource-usage checks look up pods in the project's own namespace, not `default`.
- **Trade-off**: namespace deletion is asynchronous in Kubernetes (a `Terminating` phase with finalizers) - this repo's `deleteNamespace` call returning doesn't mean the namespace is actually gone yet. A rapid stop-then-immediately-restart of the *same* `replId` can hit a conflict creating the new namespace while the old one is still terminating. In practice this resolves itself within seconds to a couple minutes; there's no special handling for it here (a fixed retry-with-backoff on `ensureNamespace` would be the natural next step if this becomes a real pain point).
- **RBAC trade-off**: see the note in [Getting started, step 2](#2-configure-the-manifest-template) - this needs cluster-scoped permissions now, not a namespace-scoped Role.

## Cluster capacity & retries

Kubernetes accepts a Deployment even when no node can ever schedule its pod - that failure only shows up later as the pod sitting in `Pending` with a `PodScheduled=False`/`Unschedulable` condition, not as a thrown error from the create call. `orchestrator-simple/src/capacity.ts` handles both halves of this:

- **Retry-with-backoff** (`withRetry`) around each resource-create call, for transient apiserver errors (5xx) - up to 3 attempts with exponential backoff. A 4xx (bad request, conflict, quota exceeded) never gets retried, since retrying won't change the outcome.
- **Schedulability check** (`checkPodSchedulable`): after creating resources, `/start` waits a few seconds and polls the new pod's status for that `Unschedulable` condition. If found, it rolls back (deletes the namespace) and returns a clear `503` with a `Retry-After` header instead of falsely reporting success on a pod that will never run. If the pod's still ambiguously `Pending` when the check window closes, it's treated as schedulable rather than false-positive a rollback - the crash-loop health monitor catches genuinely stuck pods later regardless.
- **Clean error responses** (`translateK8sError`): raw Kubernetes API error bodies never reach the frontend - a 409 becomes "resources already exist," a quota-exceeded 403 becomes a 503 capacity message, everything else becomes a generic "unexpected cluster error."
- **Trade-off**: the schedulability check adds a real, unavoidable ~4-8s of latency to every successful `/start` call (the fixed delay before the scheduler could plausibly have reacted, plus a bounded poll window). A **queued-start pattern** (accept the request immediately, poll asynchronously, let the frontend poll a status endpoint) would avoid blocking the request but is meaningfully more infrastructure - a queue, a worker, client-side polling for "still starting" - and wasn't pursued given this is explicitly a lighter alternative the brief called out.

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
- **`orchestrator-simple/tsconfig.json` never had `outDir`/`rootDir` set** (unlike `init-service`'s otherwise-identical config), so `tsc -b` compiled every `.ts` file to a `.js` file *next to it inside `src/`* instead of into `dist/` - meaning `node dist/index.js` (this Dockerfile's `CMD`, and `npm run start`) has never actually worked for orchestrator-simple, going back before any of the work in this README's changelog. Fixed by setting `rootDir: "./src"` / `outDir: "./dist"` to match `init-service`.

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

## Known limitations

- **Auth is anonymous/device-bound, not a real identity system** - see [Auth & ownership](#auth--ownership). Good enough to stop strangers from hijacking a `replId` they don't own; not a substitute for real accounts.
- **init-service and orchestrator-simple must share a filesystem** for the SQLite ownership store today (see the trade-off note under [Auth & ownership](#auth--ownership)) - a shared volume (a `ReadWriteMany` PVC in-cluster, see [Deploying the schedulers](#deploying-the-schedulers)) satisfies this, but not every cluster has RWX storage available.
- **orchestrator-simple's own outbound calls (final sync, health checks) go through the public ingress**, which can hit hairpin-NAT issues once it runs inside the same cluster it manages - see the trade-off note in [Deploying the schedulers](#deploying-the-schedulers). Not an issue when it runs outside the cluster (the default assumption everywhere else in this README).
- **No frontend "Stop" button.** `POST /stop` exists and is fully wired up, but nothing in the UI calls it yet - today it's reachable but not user-facing.
- **No pod pre-warming.** Cold starts pay the full init-container S3 copy + image pull cost every time; this was explicitly deferred as a stretch goal (see [Lifecycle](#lifecycle-stop-graceful-shutdown-idle-timeout)).
- **Resource usage monitoring requires `metrics-server`.** Without it, CPU/memory numbers in `/status` are always `null` (fails closed, doesn't break anything else) - the static `resources.limits` in the manifest are still enforced by Kubernetes itself either way, this only affects the *visibility* into usage.
- **`/status` isn't admin-scoped.** Any authenticated (anonymous) caller can see every project's health/resource data cluster-wide, not just their own - see the trade-off note under [Monitoring & guardrails](#monitoring--guardrails).
- **`/start` has an unavoidable ~4-8s capacity-check delay**, and a rapid stop-then-restart of the same `replId` can occasionally race a still-terminating namespace - see [Cluster capacity & retries](#cluster-capacity--retries) and [Namespace isolation](#namespace-isolation).
- **Rate-limit buckets are in-memory, per-process** - reset on restart, not shared across replicas. See [Rate limiting](#rate-limiting).
- **No queued-start pattern.** A cluster with no capacity returns a clear `503` (see [Cluster capacity & retries](#cluster-capacity--retries)), but the client has to retry itself - there's no server-side queue that automatically starts the project once capacity frees up.
- **TLS is opt-in and cluster-wide, not per-project.** Every project shares one wildcard certificate rather than getting its own - see [TLS via cert-manager](#tls-via-cert-manager) for why, and note it's commented out by default so a fresh setup isn't forced through the cert-manager steps just to get HTTP working.

This repo is the second iteration of [Session Multiplexer Code Shell](#), Same editor/terminal experience, rebuilt around per-project Kubernetes scheduling instead of a single shared host.

## Changelog

### Priority 1 — bug fixes (2026-07-26)

- **Fixed `TerminalManager` session-cleanup bug** ([runner/src/pty.ts](runner/src/pty.ts)): the PTY `exit` handler deleted `this.sessions[term.pid]` instead of `this.sessions[id]` — since sessions are keyed by the caller-supplied id (a Socket.IO `socket.id`), that delete was effectively a no-op on every natural shell exit, leaving a stale entry pointing at a dead process. Fixed to close over the original `id`. Also hardened `clear()` to no-op on an unknown/already-removed id instead of throwing, and added `has()`/`getActiveSessionIds()` for introspection (used by the new test, and generally useful for future status/monitoring work).
  - **Also fixed a related leak**: `runner/src/ws.ts`'s `disconnect` handler never called `terminalManager.clear()`, so every browser disconnect leaked its PTY process server-side indefinitely. It now clears the socket's terminal session on disconnect.
  - **Verification**: [runner/src/pty.manualtest.ts](runner/src/pty.manualtest.ts) (`npm run test:pty` from `runner/`) creates two terminal sessions, exits one naturally (`exit` typed into the shell — the exact path that hit the bug), and asserts: the exited session is untracked and its OS process is dead, the other session is untouched and still alive, and `clear()` is idempotent on unknown ids.
- **Added an automatic run step** (see above) so pods do something useful on start instead of requiring the user to manually run install/start commands.

Both changes are scoped to `runner/` (plus one new `env:` entry in `orchestrator-simple/service.yaml` for `REPL_ID`); no frontend changes were required for this tier.

### Priority 2 — security (2026-07-26)

- **Credentials out of the plaintext manifest.** `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` in `orchestrator-simple/service.yaml` are now `secretKeyRef`s against a `sandbox-secrets` Kubernetes Secret, created out-of-band via the new [k8s/create-secret.sh](k8s/create-secret.sh) (reads values from your shell env, never contains real credentials itself). Also fixed a latent gap while touching this: the `runner` container never actually received S3 credentials before (only the init container did), so `saveToS3` had no working credentials in the current manifest at all - it now gets them via the same Secret. Added a root [.gitignore](.gitignore) so a locally-filled-in secret manifest or the SQLite ownership file can't be committed by accident.
- **JWT auth + SQLite ownership records**, closing the "anyone who knows a `replId` can `/start` it" gap:
  - New `POST /auth/session` on `init-service` mints an anonymous, device-bound identity token (see [Auth & ownership](#auth--ownership) for the full model and its trade-offs).
  - `POST /project` and `POST /start` both require a valid bearer token now; `/project` also rejects an already-taken `replId` (409) instead of silently overwriting it, closing a gap the code's own comment had flagged (`// Hit a database to ensure this slug isn't taken already`).
  - `POST /start` rejects `replId`s the caller doesn't own (403) or that don't exist (404), and injects the verified owner into the pod as `OWNER_ID`.
  - The runner's Socket.IO handshake now requires a token matching that pod's `OWNER_ID`, closing the same gap at the terminal/file-access layer, not just the HTTP layer.
  - New files: `{init-service,orchestrator-simple}/src/{auth,db}.ts`, `runner/src/auth.ts`, `frontend/src/lib/auth.ts`. New deps: `jsonwebtoken` (all three backend services), `better-sqlite3` (init-service, orchestrator-simple).
  - **Frontend changes were required** and made: `Landing.tsx`/`CodingPage.tsx` attach the bearer token to `/project`/`/start`, and `CodingPage.tsx`'s socket connection now waits for a token before connecting and passes it via `{ auth: { token } }`.
  - **Verified functionally** (not just type-checked): a smoke test drove `signToken`/`verifyToken` through a round trip and `createProject`/`getProject` against a real SQLite file, confirming token verification, ownership lookups, the duplicate-`replId` unique constraint, and invalid-token rejection all behave correctly.
- **NetworkPolicy per project** - see [Network policy](#network-policy) above for what it does and its two important caveats (CNI enforcement, cluster-specific CIDRs).
- **Incidental fix**: pinned `@types/node` in all three backend services' devDependencies. A fresh `npm install` was pulling in an unpinned transitive `@types/node@20.11.19`, which is incompatible with TypeScript 5.9's typed-array generics and broke `orchestrator-simple/src/aws.ts`'s type-check - unrelated to this tier's changes, but it was blocking verification of everything else here.

Frontend, init-service, and orchestrator-simple all required changes in this tier (auth is inherently cross-cutting); runner needed both the socket-auth check and the Secret-based env wiring.

### Priority 3 — lifecycle management (2026-07-26)

- **`POST /stop`** (orchestrator-simple): auth + ownership gated like `/start`; calls the pod's `/shutdown` for a final sync, then deletes Deployment/Service/Ingress/NetworkPolicy. Already-missing resources (404) are treated as success, not failure - `/stop` is safe to retry.
- **Graceful shutdown**: new `runner/src/sync.ts` recursively re-uploads `/workspace` to S3/R2, exposed via `POST /shutdown` and also wired to `SIGTERM` as a safety net for direct pod deletion. Both paths are bounded (8s internally, 10s from orchestrator's side) so a stuck sync can't block teardown indefinitely.
- **Idle-timeout reaper**: the runner now tracks its own last-activity timestamp in memory (`ws.ts`) and exposes it via `GET /health`; a background loop in orchestrator-simple (`src/reaper.ts`) polls every project it thinks is running, refreshes last-active from `/health`, and calls the same stop-with-sync logic on anything idle past `IDLE_TIMEOUT_MINUTES` (default 15), logging every auto-teardown.
- The SQLite ownership table (from Priority 2) grew two columns - `status` (`created`/`started`/`stopped`) and `last_active_at` - with a defensive `ALTER TABLE` migration so an existing pre-Priority-3 DB file doesn't break.
- **Pod pre-warming was not attempted** - it's explicitly called out as a stretch goal in the brief, to be pursued only once 1-3 are solid, and warm-pool management is a meaningfully larger scope than the rest of this tier.
- **Verified functionally**, not just type-checked, using the actual shipped code (only the Kubernetes API client and DNS resolution were faked for the test environment):
  - `syncWorkspaceToS3` against a real nested directory tree - confirmed every file gets uploaded with the correct relative path and S3 key prefix, and `withTimeout` correctly races both a slow and a fast promise.
  - The full reaper loop (`reapOnce`) against a real SQLite DB and a local HTTP server standing in for two pods (one idle 20 minutes, one fresh): confirmed only the idle one gets torn down, its status flips to `stopped`, the fresh one is untouched, and all four k8s resource types get deleted for the idle one.
  - `stop.ts`'s error handling: a 404 from one resource doesn't fail the whole stop (idempotent teardown), while a genuine 500 correctly surfaces.
  - The DB schema migration: simulated an old Priority-2-era 3-column DB file, confirmed the new columns get added without data loss and default correctly.

No frontend changes in this tier - `/stop` exists and works but isn't called from the UI yet (see Known limitations).

### Priority 4 — resource guardrails & monitoring (2026-07-26)

- **Per-pod resource monitoring** (`orchestrator-simple/src/monitor.ts`): live CPU/memory via the Kubernetes Metrics API, fails closed to `null` per project (not an exception) if `metrics-server` isn't installed.
- **Crash-loop / OOM detection** (`src/healthMonitor.ts`): a new background loop, separate from the idle reaper, flags a project `unhealthy` when its pod reports `CrashLoopBackOff` or crosses `CRASH_RESTART_THRESHOLD` restarts, and separately flags `OOMKilled`. Recovery is automatic and symmetric - the next healthy check flips it back.
- **Throttled response, not silent restart-forever**: added a `health_status` column (orthogonal to the existing lifecycle `status`) so "pod exists but is broken" is a distinct, queryable state instead of silently indistinguishable from "pod exists and is fine."
- **`GET /status`**: cluster-wide operational endpoint - active pod count, unhealthy count, per-project health/restart-count/resource-usage, recent auto-teardowns, recent crash-loop alerts.
- **`GET /projects/:replId/status`**: ownership-scoped single-project counterpart, consumed by a new polling hook in `CodingPage.tsx` that shows an "unhealthy pod" banner - closing the loop the brief asked for ("surfaced to the frontend so the user sees this project's pod is unhealthy").
- **Alerting webhook** (stretch goal, implemented): `ALERT_WEBHOOK_URL`, Slack-compatible payload, fires once per transition into `unhealthy` (not on every check tick).
- **Verified functionally**, not just type-checked, with fake (not real-cluster) Kubernetes API responses standing in for `listNamespacedPod`/`getPodMetrics`:
  - `checkPodHealth` correctly classifies a `CrashLoopBackOff` pod, an `OOMKilled` pod (detected via `lastState.terminated.reason`, separate from the crash-loop check), a healthy pod, and a missing pod.
  - `getPodResourceUsage` fails closed to `null` when the metrics API throws (simulating no `metrics-server`), rather than propagating the error.
  - A full `monitorOnce` pass against a real SQLite DB: two crash-looping projects (one via explicit reason, one via restart-count threshold) correctly get marked `unhealthy` with the right reason recorded, a third healthy project is untouched, and both alerts land in the in-memory alert log.
  - The alert webhook: confirmed (in an isolated repro after an initial test read its output file too early) that the real payload - project id, owner, reason, restart count - actually reaches an HTTP endpoint.

All four backend/frontend surfaces type-check cleanly; the frontend banner addition introduced no new type errors (confirmed against the same 14 pre-existing ones from Priority 2, now at shifted line numbers).

### Priority 5 — scaling & robustness (2026-07-26)

- **Cluster capacity handling** (`orchestrator-simple/src/capacity.ts`): retry-with-backoff around resource creation for transient (5xx) API errors; a schedulability check after creation that detects a pod stuck `Unschedulable` and rolls back with a clear `503` instead of falsely reporting success; raw Kubernetes error bodies are translated into clean messages instead of ever reaching the frontend. A queued-start pattern (the heavier alternative the brief mentioned) was not pursued - documented as a trade-off.
- **Per-user rate limiting** (`src/rateLimit.ts`, duplicated in both init-service and orchestrator-simple): token-bucket keyed by the authenticated `userId`, not IP, on `POST /project` and `POST /start`. Configurable burst size and refill window; a periodic sweep evicts idle buckets so memory doesn't grow unbounded.
- **Namespace-per-project isolation** (stretch goal, implemented): `orchestrator-simple/src/namespace.ts` - every project gets its own `sandbox-<replId>` namespace instead of sharing `default`, created idempotently at `/start` and deleted wholesale at `/stop` (which also simplified `stop.ts` from four resource deletes to one namespace delete). Documented trade-offs: namespace deletion is asynchronous (a rapid stop-then-restart can race a still-terminating namespace), and this raises the RBAC bar from a namespaced Role to cluster-scoped permissions.
- **Incidental fix, found while touching env-var loading for this tier**: the README's setup instructions (inherited from before Priority 1) told users to `cp src/.env.example src/.env` for init-service/orchestrator-simple - but `dotenv.config()` defaults to loading `.env` from the process's working directory, which is the service root when running `npm run dev`, not `src/`. Every env var this project uses (`JWT_SECRET`, `OWNERSHIP_DB_PATH`, etc., across every prior tier) would silently fail to load under the old instructions. Fixed the copy destination in the README, and added `.env` to `.gitignore` in all three backend services and the frontend (previously only `node_modules` was ignored for the backend services - a real gap, since `.env` would hold live AWS/JWT secrets).
- **Verified functionally**, not just type-checked, with fake Kubernetes API responses and fake request/response objects:
  - `namespaceForProject` naming, `ensureNamespace`'s idempotent handling of a 409 (and correct rethrow of non-409 errors), `deleteProjectNamespace`'s tolerance of 404.
  - `withRetry`: retries a flaky call that fails twice with 503 then succeeds; does not retry a 400; exhausts its attempts and throws when a call always fails.
  - `checkPodSchedulable` against three fake pod states: an explicit `Unschedulable` condition (detected in ~4s), a `Running` pod (detected in ~4s), and a pod stuck ambiguously `Pending` with no clear condition (correctly falls back to "schedulable" after the full ~12s check window - confirmed by actually waiting it out, not by inspecting the code).
  - `translateK8sError`'s three branches (409, quota-exceeded 403, generic).
  - The rate limiter: a burst of `RATE_LIMIT_MAX` requests succeeds and the next one is blocked with `429`+`Retry-After`; a second user's bucket is completely unaffected by the first user exhausting theirs; after waiting out the refill window, the first user can make requests again.

### Priority 6 — networking & polish (2026-07-26)

- **Configurable domains**: `service.yaml`'s two Ingress hostnames are now `ws_domain_placeholder`/`app_domain_placeholder` tokens, substituted at `/start` time from orchestrator-simple's `WS_DOMAIN`/`APP_DOMAIN` env vars (same mechanism as `service_name`) - no more editing real domains into a template that gets committed. The frontend gained matching `VITE_WS_DOMAIN`/`VITE_APP_DOMAIN` build-time env vars and a `.env.example` (it previously had none).
- **TLS via cert-manager**: rather than issuing a certificate per ephemeral project (which risks Let's Encrypt's per-domain rate limits at this churn rate), every project shares **one** wildcard certificate covering both configured domains, applied once via `k8s/cluster-issuer.yaml` + `k8s/wildcard-certificate.yaml` and wired in as the ingress controller's cluster-wide default certificate (`k8s/ingress-controller.yaml`, one new arg). No per-project Ingress needs its own `tls:` block or any cert-manager annotation - HTTPS "just works" for every new subdomain with zero additional cert-manager activity per project start. Left commented out by default so a fresh HTTP-only setup isn't forced through the cert-manager steps.
- **Verified**: all new/edited k8s YAML (`ingress-controller.yaml`, `cluster-issuer.yaml`, `wildcard-certificate.yaml`, `service.yaml`) parses without errors; the full manifest substitution (all four placeholder types together) was re-validated end to end.

Frontend, init-service, and orchestrator-simple all changed in these two tiers; runner was untouched (P5/P6 are entirely about the scheduling/networking layer, not the per-pod runtime).

### Frontend deployment wiring (follow-up, 2026-07-26)

After the six priority tiers above, a review of "is this actually deployable" turned up that the frontend still hardcoded `http://localhost:3001`/`:3002` for init-service/orchestrator-simple in three places (`lib/auth.ts`, `Landing.tsx`, `CodingPage.tsx`), and hardcoded `ws://`/`http://` (never `wss`/`https`) for the per-project connections - meaning the TLS work in Priority 6 had no effect on actual browser traffic. Fixed by centralizing every backend address into `frontend/src/lib/config.ts` (`VITE_INIT_SERVICE_URL`, `VITE_ORCHESTRATOR_URL`, `VITE_USE_TLS`, alongside the existing `VITE_WS_DOMAIN`/`VITE_APP_DOMAIN`). Verified in a live dev-server session, not just by reading the code - see [Configurable domains](#configurable-domains) for what was actually checked.

### Scheduler deployment packaging (follow-up, 2026-07-26)

The same deployability review flagged three remaining gaps: no `Dockerfile`/deployment manifest for `init-service` or `orchestrator-simple` themselves (only the runner image they deploy per-project was containerized), no RBAC for running `orchestrator-simple` in-cluster with least privilege, and the shared-SQLite-file constraint had no concrete deployment story. All three addressed - see [Deploying the schedulers](#deploying-the-schedulers) for the full detail:
- `Dockerfile`s for both services (mirroring the runner's pattern).
- `k8s/rbac.yaml` - a `ServiceAccount`/`ClusterRole`/`ClusterRoleBinding` scoped to exactly what orchestrator-simple needs, so it can run with an in-cluster identity instead of a mounted admin kubeconfig.
- `k8s/scheduler-services.yaml` - `ConfigMap` + `ReadWriteMany` `PersistentVolumeClaim` (for the shared ownership DB) + `Deployment`/`Service` for each + an `Ingress` exposing both, reusing the existing wildcard certificate.
- Documented, not fixed: a hairpin-NAT risk in orchestrator-simple's own outbound calls once it runs in-cluster (see the trade-off note in that section) - a real architecture change to the request path, flagged rather than made unilaterally.
- **Incidental cleanup**: `orchestrator-simple/src/aws.ts` and its S3/AWS env vars were dead code - never imported anywhere, presumably copy-pasted from init-service's template originally. Removed, along with the now-unused `aws-sdk` dependency.
- **Two real, pre-existing bugs found and fixed by actually building and running both Docker images** (detailed in [Deploying the schedulers](#deploying-the-schedulers)): a missing `.dockerignore` that let the host's Windows-compiled `node_modules` shadow the container's correctly Linux-compiled ones, and `orchestrator-simple/tsconfig.json` never having `outDir`/`rootDir` set, meaning its production build (`dist/index.js`) had never actually worked. Both were verified fixed by rebuilding, running each container, and hitting it with real HTTP requests.

### Unhandled-rejection crash bug across all three backend services (follow-up, 2026-07-26)

Verifying the runner image with a real `socket.io-client` connection (not just an HTTP curl) - the only way to actually exercise the terminal/editor path - crashed the whole container the moment a real client connected: an unguarded `await fetchDir("/workspace", "")` in `ws.ts`'s connection handler rejected (nothing had populated `/workspace` in the test container), and since **Node terminates the process on an unhandled promise rejection by default**, that took down the entire pod - every session in it, not just the one bad connection.

Auditing for the same pattern found it was systemic, not a one-off:
- **`runner/src/ws.ts`**: every single async socket handler (`fetchDir`, `fetchContent`, `updateContent`, `requestTerminal`, `terminalData`, plus the connection handler's initial workspace load) was unguarded. All now wrapped in `try`/`catch`, logging and degrading gracefully (empty results, or just logging for fire-and-forget events) instead of crashing.
- **`init-service/src/index.ts`**: `POST /project`'s `await copyS3Folder(...)` had no try/catch - a real, live risk (any S3 error - bad credentials, network blip, unknown language folder - would have crashed the process for every user, not just the failing request). Fixed.
- **`orchestrator-simple/src/index.ts`**: `GET /status`'s `Promise.all` had no try/catch. `getPodResourceUsage` already catches internally today so this wasn't currently reachable, but the endpoint shouldn't depend on that never changing - a status dashboard failing should 500, not take `/start`, `/stop`, the reaper, and the health monitor down with it. Fixed.
- **Defense in depth**: added a top-level `process.on("unhandledRejection", ...)` handler (log, don't crash) to all three services, as a last line of defense against the *next* unguarded async call, rather than relying on every handler being audited correctly forever.

**Verified by reproducing the exact crash and confirming the fix**: the same `socket.io-client` connection that killed the container before now completes the handshake, receives a graceful empty `loaded` event, and the container stays running afterward - confirmed across multiple restarts. `node-pty`'s native binary was also confirmed functional in the process (it reached an actual `chdir` syscall attempt, not a module-load failure) - it only failed because `/workspace` doesn't exist in this ad hoc test container, which is expected outside a real pod and unrelated to the crash bug.

## What's real vs. aspirational

A honest tally across all six priority tiers, since the brief specifically asked for this:

**Fully implemented and verified** (code review + type-checking + functional tests against fake/real dependencies, since no live Kubernetes cluster was available to test against in this environment):
- Terminal session cleanup bug fix, with a real repro that fails on the old code and passes on the fix
- Automatic run-on-start detection (Procfile/npm/pip)
- Kubernetes Secret for credentials (out of the plaintext manifest)
- JWT auth + SQLite ownership, enforced on `/project`, `/start`, and the runner's socket handshake
- NetworkPolicy per project (with documented CNI/CIDR caveats)
- `POST /stop` with final S3 sync and idempotent teardown
- Idle-timeout auto-teardown reaper
- Crash-loop/OOM detection, `health_status` tracking, `GET /status`, per-project status polling + frontend banner
- Alerting webhook (the Priority 4 stretch goal)
- Cluster capacity handling (retry-with-backoff, Unschedulable detection + rollback, clean error responses)
- Per-user rate limiting on `/project` and `/start`
- Namespace-per-project isolation (the Priority 5 stretch goal)
- Configurable domains, TLS via a shared wildcard cert + cert-manager
- Frontend deployment config (`lib/config.ts`) - no more hardcoded `localhost` backends, verified live in a dev-server session
- Full deployment packaging for `init-service`/`orchestrator-simple`: `Dockerfile`s, RBAC, shared-storage manifest, `Ingress` - both images actually built and run in this environment, catching two real pre-existing bugs (missing `.dockerignore`, orchestrator-simple's broken `dist/` build) that would otherwise have surfaced as a confusing production-only failure
- A systemic unhandled-rejection crash bug across all three backend services, found by actually connecting a real `socket.io-client` to the runner container instead of just curling HTTP endpoints - fixed everywhere it was found, plus a top-level safety net added to all three services against the next unguarded async call

**Explicitly deferred, with reasoning documented inline**:
- **Pod pre-warming** (Priority 3's stretch goal) - warm-pool management (claim/release, relabeling, a pre-creation loop against an empty workspace) is a meaningfully larger subsystem than anything else in this list; deferred until 1-3 were solid, per the brief's own instruction, and never circled back to given the scope already covered.
- **Queued-start pattern** (Priority 5's heavier alternative to retry-with-backoff) - would need a real queue, a worker, and client-side polling for "still starting"; the brief explicitly offered retry-with-backoff as the lighter option.
- **Frontend "Stop" button** - `POST /stop` is fully functional and tested, just not called from the UI. Small, deliberately left for whoever picks this up next since it wasn't explicitly required by any tier's task list.
- **Admin-scoped `/status`** - there's no role/admin concept anywhere in this project's auth model, so the cluster-wide status view is available to any authenticated (anonymous) caller, not just operators. Documented as a trade-off rather than built around, since adding roles would be a real feature addition beyond what any tier asked for.

**Real constraints worth knowing about, not bugs**:
- init-service and orchestrator-simple share a SQLite file on the same filesystem/host - there's no message queue or shared hosted DB, by design, for this project's scale.
- The auth model is anonymous and device-bound (a `localStorage` token), not real accounts - sufficient to stop strangers from touching a `replId` they didn't create, not a substitute for login/signup.
- Rate-limit and alert/teardown-history state live in memory per process - none of it survives a restart or would be shared across replicas.
- TLS, when enabled, is cluster-wide via one shared certificate, not per-project.

## License

MIT
