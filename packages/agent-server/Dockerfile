# syntax=docker/dockerfile:1
# agent-server all-in-one image.
#
# Build context MUST be the repository root (agent-server resolves workspace
# packages like @earendil-works/pi-ai through the npm workspace symlinks):
#
#   docker build -f packages/agent-server/Dockerfile -t agent-server:local .
#
# The Node version is pinned to 25.9.0 on purpose: better-sqlite3 11.10.0 has
# no prebuild for Node 26 and does not compile against its V8 API. Keep this
# tag in sync with scripts/with-node25.sh until better-sqlite3 is upgraded.

FROM node:25.9.0-bookworm-slim AS build
WORKDIR /app

# Optional npm registry mirror (e.g. https://registry.npmmirror.com for
# builds behind the GFW where registry.npmjs.org is unreachable).
# NODE_DISTURL: mirror for Node.js headers needed by node-gyp source compiles
# (e.g. https://cdn.npmmirror.com/binaries/node).
ARG NPM_REGISTRY
ARG NODE_DISTURL
RUN if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi

# make/g++ are the node-gyp fallback for better-sqlite3 (linux prebuilds
# normally apply); python3 is the offline-pipeline runtime (vendored packages
# are stdlib-only); ca-certificates lets Python TLS-verify HTTPS LLM endpoints.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

# Workspace manifests first for dependency-layer caching.
COPY package.json package-lock.json .npmrc ./
COPY packages/ai/package.json packages/ai/
COPY packages/agent/package.json packages/agent/
COPY packages/tui/package.json packages/tui/
COPY packages/coding-agent/package.json packages/coding-agent/
COPY packages/orchestrator/package.json packages/orchestrator/
COPY packages/agent-server/package.json packages/agent-server/
RUN npm_config_disturl=${NODE_DISTURL:-https://nodejs.org/download/release} npm ci

COPY . .
# agent-server runs .ts directly via Node 25 erasable TypeScript; all
# @earendil-works/pi-ai imports are `import type` (erased at runtime), so
# no workspace TS build is needed. Drop devDependencies from the runtime tree.
# npm ci (without --ignore-scripts) lets better-sqlite3 download its prebuild
# from GitHub releases during install, avoiding a node-gyp source compile
# that would need Node headers from nodejs.org.
RUN npm prune --omit=dev

FROM node:25.9.0-bookworm-slim
RUN apt-get update \
	&& apt-get install -y --no-install-recommends python3 ca-certificates \
	&& rm -rf /var/lib/apt/lists/* \
	&& mkdir -p /data/sessions

WORKDIR /app
ENV NODE_ENV=production \
	HOST=0.0.0.0 \
	PORT=8788 \
	EXPERIENCE_STORE_PATH=/data/experience.db \
	AGENT_SERVER_SESSION_DIR=/data/sessions \
	GATEWAY_URL=http://host.docker.internal:8787 \
	AGENT_SERVER_PYTHON=python3 \
	AGENT_SERVER_PYTHON_DIR=/app/packages/agent-server/python

COPY --from=build /app /app

# /data holds the experience SQLite DB and session JSONL files.
VOLUME ["/data"]
EXPOSE 8788

# Node 25 strips erasable TypeScript at load time; src/ runs directly.
CMD ["node", "packages/agent-server/src/start.ts"]
