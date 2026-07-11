# Ephemeral Sandbox Pod Scheduler

Browser IDE that provisions a real, isolated Kubernetes pod per project on demand. `init-service` seeds the project into S3/R2; `orchestrator-simple` creates a Deployment/Service/Ingress via the k8s API; `runner` streams a live terminal (node-pty) and editor over Socket.IO; nginx-ingress routes each project by subdomain.

## What this is

A browser-based code editor and terminal, like [Session Multiplexer Code Shell](#), rebuilt so every project gets its **own isolated compute** instead of sharing one host. Opening a project schedules a dedicated Kubernetes pod just for it, with its own filesystem, CPU/memory limits, and a real shell, reachable at its own subdomain, and torn down independently of every other project.

## How it works

1. **Project creation** : `POST /project` on `init-service` copies a base template (`node-js` or `python`) from S3/R2 into `code/<replId>`, the same way the single-host version does. This step only prepares storage; it does not start any compute.
2. **Pod scheduling** : when a user opens a project, the frontend calls `POST /start` on `orchestrator-simple` with the `replId`. The orchestrator reads a parameterized Kubernetes manifest ([`service.yaml`](orchestrator-simple/service.yaml)), substitutes `service_name` → `replId` across every document, and creates each resource via the Kubernetes API (`@kubernetes/client-node`):
   - a **Deployment** running the `runner` image, with an **init container** that `aws s3 cp`s that project's files from the bucket into a mounted `emptyDir` volume before the main container starts
   - a **Service** exposing the pod's port `3001` (WebSocket) and `3000` (the user's own running app)
   - an **Ingress** routing `<replId>.<domain>` (two configured hostnames) to those ports
3. **Editing & terminal** : the frontend connects a Socket.IO client directly to `ws://<replId>.<domain>`. The `runner` inside that specific pod identifies which project it's serving from the **subdomain in the request's Host header** (not a query param, since there's exactly one project per pod). File read/write and terminal I/O work the same way as the single-host version, except everything happens inside `/workspace` (the volume the init container populated) rather than a shared local `tmp/` folder.
4. **Live preview** : the frontend's Output panel points its iframe at `http://<replId>.<domain>`, which the Ingress routes to the pod's port `3000`. If the user manually starts something listening on that port inside their terminal, it becomes reachable at a real, per-project URL — unlike the single-host version's hardcoded `localhost:3000`.

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
| `init-service` | Project creation (template → storage) | Express, AWS SDK (S3) |
| `orchestrator-simple` | Schedules per-project k8s resources | Express, `@kubernetes/client-node`, `yaml` |
| `runner` | Per-pod backend: terminal + file sync | Express, Socket.IO, `node-pty`, AWS SDK (S3) |
| `frontend` | Editor UI, triggers `/start`, connects to the pod | React, Vite, Monaco Editor, xterm.js |
| `k8s/` | Cluster-level ingress controller manifests | nginx-ingress |

## Project structure

```
init-service/
  src/
    index.ts    # POST /project — copies base template to S3/R2
    aws.ts       # S3/R2 client + copy helpers

orchestrator-simple/
  src/
    index.ts    # POST /start — parses service.yaml, creates Deployment/Service/Ingress via k8s API
  service.yaml   # parameterized manifest template (service_name placeholder)

runner/
  src/
    index.ts    # entrypoint — HTTP + WS server for a single pod
    ws.ts        # Socket.IO handlers — replId derived from Host header, reads/writes /workspace
    pty.ts       # TerminalManager — same PTY-per-session model, scoped to one pod
    fs.ts        # local filesystem helpers (operates on /workspace)
    aws.ts       # S3/R2 helpers (saveToS3 on file updates)
  Dockerfile      # builds the runner image the orchestrator deploys per pod

frontend/
  src/
    components/
      Landing.tsx     # create a project (calls init-service)
      CodingPage.tsx  # calls orchestrator /start, waits for pod, then connects
      Output.tsx      # iframe at http://<replId>.<domain>

k8s/
  ingress-controller.yaml   # nginx-ingress-controller cluster setup
```

## Getting started

### Prerequisites

- A Kubernetes cluster you have `kubectl`/API access to, with `nginx-ingress` installed (see `k8s/ingress-controller.yaml`)
- A domain (or two) with wildcard DNS pointed at your ingress controller's external IP, so `<anything>.yourdomain.com` resolves
- An S3-compatible bucket — AWS S3 or Cloudflare R2 — with `base/node-js` and `base/python` template folders pre-seeded
- A container registry to push the `runner` image to (the sample manifest references `100xdevs/runner:latest` — replace with your own)
- Node.js 18+

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
- set real S3/R2 credentials in the init container's env (or better, wire these through a Kubernetes Secret instead of the plaintext values in the sample)

### 3. Install the ingress controller

```bash
kubectl apply -f k8s/ingress-controller.yaml
```

### 4. Run the services

```bash
# init-service
cd init-service
npm install
cp src/.env.example src/.env   # fill in S3_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, S3_ENDPOINT
npm run dev                     # :3001

# orchestrator-simple
cd orchestrator-simple
npm install
npm run dev                     # :3002 — needs kubeconfig access to your cluster (loadFromDefault())
```

### 5. Frontend

```bash
cd frontend
npm install
npm run dev                     # :5173
```

Create a project, open it, and the frontend will call `/start` and wait for its pod before connecting.

## Environment variables

| Variable | Used by | Description |
|---|---|---|
| `S3_BUCKET` | init-service, runner | Bucket holding templates and per-project storage |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | init-service, runner, init container | Storage credentials |
| `S3_ENDPOINT` | init-service, runner | Override for S3-compatible storage (e.g. Cloudflare R2) |
| `PORT` | init-service, orchestrator-simple, runner | Service port (defaults: `3001`, `3002`, `3001`) |

`orchestrator-simple` authenticates to Kubernetes via `KubeConfig().loadFromDefault()` — it needs a valid kubeconfig (or in-cluster service account) available in its own environment, not an env var.

## Known limitations

- **No automatic run step, still.** Same gap as the single-host version — nothing runs `npm install`/starts the user's app automatically inside the pod. The Output iframe will only show something once the user manually starts a process on port 3000 in their terminal.
- **Credentials are inlined in the manifest template.** `service.yaml`'s init container sets `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` as plain string values substituted into the YAML — these belong in a Kubernetes Secret, not in a template committed to source control.
- **No pod teardown.** `orchestrator-simple` only exposes `/start`; nothing deletes a project's Deployment/Service/Ingress when the user is done, so pods accumulate indefinitely unless cleaned up manually or by an external process.
- **No auth or existence checks**, same as the single-host version — anyone who knows a `replId` can hit `/start` for it and reach its pod.
- **Terminal session cleanup bug carried over.** `TerminalManager` in `runner/src/pty.ts` still deletes sessions by PID instead of by the ID they were stored under.
- **No resource-usage guardrails beyond the static `resources.limits` in the manifest** — a single project can still exhaust its pod's allotted CPU/memory with no per-job monitoring or alerting.

This repo is the second iteration of [Session Multiplexer Code Shell](#) — same editor/terminal experience, rebuilt around per-project Kubernetes scheduling instead of a single shared host.

## License

MIT
