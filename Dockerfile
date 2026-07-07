# syntax=docker/dockerfile:1

# Combined container image: the Express API/MCP server plus the built
# first-party SPAs (portal, admin) and static pages (exec-summary, pitch-deck),
# all served on one origin under their path prefixes. Works on Railway, Render,
# Fly.io, or any container host.
#
# Database migrations: applied automatically on api-server startup (see
# artifacts/api-server/src/index.ts → runAppMigrations). SQL files are copied
# into the bundle at build time (artifacts/api-server/build.mjs).

# ---- Builder: install the workspace and build every piece ----
FROM node:24-slim AS builder
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.33.3 --activate

COPY . .
# Bust Docker layer cache on every Git deploy so api-server + frontends rebuild.
ARG RAILWAY_GIT_COMMIT_SHA=local
RUN echo "Railway build SHA=${RAILWAY_GIT_COMMIT_SHA}" > /tmp/build-sha
RUN pnpm install --frozen-lockfile

# API/MCP server → self-contained ESM bundle at artifacts/api-server/dist.
RUN pnpm --filter @workspace/api-server run build

# Frontends (Vite). Their vite configs validate PORT even for `build`, so a
# dummy build-time PORT is provided; BASE_PATH sets each app's public sub-path.
# The portal bakes in the Clerk publishable key at build time. On Railway,
# declare VITE_CLERK_PUBLISHABLE_KEY as a service variable so it is passed here.
ARG VITE_CLERK_PUBLISHABLE_KEY=""
ARG VITE_CLERK_PROXY_URL=""
RUN PORT=3000 BASE_PATH=/portal/ \
    VITE_CLERK_PUBLISHABLE_KEY="$VITE_CLERK_PUBLISHABLE_KEY" \
    VITE_CLERK_PROXY_URL="$VITE_CLERK_PROXY_URL" \
    pnpm --filter @workspace/portal run build
RUN PORT=3000 BASE_PATH=/admin/ pnpm --filter @workspace/admin run build
RUN PORT=3000 BASE_PATH=/exec-summary/ pnpm --filter @workspace/exec-summary run build
RUN PORT=3000 BASE_PATH=/pitch-deck/ pnpm --filter @workspace/pitch-deck run build

# ---- Runtime: minimal image carrying the bundle + built frontends ----
FROM node:24-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080

# Self-contained API bundle (no node_modules needed).
COPY --from=builder /app/artifacts/api-server/dist ./dist

# Built frontends, served by the API under their path prefixes
# (serve-frontends.ts looks for them in dist/frontends/<name>).
COPY --from=builder /app/artifacts/portal/dist/public ./dist/frontends/portal
COPY --from=builder /app/artifacts/admin/dist/public ./dist/frontends/admin
COPY --from=builder /app/artifacts/exec-summary/dist/public ./dist/frontends/exec-summary
COPY --from=builder /app/artifacts/pitch-deck/dist/public ./dist/frontends/pitch-deck

EXPOSE 8080
CMD ["node", "--enable-source-maps", "dist/index.mjs"]
