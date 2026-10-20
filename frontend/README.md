# frontend

The browser IDE for [Ephemeral Sandbox Pod Scheduler](../README.md) - a React + Vite single-page app with two routes:

- `/` ([`Landing.tsx`](src/components/Landing.tsx)) - create a project (calls `init-service`'s `POST /project`).
- `/coding` ([`CodingPage.tsx`](src/components/CodingPage.tsx)) - the actual editor and terminal for an opened project: a Monaco editor ([`Editor.tsx`](src/components/Editor.tsx)), an xterm.js terminal ([`Terminal.tsx`](src/components/Terminal.tsx)), and an `Output.tsx` iframe preview, all talking to that project's own pod.

## Scripts

From `package.json`:

- `npm run dev` - Vite dev server (`:5173` by default).
- `npm run build` - type-checks (`tsc`) then builds for production (`vite build`) into `dist/`.
- `npm run preview` - serves the production build locally.
- `npm run lint` - ESLint.

## Environment variables

See [`.env.example`](.env.example) - only needed if you're not running everything on `localhost` with the default domains:

| Variable | Description |
|---|---|
| `VITE_INIT_SERVICE_URL` / `VITE_ORCHESTRATOR_URL` | Full base URLs for `init-service`/`orchestrator-simple`. **Required for any real deployment** - without them, a deployed frontend tries to reach its own `localhost`. |
| `VITE_WS_DOMAIN` / `VITE_APP_DOMAIN` | Must match `orchestrator-simple`'s `WS_DOMAIN`/`APP_DOMAIN` - the two domains a project is reachable at. |
| `VITE_USE_TLS` | `"true"` once cert-manager is set up cluster-side - switches the per-project socket/iframe connections from `ws`/`http` to `wss`/`https`. |

## How it connects to the backend

Every backend address is centralized in [`src/lib/config.ts`](src/lib/config.ts), built from the env vars above:

1. On load, [`src/lib/auth.ts`](src/lib/auth.ts) calls `init-service`'s `POST /auth/session` and caches the anonymous token it gets back in `localStorage`.
2. `Landing.tsx` sends that token as a bearer token to `init-service`'s `POST /project` to create a project.
3. `CodingPage.tsx` sends it to `orchestrator-simple`'s `POST /start` to schedule the project's pod, then connects a Socket.IO client directly to `<replId>.<VITE_WS_DOMAIN>` (presenting the token in the handshake) for the editor/terminal, and points the `Output.tsx` iframe at `<replId>.<VITE_APP_DOMAIN>` for the running app preview.

See [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md#how-it-works) for the full request flow across all services.

## Build & deploy

`npm run build` produces a static `dist/` - deploy it anywhere static files are served. See [HOSTING_GUIDE.md](../HOSTING_GUIDE.md) for a worked example (Cloudflare Pages). Whatever you use, set `VITE_INIT_SERVICE_URL`/`VITE_ORCHESTRATOR_URL` as build-time environment variables for that deployment - the defaults only work for local dev.
