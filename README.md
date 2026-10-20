# Ephemeral Sandbox Pod Scheduler

A browser-based code editor and terminal where every project runs in its **own
real, isolated Kubernetes pod** — not a shared container, not an iframe sandbox.
Open a project and it gets its own filesystem, CPU/memory limits, network
policy, and live terminal, reachable at its own subdomain, spun up on demand
and torn down when it's done. Think "a self-hosted Replit/CodeSandbox,
built from the orchestration layer up."

## What it does

1. **Create a project** — `init-service` seeds a starter template (Node.js or
   Python) into S3/R2 storage and records who owns it.
2. **Open it** — `orchestrator-simple` talks to the Kubernetes API to create a
   dedicated Deployment, Service, Ingress, and NetworkPolicy for that one
   project, scheduling a real pod just for it.
3. **Edit and run** — the frontend connects straight to that pod over
   Socket.IO for a live terminal (`node-pty`) and file editor (Monaco), while
   the pod's own `runner` auto-detects the project type and starts it, so the
   live preview is already up.
4. **Idle or done** — a background reaper watches activity and health across
   every running pod, auto-stopping idle projects and tearing down
   crash-looping ones, syncing files back to storage first.

## Highlights

- **Real per-project isolation**, not a shared sandbox: its own Kubernetes
  namespace, pod, and `NetworkPolicy` blocking access to other projects, the
  cloud metadata endpoint, and the cluster's internal network.
- **Zero-trust-ish auth**: asymmetric JWT (ES256) with key rotation support
  and pinned algorithms (no algorithm-confusion gap), per-project tokens
  derived by HMAC rather than one shared secret, and uid-separated terminal
  sessions so a user's shell can't read the backend process's own environment.
- **Scoped cloud credentials**: optional AWS STS integration hands each
  project temporary S3 credentials limited to its own storage prefix, instead
  of one bucket-wide key shared by everyone.
- **Self-healing lifecycle**: idle-timeout and max-lifetime reapers, crash-loop/OOM
  detection with optional Slack alerting, retry-with-backoff and
  capacity-aware scheduling against the Kubernetes API.
- **Actually tested**: ~130 automated tests (vitest) across all three
  backend services, plus a GitHub Actions pipeline running build/test/lint,
  Docker builds, Dockerfile linting (hadolint), dependency auditing, and
  Kubernetes manifest validation (kubeconform) on every PR.

## Architecture

```
Frontend (Vite + React)
   │
   ├─ POST /project  ────────────▶  init-service  ──▶ copy template → S3/R2
   │
   ├─ POST /start {replId} ──────▶  orchestrator-simple  ──▶ Kubernetes API
   │                                                              │
   │                                                              ├─ Deployment (runner + init container)
   │                                                              ├─ Service, Ingress, NetworkPolicy
   │
   └─ Socket.IO + iframe ────────▶  <replId>.<domain>  ──▶  nginx-ingress  ──▶  runner pod
                                                                                    │
                                                                            node-pty terminal
                                                                            file read/write
                                                                            user's own app process
```

## Tech stack

| Service | Role | Key technologies |
|---|---|---|
| `init-service` | Project creation & storage | Node.js, Express, TypeScript, AWS SDK (S3), JWT, SQLite |
| `orchestrator-simple` | Schedules per-project k8s resources, lifecycle & health monitoring | Node.js, Express, TypeScript, `@kubernetes/client-node`, AWS STS, SQLite |
| `runner` | Per-pod terminal + file sync | Node.js, Express, Socket.IO, `node-pty`, AWS SDK |
| `frontend` | Editor UI | React, Vite, TypeScript, Monaco Editor, xterm.js |
| `k8s/` | Cluster infra | Kubernetes, nginx-ingress, cert-manager |
| CI/CD | Build, test, security checks | GitHub Actions, vitest, hadolint, kubeconform |

## Project structure

```
init-service/           project creation, auth bootstrap, ownership store
orchestrator-simple/     schedules/tears down per-project k8s resources, health & lifecycle
runner/                  per-pod backend: terminal, file sync, auto-run
frontend/                React/Vite editor UI
landing/                 marketing site
k8s/                      cluster-level manifests (ingress, RBAC, TLS)
scripts/aws/              IAM setup for scoped S3 credentials
docs/ARCHITECTURE.md     deep dive: request flow, security model, every env var
HOSTING_GUIDE.md         step-by-step guide to hosting this on free-tier infra
```

## Running it locally

```bash
# init-service (:3001) and orchestrator-simple (:3002)
cd init-service && npm install && cp src/.env.example .env && npm run dev
cd orchestrator-simple && npm install && cp src/.env.example .env && npm run dev

# frontend (:5173)
cd frontend && npm install && npm run dev
```

Needs a Kubernetes cluster with `nginx-ingress`, an S3-compatible bucket with
starter templates, and a generated JWT key pair — see
[HOSTING_GUIDE.md](HOSTING_GUIDE.md) for a full walkthrough (including a
free-tier path: Cloudflare R2 + Pages, Oracle Cloud's free VM/k3s) or
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the complete environment
variable reference and every design decision behind it.

## Known limitations

Auth is an anonymous, device-bound identity (no login/password — out of
scope by design, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)); S3
credential isolation and TLS are both opt-in rather than on by default; and
a few things are designed but not yet built (pod pre-warming, a queued-start
flow, a frontend "Stop" button). Full list in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#known-limitations).

## License

MIT
