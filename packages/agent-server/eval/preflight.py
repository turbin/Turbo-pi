#!/usr/bin/env python3
"""Preflight dependency checks for eval batch runs (2026-08-05).

Every batch entrypoint (alfworld_agent.py, harness.py, d3_discriminate.py)
must call ensure_for_base_url() before starting. It maps the target endpoint
to the local services that endpoint depends on, probes each one, auto-starts
the ones we own (agent-server, gateway, deepseek relay) via nohup, and fails
fast with an actionable message for the ones we do not (omlx app).

Rationale: batch runs that bypass agent-server starve the learning loop of
traces; worse, a run against a dead dependency silently burns hours. The
dependency graph (2026-08-05):

    :8789 agent-server  -> :8787 gateway -> :8000 omlx (student)
    :8787 gateway       -> :8000 omlx
    :8899 deepseek relay -> api.deepseek.com (external)
    external URL        -> no local deps
"""

import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

EVAL_DIR = Path(__file__).resolve().parent
PKG_DIR = EVAL_DIR.parent  # packages/agent-server
REPO_ROOT = PKG_DIR.parent.parent
GATEWAY_DIR = REPO_ROOT / "packages" / "agent-gateway"
ENV_FILE = PKG_DIR / ".env"

OMLX_URL = "http://127.0.0.1:8000"
GATEWAY_URL = "http://127.0.0.1:8787"
AGENT_SERVER_URL = "http://127.0.0.1:8789"
RELAY_URL = "http://127.0.0.1:8899"

# Eval-instance agent-server env (mirrors packages/agent-server/AGENTS.md).
AGENT_SERVER_ENV = {
    "PORT": "8789",
    "HOST": "0.0.0.0",
    "EXPERIENCE_STORE_PATH": "./var/eval/experience.db",
    "AGENT_SERVER_SESSION_DIR": "./var/eval/sessions",
    "GATEWAY_URL": GATEWAY_URL,
    "AGENT_GATEWAY_KEY": "lobster-local-key",
}


def _load_dotenv() -> dict[str, str]:
    env: dict[str, str] = {}
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def _probe(url: str, headers: dict[str, str] | None = None, timeout: float = 3.0) -> bool:
    """True if the service answers HTTP at all (any status, e.g. 401 = alive)."""
    try:
        req = urllib.request.Request(url, headers=headers or {})
        with urllib.request.urlopen(req, timeout=timeout):
            return True
    except urllib.error.HTTPError:
        return True
    except Exception:
        return False


def _nohup(argv: list[str], cwd: Path, env: dict[str, str], log: str) -> None:
    logf = open(log, "ab")
    subprocess.Popen(
        argv,
        cwd=cwd,
        env=env,
        stdout=logf,
        stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL,
        start_new_session=True,  # survive this process (nohup semantics)
    )


def _wait(name: str, probe, timeout_s: float = 90.0) -> bool:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if probe():
            return True
        time.sleep(2)
    print(f"preflight: {name} did not come up within {timeout_s:.0f}s", file=sys.stderr)
    return False


def ensure_omlx() -> None:
    if _probe(f"{OMLX_URL}/v1/models"):
        print("preflight: omlx :8000 OK")
        return
    # The oMLX app is user-managed (model loading is manual); we cannot start it.
    sys.exit("preflight FAIL: omlx :8000 unreachable — start the oMLX app and load the student model")


def ensure_gateway() -> None:
    probe = lambda: _probe(  # noqa: E731
        f"{GATEWAY_URL}/v1/models", headers={"Authorization": "Bearer lobster-local-key"}
    )
    if probe():
        print("preflight: agent-gateway :8787 OK")
        return
    dotenv = _load_dotenv()
    env = {**os.environ, **{k: v for k, v in dotenv.items() if k.startswith("DEEPSEEK_")}}
    if "DEEPSEEK_API_KEY" not in env:
        sys.exit(
            "preflight FAIL: agent-gateway :8787 down and no DEEPSEEK_API_KEY in "
            f"{ENV_FILE} — start it manually: cd packages/agent-gateway && "
            "DEEPSEEK_BASE_URL=... DEEPSEEK_API_KEY=... DEEPSEEK_MODEL=deepseek-v4-flash "
            "nohup uv run python -m agent_gateway &"
        )
    print("preflight: agent-gateway :8787 down, auto-starting (nohup, log /tmp/agent-gateway-8787.log)")
    _nohup(["uv", "run", "python", "-m", "agent_gateway"], GATEWAY_DIR, env, "/tmp/agent-gateway-8787.log")
    if not _wait("agent-gateway", probe):
        sys.exit("preflight FAIL: agent-gateway did not start — see /tmp/agent-gateway-8787.log")
    print("preflight: agent-gateway :8787 started")


def ensure_agent_server() -> None:
    probe = lambda: _probe(f"{AGENT_SERVER_URL}/stats")  # noqa: E731
    if probe():
        print("preflight: agent-server :8789 OK")
        return
    print("preflight: agent-server :8789 down, auto-starting (nohup, log /tmp/agent-server-8789.log)")
    _nohup(
        [str(REPO_ROOT / "scripts" / "with-node25.sh"), "npx", "tsx", "src/start.ts"],
        PKG_DIR,
        {**os.environ, **AGENT_SERVER_ENV},
        "/tmp/agent-server-8789.log",
    )
    if not _wait("agent-server", probe):
        sys.exit("preflight FAIL: agent-server did not start — see /tmp/agent-server-8789.log")
    print("preflight: agent-server :8789 started")


def ensure_relay() -> None:
    if _probe(f"{RELAY_URL}/v1/models"):
        print("preflight: deepseek relay :8899 OK")
        return
    dotenv = _load_dotenv()
    env = {**os.environ, **dotenv}
    print("preflight: deepseek relay :8899 down, auto-starting (nohup, log /tmp/deepseek-relay-8899.log)")
    _nohup(["node", "deepseek_relay.mjs"], EVAL_DIR, env, "/tmp/deepseek-relay-8899.log")
    if not _wait("deepseek relay", lambda: _probe(f"{RELAY_URL}/v1/models"), timeout_s=30):
        sys.exit("preflight FAIL: deepseek relay did not start — see /tmp/deepseek-relay-8899.log")
    print("preflight: deepseek relay :8899 started")


def ensure_for_base_url(base_url: str) -> None:
    """Probe/auto-start every local service the given endpoint depends on."""
    if ":8789" in base_url:
        ensure_omlx()
        ensure_gateway()
        ensure_agent_server()
    elif ":8787" in base_url:
        ensure_omlx()
        ensure_gateway()
    elif ":8899" in base_url:
        ensure_relay()
    elif ":8000" in base_url:
        ensure_omlx()
    else:
        print(f"preflight: {base_url} is external, no local deps")


if __name__ == "__main__":
    ensure_for_base_url(sys.argv[1] if len(sys.argv) > 1 else AGENT_SERVER_URL + "/v1")
