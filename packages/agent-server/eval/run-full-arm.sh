#!/bin/bash
# E2.3 full-run helper: ./run-full-arm.sh <control|experiment> <1|2>
# Half 1 = first 40 tasks (sorted), half 2 = remaining 39. Arms run sequentially.
#
# M8 (2026-08-09): both arms run through an agent-server instance; the only
# difference is the injection toggle. Control arm uses the dedicated :8790
# instance (AGENT_SERVER_INJECTION=off, auto-started by preflight); the
# experiment arm uses :8789 (injection on). Direct DeepSeek and the 8899
# relay bypasses are retired.
set -euo pipefail
cd "$(dirname "$0")"
ARM=$1; HALF=$2
set -a; source ../.env; set +a
export HTTP_PROXY=http://host.docker.internal:8898 HTTPS_PROXY=http://host.docker.internal:8898 http_proxy=http://host.docker.internal:8898 https_proxy=http://host.docker.internal:8898
export OPENAI_API_KEY="$DEEPSEEK_API_KEY"
if [ "$ARM" = control ]; then
    export OPENAI_BASE_URL="http://host.docker.internal:8790/v1"
else
    export OPENAI_BASE_URL="http://host.docker.internal:8789/v1"
fi
ALL=($(ls tb_tasks | sort))
if [ "$HALF" = 1 ]; then TASKS=("${ALL[@]:0:40}"); else TASKS=("${ALL[@]:40}"); fi
ARGS=(); for t in "${TASKS[@]}"; do ARGS+=(-t "$t"); done
echo "arm=$ARM half=$HALF tasks=${#TASKS[@]} base=$OPENAI_BASE_URL"
./.venv/bin/tb run --dataset-path tb_tasks \
    --agent-import-path tb_agents.mini_swe_agent_proxy:MiniSweAgentProxy \
    -m openai/deepseek-v4-flash "${ARGS[@]}" \
    --n-concurrent 2 --no-upload-results \
    --output-path "results/tb-full-20260729/$ARM-half$HALF"
