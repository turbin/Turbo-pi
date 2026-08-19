#!/usr/bin/env python3
"""Langfuse 端到端冒烟：stub omlx -> gateway(langfuse enabled) -> Langfuse API 验证。

用法：cd packages/agent-gateway && uv run python /tmp/lf_smoke.py
"""
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

GW_PORT = 8890
OMLX_PORT = 18099
REPO_ROOT = Path.cwd()
LF_ENV = REPO_ROOT / "packages/agent-server/eval/langfuse/.env"


def load_langfuse_keys():
    keys = {}
    for line in LF_ENV.read_text().splitlines():
        if line.startswith("LANGFUSE_INIT_PROJECT_PUBLIC_KEY="):
            keys["LANGFUSE_PUBLIC_KEY"] = line.split("=", 1)[1]
        if line.startswith("LANGFUSE_INIT_PROJECT_SECRET_KEY="):
            keys["LANGFUSE_SECRET_KEY"] = line.split("=", 1)[1]
    assert len(keys) == 2, "langfuse keys not found"
    return keys


class StubOmlx(BaseHTTPRequestHandler):
    def do_POST(self):
        body = {
            "id": "stub-1",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": "stub-9b",
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "smoke ok"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 11, "completion_tokens": 7, "total_tokens": 18},
        }
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass


CONFIG = """
[server]
host = "127.0.0.1"
port = 8890
admin_key_env = "AGW_ADMIN_KEY"
single_worker_lock = "/tmp/lf-smoke.lock"
sse_heartbeat_seconds = 1

[database]
url = "sqlite+aiosqlite:////tmp/lf-smoke.db"

[local_omlx]
base_url = "http://127.0.0.1:18099/v1"
model = "stub-9b"
timeout_seconds = 30
concurrency = 1

[cloud.kimi]
enabled = false

[cloud.deepseek]
enabled = false

[routing]
cloud_egress_default = false
selected_cloud_provider = "deepseek"
automatic_transport_retries = 0

[memory_index]
provider = "disabled"
enabled = false
write_async = false
read_timeout_ms = 300
max_hits = 5

[langfuse]
enabled = true
host = "http://localhost:3000"
environment = "exp-9b"

[[channels]]
key = "smoke-key"
client_id = "smoke"
workspace_id = "smoke"
channel_id = "smoke"
allowed_models = ["agent-auto"]
cloud_egress_allowed = false
"""


def main():
    # macOS 系统代理（ApexCore 127.0.0.1:7890）会被 httpx/urllib trust_env 拾取
    # 且不回 bypass 回环地址——回环流量必须显式 NO_PROXY。
    os.environ["NO_PROXY"] = "127.0.0.1,localhost"
    os.chdir("packages/agent-gateway")
    keys = load_langfuse_keys()

    stub = HTTPServer(("127.0.0.1", OMLX_PORT), StubOmlx)
    threading.Thread(target=stub.serve_forever, daemon=True).start()

    cfg = Path("/tmp/lf-smoke-config.toml")
    cfg.write_text(CONFIG)
    for f in ("/tmp/lf-smoke.db", "/tmp/lf-smoke.lock"):
        Path(f).unlink(missing_ok=True)

    env = {**os.environ, **keys, "AGW_ADMIN_KEY": "admin-smoke"}
    proc = subprocess.Popen(
        ["uv", "run", "python", "-m", "agent_gateway", "--config", str(cfg)],
        env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    try:
        # wait for gateway
        for _ in range(60):
            time.sleep(0.5)
            try:
                req = urllib.request.Request(
                    f"http://127.0.0.1:{GW_PORT}/v1/models",
                    headers={"Authorization": "Bearer smoke-key"},
                )
                urllib.request.urlopen(req, timeout=2)
                break
            except Exception:
                if proc.poll() is not None:
                    print(proc.stdout.read())
                    sys.exit("gateway died")
        else:
            sys.exit("gateway did not start")

        # chat completion
        payload = json.dumps({"model": "agent-auto", "messages": [{"role": "user", "content": "ping"}]}).encode()
        req = urllib.request.Request(
            f"http://127.0.0.1:{GW_PORT}/v1/chat/completions",
            data=payload,
            headers={"Authorization": "Bearer smoke-key", "Content-Type": "application/json"},
        )
        try:
            resp = json.loads(urllib.request.urlopen(req, timeout=30).read())
        except urllib.error.HTTPError as e:
            print("gateway error body:", e.read().decode())
            raise
        trace_id = resp["id"]
        print(f"gateway response id={trace_id} marker={resp.get('x_gateway')}")
        assert resp["choices"][0]["message"]["content"] == "smoke ok"

        # wait for langfuse ingestion, then verify（v4: 读走 v2/observations）
        import base64
        auth = base64.b64encode(f"{keys['LANGFUSE_PUBLIC_KEY']}:{keys['LANGFUSE_SECRET_KEY']}".encode()).decode()

        sys.path.insert(0, ".")
        from langfuse import Langfuse
        lf = Langfuse(public_key=keys["LANGFUSE_PUBLIC_KEY"], secret_key=keys["LANGFUSE_SECRET_KEY"], host="http://localhost:3000")
        expected = lf.create_trace_id(seed=trace_id)
        lf.shutdown()

        deadline = time.time() + 90
        found = None
        while time.time() < deadline:
            time.sleep(3)
            req = urllib.request.Request(
                "http://localhost:3000/api/public/v2/observations?limit=50",
                headers={"Authorization": f"Basic {auth}"},
            )
            data = json.loads(urllib.request.urlopen(req, timeout=10).read())
            for o in data.get("data", []):
                if o.get("name") == "omlx" and o.get("traceId") == expected:
                    found = o
                    break
            if found:
                break
        assert found, f"no 'omlx' generation with traceId={expected} in Langfuse within 90s"
        print(f"LANGFUSE OBSERVATION OK: id={found['id']} name={found['name']} env={found.get('environment')} latency={found.get('latency')}")
        print(f"JOIN KEY OK: create_trace_id(seed={trace_id}) == langfuse traceId")
        print("SMOKE PASS")
    finally:
        proc.terminate()
        try:
            out, _ = proc.communicate(timeout=10)
            print("---- gateway log tail ----")
            print("\n".join(out.splitlines()[-30:]))
        except subprocess.TimeoutExpired:
            proc.kill()
        stub.shutdown()


if __name__ == "__main__":
    main()
