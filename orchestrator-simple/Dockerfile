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
# The base image already ships a "node" user/group at uid/gid 1000 (confirmed
# by actually building this - a redundant groupadd here fails with "GID 1000
# already exists") - reuse it below instead of creating a new one. Matches
# Kubernetes' runAsUser/runAsGroup/fsGroup (1000) in k8s/scheduler-services.yaml,
# and lets that uid write the ownership DB once the Deployment mounts /data
# with a matching fsGroup.
COPY package*.json ./
# --omit=dev: this stage ships to the pod, so build-only deps (typescript)
# don't belong in the final image. Installed fresh here (not copied from
# the build stage) so better-sqlite3's native binary matches this stage's
# own base image.
RUN npm ci --omit=dev
COPY --from=build /code/dist ./dist
USER node

# orchestrator-simple listens on 3002 by default (see PORT in src/.env.example)
EXPOSE 3002

CMD [ "node", "dist/index.js" ]
