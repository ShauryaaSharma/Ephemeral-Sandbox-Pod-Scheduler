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
# Matches the pod/container securityContext's runAsUser/runAsGroup/fsGroup
# (1000) in orchestrator-simple/service.yaml - must be numeric so
# Kubernetes' runAsNonRoot check (which inspects the image, not /etc/passwd)
# is satisfiable, and so this uid can read/write /workspace once the
# orchestrator mounts it with fsGroup 1000.
RUN groupadd -g 1000 app && useradd -u 1000 -g app -m -s /bin/bash app
COPY package*.json ./
# --omit=dev: this stage ships to the pod, so build-only deps (typescript,
# ts-node, nodemon, @types/*) don't belong in the final image.
RUN npm ci --omit=dev
COPY --from=build /code/dist ./dist
USER app

# Your app binds to port 3000 so you'll use the EXPOSE instruction to have it mapped by the docker daemon
EXPOSE 3000 3001

# Define the command to run your app using CMD which defines your runtime
CMD [ "node", "dist/index.js" ]
