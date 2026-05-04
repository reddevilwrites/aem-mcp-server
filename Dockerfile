# syntax=docker/dockerfile:1.7
#
# AEM MCP Server — multi-stage container build.
#
# Targets a small, non-root, prod-only image suitable for free-tier PaaS
# deployment (Render, Fly.io, Railway). Final image is ~150 MB on Alpine and
# starts in HTTP mode by default.

# ─────────────────────────────────────────────────────────────────────────────
# Stage 1 — build
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS build

WORKDIR /app

# Copy lockfile first for better layer caching. If package-lock.json is
# absent, fall back to a regular install — local dev hasn't generated one yet.
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# Copy sources and build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Strip dev dependencies for the runtime stage
RUN npm prune --omit=dev

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2 — runtime
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

# Small, defensible defaults
ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps

WORKDIR /app

# Run as the non-root `node` user that the official image already provides
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist         ./dist
COPY --from=build --chown=node:node /app/package.json ./package.json

USER node

# Render / Railway / Fly all inject PORT — honour it. 3000 is just the default
# for local `docker run`.
ENV PORT=3000
EXPOSE 3000

# Healthcheck hits the unauthenticated /healthz endpoint exposed by
# src/http-server.ts. Uses Node's built-in fetch (Node 20+) so we don't need
# curl/wget in the final image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

# Start in HTTP mode by default. Override with `docker run ... <args>` to use
# stdio (e.g. for Claude Desktop wrapped via docker exec).
ENTRYPOINT ["node", "dist/index.js"]
CMD ["--http"]
