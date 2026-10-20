# Pinned by tag (not floating "node:20") so a rebuild doesn't silently pick
# up a new base image. Full (not "-slim") Debian image, not slim - Python
# projects' autorun step (see src/autorun.ts) execs python3/pip inside this
# same container, which the slim variant doesn't include.
FROM node:20.18.1-bookworm AS build
WORKDIR /code
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20.18.1-bookworm
WORKDIR /code
# The base image already ships a "node" user/group at uid/gid 1000 (confirmed
# by actually building this - a redundant groupadd here fails with "GID 1000
# already exists") - reuse it below instead of creating a new one. Matches
# the pod/container securityContext's runAsUser/runAsGroup/fsGroup (1000) in
# orchestrator-simple/service.yaml, and lets this uid read/write /workspace
# once the orchestrator mounts it with fsGroup 1000.
COPY package*.json ./
# --omit=dev: this stage ships to the pod, so build-only deps (typescript,
# ts-node, nodemon, @types/*) don't belong in the final image.
RUN npm ci --omit=dev
COPY --from=build /code/dist ./dist
USER node

# Your app binds to port 3000 so you'll use the EXPOSE instruction to have it mapped by the docker daemon
EXPOSE 3000 3001

# Define the command to run your app using CMD which defines your runtime
CMD [ "node", "dist/index.js" ]
