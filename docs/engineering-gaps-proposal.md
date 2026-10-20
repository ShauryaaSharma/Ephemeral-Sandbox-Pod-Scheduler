# Engineering gaps proposal (items 27-31)

What this repo does: provisions one Kubernetes pod per browser-IDE project on demand (two Node schedulers plus a per-pod terminal/file-sync backend), seeded from and synced back to S3. Load assumed: a handful to a few dozen concurrent project pods on one small cluster - a portfolio-scale deployment, not a multi-tenant SaaS at real scale. That assumption shapes every effort estimate below: options that would matter at thousands of pods (a message queue, a distributed rate limiter) are named only to be set aside.

For each item: 2-3 options, trade-offs, a recommendation, and an effort estimate. Audit findings referenced inline are from a full-repo pass done for this proposal (findings list at the bottom).

## 27. Tests and CI

**Options**:
1. **Minimal harness now, GitHub Actions wired to it.** `vitest` already exists in all three backends (added across the security-hardening/engineering-gaps work) - extend it to cover the listed logic (reaper, health classification, rate limiter, `translateK8sError`, `withRetry`, `checkPodSchedulable`, ownership DB, auth middleware, validators/path-guard/token-derivation/env-whitelist - the last four already have tests). Add one GitHub Actions workflow: per-package `npm ci`/build/test/lint, `docker build` per Dockerfile (no push), `npm audit --audit-level=high` (non-blocking), and manifest validation (kubeconform) + hadolint. Effort: **large** (this is most of the work item 27 actually asks for), but each piece is independently small and uses tools already in the repo.
2. **Tests only, no CI.** Write the same tests, skip the workflow file. Catches regressions locally, catches nothing automatically on a PR. Effort: medium, but leaves the exact gap the README's own "Status" section already flags (tests exist in spirit, not in the repo) half-fixed.
3. **CI only, defer tests.** Wire a workflow that just runs build/lint/docker build/audit/manifest validation now, backfill tests later. Gets *something* running on every PR immediately, but the riskiest logic (reaper, health classification, rate limiter) stays unverified by CI either way.

**Recommendation**: option 1. It's more work than 2 or 3 individually, but splitting it loses the actual point - tests nobody runs automatically are exactly today's problem, restated. **Effort: large.** A kind-based end-to-end job (spin up a real k3s cluster in CI, run `/start`/`/stop` against it) is evaluated and marked **optional** below, not included in the default workflow - it needs a registry-pushed image per PR run, which is a real cost/complexity step up from everything else here, and nothing in this repo has ever been tested against a live cluster to begin with (every "Status" entry says so explicitly). A follow-up, not a blocker.

## 28. `console.log(docString)` leaking manifest contents

Finding: `orchestrator-simple/src/index.ts`'s `readAndParseKubeYaml` prints the **entire substituted manifest** (including the real `ownerId`, a UUID, and `replId`) on every single `/start` call, unconditionally, to stdout/whatever ships the logs. Every other log line in the three services was also checked for secrets/tokens/owner IDs (see findings list) - this is the only other hit beyond what A3 already closed (the master-key/per-pod-token design means no secret value is ever logged, by construction, as of that change).

**Options**:
1. **Leveled logger, `LOG_LEVEL` (default `info`), demote this line to `debug`.** Smallest change: wrap `console.log`/`console.warn`/`console.error` in a ~15-line logger module (duplicated per service like `rateLimit.ts`, or shared - see item 29) that gates on level, and change this one call site to `logger.debug(docString)`. No new dependency.
2. **Same, but pull in `pino`/`winston`.** Gets structured JSON logs, log redaction helpers, etc. - genuinely nicer for a real production deployment, but is new surface area (a dependency, a config shape) for a problem a 15-line wrapper already solves at this scale.
3. **Delete the line entirely.** Simplest fix, but the manifest text is genuinely useful when debugging a bad substitution - better to keep it reachable behind a level than lose it.

**Recommendation**: option 1. **Effort: small.**

## 29. Duplicated auth and rate-limit code

Finding: `auth.ts` (JWT verify + `requireAuth` middleware) and `rateLimit.ts` (token-bucket) are near-identical across `init-service`/`orchestrator-simple` (and `runner` has its own verify-only `auth.ts`) - confirmed byte-identical today (`diff` on both rate limiters returns nothing), by design per the existing code comments ("duplicated rather than shared, matching this project's existing pattern"). The risk isn't that they're duplicated now, it's that nothing stops them silently drifting (a fix applied to one copy and not the other).

