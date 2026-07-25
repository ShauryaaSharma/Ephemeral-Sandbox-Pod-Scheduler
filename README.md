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
- **Subdomain-based routing, not path-based.** Two ingress hosts are wired per project (`<replId>.peetcode.com`, `<replId>.autogpt-cloud.com` in the sample manifest). Swap these for your own domain(s) in `service.yaml`.
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

orchestrator-simple/
  src/
    index.ts        # POST /start, POST /stop, GET /status, GET /projects/:replId/status
    auth.ts          # JWT verify + requireAuth middleware
    db.ts            # SQLite ownership store + lifecycle/health status, restart count
    stop.ts          # shared stop-with-final-sync logic, used by POST /stop and the reaper
    reaper.ts        # background loop: polls started projects' /health, auto-stops idle ones
    monitor.ts       # pod status (crash-loop/OOM) + resource usage via the k8s API/Metrics API
    healthMonitor.ts # background loop: marks projects unhealthy on crash-loop, fires alerts
  service.yaml   # parameterized manifest template (service_name / owner_id_placeholder)

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
    components/
      Landing.tsx     # create a project (calls init-service)
      CodingPage.tsx  # calls orchestrator /start, waits for pod, then connects
      Output.tsx      # iframe at http://<replId>.<domain>

k8s/
  ingress-controller.yaml   # nginx-ingress-controller cluster setup
  create-secret.sh          # creates the sandbox-secrets k8s Secret from your shell env
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
- replace the two `host:` values under the Ingress with your own domain(s)
- replace the ingress-controller namespace label in the `NetworkPolicy` doc if yours isn't `ingress-nginx`, and fill in your cluster's pod/service CIDRs (see comments in the file, and [Network policy](#network-policy) below)
- `S3_BUCKET` / `S3_ENDPOINT` on the `runner` container are literal placeholder values in the template — edit them directly, same as the image/hostnames above

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

```bash
# init-service
cd init-service
npm install
cp src/.env.example src/.env   # fill in S3_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, S3_ENDPOINT, JWT_SECRET, OWNERSHIP_DB_PATH
npm run dev                     # :3001

# orchestrator-simple
cd orchestrator-simple
npm install
cp src/.env.example src/.env   # same JWT_SECRET and OWNERSHIP_DB_PATH as init-service
npm run dev                     # :3002 — needs kubeconfig access to your cluster (loadFromDefault())
```

### 6. Frontend

```bash
cd frontend
npm install
npm run dev                     # :5173
```

Create a project, open it, and the frontend will call `/start` and wait for its pod before connecting. On first load it also silently calls `POST /auth/session` on `init-service` and caches the returned token in `localStorage` — see [Auth & ownership](#auth--ownership).

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
| `WS_DOMAIN` | orchestrator-simple | Must match the ws-facing Ingress host in `service.yaml` (`<replId>.<this>`, default `peetcode.com`). Used to reach a pod's `/shutdown` and `/health` through the public ingress - orchestrator-simple has no other network path to pods. |
| `IDLE_TIMEOUT_MINUTES` | orchestrator-simple | How long a project can sit idle before the reaper auto-stops it. Default `15`. |
| `REAPER_INTERVAL_SECONDS` | orchestrator-simple | How often the idle-timeout reaper checks started projects. Default `60`. |
| `HEALTH_CHECK_INTERVAL_SECONDS` | orchestrator-simple | How often the crash-loop health monitor checks started projects. Default `30`. |
| `CRASH_RESTART_THRESHOLD` | orchestrator-simple | Restart count at which a pod is considered crash-looping, even without an explicit `CrashLoopBackOff` reason yet. Default `5`. |
| `ALERT_WEBHOOK_URL` | orchestrator-simple | Optional Slack-compatible webhook (`{text: "..."}`) fired when a project starts crash-looping. Unset = no alerting. |

`orchestrator-simple` authenticates to Kubernetes via `KubeConfig().loadFromDefault()` — it needs a valid kubeconfig (or in-cluster service account) available in its own environment, not an env var.

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

## Known limitations

- **Auth is anonymous/device-bound, not a real identity system** - see [Auth & ownership](#auth--ownership). Good enough to stop strangers from hijacking a `replId` they don't own; not a substitute for real accounts.
- **init-service and orchestrator-simple must share a filesystem** for the SQLite ownership store today (see the trade-off note under [Auth & ownership](#auth--ownership)).
- **No frontend "Stop" button.** `POST /stop` exists and is fully wired up, but nothing in the UI calls it yet - today it's reachable but not user-facing.
- **No pod pre-warming.** Cold starts pay the full init-container S3 copy + image pull cost every time; this was explicitly deferred as a stretch goal (see [Lifecycle](#lifecycle-stop-graceful-shutdown-idle-timeout)).
- **Resource usage monitoring requires `metrics-server`.** Without it, CPU/memory numbers in `/status` are always `null` (fails closed, doesn't break anything else) - the static `resources.limits` in the manifest are still enforced by Kubernetes itself either way, this only affects the *visibility* into usage.
- **`/status` isn't admin-scoped.** Any authenticated (anonymous) caller can see every project's health/resource data cluster-wide, not just their own - see the trade-off note under [Monitoring & guardrails](#monitoring--guardrails).

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

## License

MIT
