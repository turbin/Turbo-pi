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

# make/g++ are the node-gyp fallback for better-sqlite3 (linux prebuilds
# normally apply); python3 is the offline-pipeline runtime (vendored packages
# are stdlib-only).
RUN apt-get update \
	&& apt-get install -y --no-install-recommends python3 make g++ \
	&& rm -rf /var/lib/apt/lists/*

# Workspace manifests first for dependency-layer caching.
COPY package.json package-lock.json .npmrc ./
COPY packages/ai/package.json packages/ai/
COPY packages/agent/package.json packages/agent/
COPY packages/tui/package.json packages/tui/
COPY packages/coding-agent/package.json packages/coding-agent/
COPY packages/orchestrator/package.json packages/orchestrator/
COPY packages/agent-server/package.json packages/agent-server/
RUN npm ci --ignore-scripts

COPY . .
# @earendil-works/pi-ai resolves to dist/ at runtime, so build the TS
# packages; then rebuild the native binding against this image's Node and
# drop devDependencies from the runtime tree.
RUN npm run build \
	&& npm rebuild better-sqlite3 \
	&& npm prune --omit=dev

FROM node:25.9.0-bookworm-slim
RUN apt-get update \
	&& apt-get install -y --no-install-recommends python3 \
	&& rm -rf /var/lib/apt/lists/* \
	&& mkdir -p /data/sessions

WORKDIR /app
ENV NODE_ENV=production \
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