**Options**:
1. **npm workspaces + a shared `@ephemeral-sandbox/shared` package.** The "real" fix - one copy of `auth.ts`/`rateLimit.ts`/the validators, imported by all three. The actual cost: each service's `Dockerfile` currently does `COPY . .` from a build context scoped to that service's own directory (`docker build -t ... ./runner`, etc., per the README). A workspace package living above all three service directories means every Dockerfile's build context has to move to the **repo root** (`docker build -f runner/Dockerfile .`), and every `COPY package*.json ./` / `COPY . .` step has to account for the shared package's own `package.json` and source being copied in too, in the right place in the image, before `npm ci` resolves the workspace link. This touches all three Dockerfiles, `.dockerignore` files, and every `docker build` invocation documented in the README/HOSTING_GUIDE - a real, cross-cutting change, not a refactor contained to source files.
2. **Keep the copies, add a CI check that diffs them.** A few lines in the new GitHub Actions workflow (item 27): `diff init-service/src/rateLimit.ts orchestrator-simple/src/rateLimit.ts` (and the shared part of `auth.ts`'s middleware shape, though its asymmetric-key config legitimately differs by service) fails the build the moment they drift. Zero runtime risk, zero Docker/build-context changes, costs one workflow step.
3. **Leave it, document it.** The existing code comments already say this is deliberate. Doing nothing further is honest but doesn't actually close the "silent drift" risk the comments themselves don't protect against.

**Recommendation**: option 2. It's the "prefer the simplest option that stays honest" one: it directly closes the one real risk (silent drift) without taking on a Docker-build-context migration that has nothing to do with that risk. Revisit option 1 only if a fourth service shows up and the duplication count triples. **Effort: small** (it's one `diff` line per duplicated pair, added to item 27's new workflow).

## 30. Dockerfiles

Findings: `runner/Dockerfile` already does most of this (multi-stage, non-root `USER`, pinned `node:20.18.1-bookworm`, `--omit=dev` in the runtime stage - from the security-hardening work, with the A3 exception that it now runs as root with two capabilities inside the *pod* spec, not the image itself, which is unrelated to how the image is built). `init-service/Dockerfile` and `orchestrator-simple/Dockerfile` are both still the original single-stage `FROM node:20` (floating tag), `RUN npm install` (not `npm ci`), no non-root `USER`, no pinned version. `amazon/aws-cli` (the init container's image, in `service.yaml`) is referenced with no tag at all (`image: amazon/aws-cli`, i.e. `:latest`). `.dockerignore` exists in all three services (`node_modules`/`dist`/`.env`) and is fine as-is. Kubernetes already sends `SIGTERM` directly to PID 1 without an intermediary shell wrapper in any of these three Dockerfiles' `CMD` (`CMD ["node", "dist/index.js"]`, not `CMD npm start` - the latter is the classic signal-swallowing trap, and none of these three hit it) - so `tini` fixes a problem these Dockerfiles don't currently have, for `runner` specifically.

**Options**:
1. **Multi-stage + pinned + non-root for `init-service`/`orchestrator-simple` (mirroring `runner`'s existing pattern exactly); pin `amazon/aws-cli` to a digest or version tag in `service.yaml`; skip `tini`.** Brings the two stragglers in line with the pattern already proven in `runner`. No `tini`, since `node dist/index.js` as `CMD` already is PID 1 and already receives `SIGTERM` directly - adding `tini` on top adds a process with no bug to fix.
2. **Same, but add `tini` anyway "for safety."** Costs one more binary and one more layer of indirection in the image, to guard against a failure mode (a shell swallowing `SIGTERM` before Node sees it) that doesn't exist in any of these three `CMD`s today. If `CMD` ever changes to something that spawns Node as a child of a shell, this stops being true - worth a one-line comment at that point, not a dependency now.
3. **Leave `init-service`/`orchestrator-simple` as-is, pin only `amazon/aws-cli`.** Smallest diff, but leaves both schedulers running as root with an unpinned, floating base image - the exact gap the rest of this item exists to close.

**Recommendation**: option 1. **Effort: small-medium** (two Dockerfiles to rewrite following an existing template, one manifest line to pin).

## 31. Probes and termination

Findings: `service.yaml`'s runner container has no `startupProbe`/`readinessProbe`/`livenessProbe` at all - Kubernetes currently has no way to know the pod is actually up before routing traffic to it, or to restart it if it hangs. No `terminationGracePeriodSeconds` is set anywhere (defaults to 30s) - the runner's own shutdown path (`flushPendingS3Writes` + `syncWorkspaceToS3`, bounded to 8s via `SYNC_TIMEOUT_MS`) comfortably fits inside the 30s default already, so this isn't currently broken, but it's also not documented as deliberately sufficient, and tightens uncomfortably close if `SYNC_TIMEOUT_MS` is ever raised. `init-service`/`orchestrator-simple`'s own `scheduler-services.yaml` Deployments have no probes either.

**Options**:
1. **Add `/healthz` (always 200, no auth, no data) and `/readyz` (200 once `/workspace` exists and the HTTP/WS server is listening, no auth, no data) to the runner; wire `startupProbe`/`readinessProbe`/`livenessProbe` to them on the project pod and both scheduler Deployments; set `terminationGracePeriodSeconds: 15` (8s sync timeout + margin) on the project pod.** Keeps `/health` (which returns real data: `replId`, `lastActivityAt`) token-gated exactly as it is today - these two new endpoints return nothing, by design, so they need no auth to be safe to expose to the kubelet.
2. **Reuse `/health` for probes, skip the new endpoints.** Fewer routes, but means either exempting `/health` from the token check (undoing A3's work) or teaching every kubelet probe to send the internal token (kubelet probes don't support custom headers in the stable API - `httpGet.httpHeaders` does exist, but it means putting the per-pod token in the pod spec/manifest as a literal probe config value, which is exactly the "literal env value in the manifest" pattern A3 moved away from). Not pursued.
3. **Only add the pod-level probes/grace period, skip new runner endpoints**, pointing `readinessProbe` at the existing unauthenticated... there isn't one (`/health` is gated, nothing else exists) - this option doesn't actually work without inventing an endpoint, so it collapses into option 1.

**Recommendation**: option 1. **Effort: small** (two trivial routes, a handful of manifest fields, confirm the SIGTERM handler still flushes - already true structurally, re-verify after the probe/grace-period change).

---

## Audit findings used above (and one found along the way)

- **`frontend`'s own `npm run build` currently fails outright** (`tsc && vite build`, confirmed by running it: exits 2, produces no `dist/`) - nine pre-existing TypeScript errors (several unused imports; two real type-correctness issues in `Terminal.tsx`'s `ab2str` helper and `external/editor/editor/code.tsx`'s Monaco `onChange` handler). Outside items 27-31's scope, but real and cheap to fix (see final report) - noted here rather than silently left for later, since "Should fix: a function with no test that breaks, real slowness, code that shouldn't exist" is squarely what this audit is for.
- `console.log(docString)` in `orchestrator-simple/src/index.ts` - item 28.
- `auth.ts`/`rateLimit.ts` duplication, currently in sync but with nothing enforcing that - item 29.
- `init-service`/`orchestrator-simple` Dockerfiles not multi-stage, not pinned, root `USER`; `amazon/aws-cli` unpinned - item 30.
- No probes, no explicit `terminationGracePeriodSeconds` - item 31.
- No tests for `reapOnce`, `checkPodHealth`/`getPodResourceUsage`, the rate limiter, `translateK8sError`/`withRetry`/`checkPodSchedulable`, the ownership DB, or the auth middleware - item 27. (Validators, the path guard, HMAC token derivation, and the env whitelist already have tests, added across the security-hardening and engineering-gaps work.)
- Checked and found no issue: the reaper's and health monitor's per-project loops are sequential (`for...await`, not `Promise.all`) - at the assumed scale (a handful to a few dozen pods, polled every 30-60s) this is a non-issue, not worth the complexity of parallelizing with no evidence it's ever been slow.
- Not re-audited line-by-line: `frontend/src/components/external/editor/` (already covered by the cleanup-leftovers branch's provenance review) and the `landing/` marketing site (no backend connection, nothing to audit for correctness/security).

**Verdict**: the backend/infra work (A1-A6, this repo's prior branches) is solid; the gaps here are typical for a project that was built and secured before it had a test harness or CI, not signs of deeper trouble. Fix 27-31 roughly in the order listed - 27 and 28 first (the test harness item 31's probes will want anyway, and a one-line log fix), then 29-31.
