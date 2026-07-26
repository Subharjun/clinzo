# =============================================================================
# Clinzo Scheduling — production image
#
# Multi-stage, for three reasons that matter in practice:
#   1. The runtime image carries no compiler, no dev dependencies and no
#      TypeScript source — a smaller image is both faster to deploy and a
#      smaller attack surface.
#   2. Dependency installation is a separate, cache-friendly layer, so a source
#      change does not trigger a full `npm ci`.
#   3. The build stage can fail loudly on a type error before anything ships.
# =============================================================================

# --- Stage 1: dependencies ---------------------------------------------------
FROM node:22-alpine AS deps

WORKDIR /app

# `libc6-compat` is required by Prisma's engine binaries on Alpine (musl).
# Omitting it produces a confusing runtime "cannot find engine" failure.
RUN apk add --no-cache libc6-compat

# Copy only the manifests first: this layer is invalidated by a dependency
# change, not by every source edit.
COPY package.json package-lock.json ./
COPY prisma ./prisma

# `npm ci` (not `install`) — installs exactly the lockfile, so the image is
# reproducible and a drifted lockfile fails the build instead of being fixed up.
RUN npm ci --ignore-scripts && npx prisma generate

# --- Stage 2: build ----------------------------------------------------------
FROM node:22-alpine AS build

WORKDIR /app
RUN apk add --no-cache libc6-compat

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Regenerate against the copied schema, then compile. A type error here stops
# the build rather than surfacing in production.
RUN npx prisma generate && npm run build

# Drop dev dependencies from the tree that will be copied forward.
RUN npm prune --omit=dev

# --- Stage 3: runtime --------------------------------------------------------
FROM node:22-alpine AS runtime

WORKDIR /app

# `dumb-init` gives us a real PID 1 that forwards SIGTERM. Without it, Node
# runs as PID 1 and the graceful-shutdown handler never fires, so in-flight
# booking transactions are killed mid-flight on every deploy.
RUN apk add --no-cache libc6-compat dumb-init

ENV NODE_ENV=production \
    TZ=UTC \
    NPM_CONFIG_UPDATE_NOTIFIER=false

# Run unprivileged. The `node` user ships with the base image.
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node --from=build /app/public ./public
COPY --chown=node:node --from=build /app/prisma ./prisma
COPY --chown=node:node --from=build /app/package.json ./package.json

USER node

EXPOSE 3000

# Distinct from the orchestrator's probe, but useful for `docker run` and for
# compose's `depends_on: service_healthy`.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/health/live',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]
