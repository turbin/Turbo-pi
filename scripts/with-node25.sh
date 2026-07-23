#!/usr/bin/env bash
# Run a command under the repo-local pinned Node toolchain.
#
# Why: the system Node (Homebrew) moved to v26, but better-sqlite3 11.10.0
# has no prebuild for Node 26 and its sources do not compile against the
# Node 26 V8 API. The agent-server native binding in node_modules is built
# for Node 25 (ABI 141). This wrapper prepends the pinned toolchain to PATH
# so tests and the server always run under the matching Node.
#
# Setup (one time, per machine):
#   mkdir -p .tools
#   curl -L https://nodejs.org/dist/v25.9.0/node-v25.9.0-darwin-arm64.tar.gz | tar -xz -C .tools
#   # then, if node_modules was hydrated under another Node major:
#   scripts/with-node25.sh npm rebuild better-sqlite3
#
# Usage:
#   scripts/with-node25.sh node ../../node_modules/vitest/dist/cli.js --run   # from packages/agent-server
#   scripts/with-node25.sh npm rebuild better-sqlite3
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_DIR="$ROOT/.tools/node-v25.9.0-darwin-arm64"

if [ ! -x "$NODE_DIR/bin/node" ]; then
	echo "with-node25: pinned Node not found at $NODE_DIR" >&2
	echo "Install it with:" >&2
	echo "  mkdir -p .tools && curl -L https://nodejs.org/dist/v25.9.0/node-v25.9.0-darwin-arm64.tar.gz | tar -xz -C .tools" >&2
	exit 1
fi

export PATH="$NODE_DIR/bin:$PATH"
exec "$@"
