# Pinned by tag (not floating "node:20") so a rebuild doesn't silently pick
# up a new base image. Slim is fine here - unlike runner, this service never
# execs python3/pip or any other external binary (it talks to the
# Kubernetes API and AWS S3 through their SDKs, not shelled-out CLIs).
FROM node:20.18.1-bookworm-slim AS build
WORKDIR /code
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20.18.1-bookworm-slim
WORKDIR /code
# Numeric uid/gid so Kubernetes' runAsNonRoot check (which inspects the
# image, not /etc/passwd) is satisfiable, and so this uid can write the
# ownership DB once the Deployment mounts /data with a matching fsGroup
# (see k8s/scheduler-services.yaml).
RUN groupadd -g 1000 app && useradd -u 1000 -g app -m -s /usr/sbin/nologin app
COPY package*.json ./
# --omit=dev: this stage ships to the pod, so build-only deps (typescript)
# don't belong in the final image. Installed fresh here (not copied from
# the build stage) so better-sqlite3's native binary matches this stage's
# own base image.
RUN npm ci --omit=dev
COPY --from=build /code/dist ./dist
USER app

# orchestrator-simple listens on 3002 by default (see PORT in src/.env.example)
EXPOSE 3002

CMD [ "node", "dist/index.js" ]
