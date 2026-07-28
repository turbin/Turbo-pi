#!/bin/bash
# Inject host forward proxy into TB tasks' run-tests.sh (local tb_tasks cache,
# gitignored). Test-phase network (apt + uv + pytest install) then rides the
# host network instead of the flaky colima VM uplink. Assertions unchanged.
# Idempotent: skips files already injected.
#
# Usage: ./inject-proxy-into-tests.sh [task-dir ...]   (default: all tb_tasks/*)

set -euo pipefail
cd "$(dirname "$0")"

PROXY="http://host.docker.internal:8898"
MARKER="# EVAL-PROXY-INJECT"

snippet=$(cat <<EOF
$MARKER: route test-phase network via host forward proxy + tuna mirrors (see eval/host_forward_proxy.mjs)
export HTTP_PROXY=$PROXY HTTPS_PROXY=$PROXY http_proxy=$PROXY https_proxy=$PROXY
export UV_DEFAULT_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
sed -i 's|deb\\.debian\\.org|mirrors.tuna.tsinghua.edu.cn|g; s|security\\.debian\\.org|mirrors.tuna.tsinghua.edu.cn|g; s|archive\\.ubuntu\\.com|mirrors.tuna.tsinghua.edu.cn|g; s|security\\.ubuntu\\.com|mirrors.tuna.tsinghua.edu.cn|g; s|ports\\.ubuntu\\.com|mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources 2>/dev/null || true
mkdir -p /etc/apt/apt.conf.d && printf 'Acquire::http::Proxy "$PROXY";\nAcquire::https::Proxy "$PROXY";\n' > /etc/apt/apt.conf.d/99eval-proxy || true
EOF
)

targets=("${@:-tb_tasks/*/run-tests.sh}")
[ $# -gt 0 ] && targets=("$@")

count=0
for f in "${targets[@]}"; do
    [ -f "$f" ] || continue
    if grep -q "$MARKER" "$f"; then
        continue
    fi
    # Insert after shebang (and after the canary comment if present on line 2+)
    tmp=$(mktemp)
    head -1 "$f" > "$tmp"
    echo "$snippet" >> "$tmp"
    tail -n +2 "$f" >> "$tmp"
    mv "$tmp" "$f"
    count=$((count + 1))
done
echo "injected proxy into $count run-tests.sh file(s)"
