# syntax=docker/dockerfile:1

# Portable container image for the Bullhorn ATS MCP server.
# Works on Railway, Render, Fly.io, or any container host.

# ---- Builder: install workspace deps and bundle the API server ----
FROM node:24-slim AS builder
WORKDIR /app

# Enable pnpm via corepack, pinned to match pnpm-lock.yaml.
RUN corepack enable && corepack prepare pnpm@10.33.3 --activate

# Copy the whole pnpm workspace and install with the committed lockfile.
COPY . .
RUN pnpm install --frozen-lockfile

# Bundle the API server into a self-contained ESM build (dist/index.mjs).
RUN pnpm --filter @workspace/api-server run build

# ---- Runtime: minimal image that only carries the compiled bundle ----
FROM node:24-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080

# The build is self-contained (only optional native modules are externalized),
# so the runtime image needs just the compiled dist directory — no node_modules.
COPY --from=builder /app/artifacts/api-server/dist ./dist

EXPOSE 8080
CMD ["node", "--enable-source-maps", "dist/index.mjs"]
