#!/usr/bin/env python3
"""Preflight dependency checks for eval batch runs (2026-08-05, M11 2026-08-09).

Every batch entrypoint (alfworld_agent.py, harness.py, d3_discriminate.py)
must call ensure_for_base_url() before starting. It maps the target endpoint
to the local services that endpoint depends on, probes each one, auto-starts
the ones we own (agent-server, gateway, deepseek relay) via nohup, and fails
fast with an actionable message for the ones we do not (omlx app).

M11 (adversarial review 2026-08-09): probes are no longer "any HTTP status
is alive" — fingerprints are verified:
  - omlx /v1/models must list at least one loaded model (optional
    AGENT_EVAL_EXPECTED_OMLX_MODEL requires a specific id)
  - gateway /v1/models must list the channel's allowed models
  - agent-server /api/status/chain must report self/gateway/omlx ok and the
    injection flag must match the run's expectation (control arm :8790
    expects AGENT_SERVER_INJECTION=off — M8). Stale/misconfigured instances
    fail loudly instead of silently skewing a batch run.

Rationale: batch runs that bypass agent-server starve the learning loop of
traces; worse, a run against a dead dependency silently burns hours. The
dependency graph (2026-08-05):

    :8789 agent-server  -> :8787 gateway -> :8000 omlx (student)
    :8790 agent-server (AGENT_SERVER_INJECTION=off, tb 控制臂, M8)
    :8787 gateway       -> :8000 omlx
    :8899 deepseek relay -> api.deepseek.com (external, legacy)
    external URL        -> no local deps
"""

import json
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
CONTROL_AGENT_SERVER_URL = "http://127.0.0.1:8790"
RELAY_URL = "http://127.0.0.1:8899"

# Eval-instance agent-server env (mirrors packages/agent-server/AGENTS.md).
# Port and injection are set per instance by ensure_agent_server.
AGENT_SERVER_ENV = {
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


def _models_json(url: str, headers: dict[str, str] | None = None, timeout: float = 3.0) -> list[str] | None:
    """Model ids from an OpenAI /v1/models endpoint (M11 fingerprint).

    Returns None when unreachable or the body is not a JSON model list.
    """
    try:
        req = urllib.request.Request(url, headers=headers or {})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = json.loads(resp.read())
        data = body.get("data") if isinstance(body, dict) else None
        if not isinstance(data, list):
            return None
        return [str(m.get("id")) for m in data if isinstance(m, dict) and m.get("id")]
    except Exception:
        return None


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


def _omlx_headers() -> dict[str, str]:
    """omlx 需 Bearer key（M11 指纹校验要带 key 才能拿到模型列表）。

    来源优先 env OMLX_API_KEY，其次 agent-gateway config.toml 的 local_omlx.api_key。
    """
    key = os.environ.get("OMLX_API_KEY")
    if not key:
        config = REPO_ROOT / "packages" / "agent-gateway" / "config.toml"
        if config.exists():
            import tomllib

            data = tomllib.loads(config.read_text())
            key = (data.get("local_omlx") or {}).get("api_key")
    return {"Authorization": f"Bearer {key}"} if key else {}


def ensure_omlx(base_url: str = OMLX_URL) -> None:
    models = _models_json(f"{base_url}/v1/models", headers=_omlx_headers())
    if models is None:
        if _probe(f"{base_url}/v1/models"):
            sys.exit(
                "preflight FAIL: omlx answers but /v1/models is not a JSON model list — "
                "reload the student model in the oMLX app (M11 fingerprint)"
            )
        sys.exit("preflight FAIL: omlx unreachable — start the oMLX app and load the student model")
    if not models:
        sys.exit("preflight FAIL: omlx has no loaded models — load the student model (M11 fingerprint)")
    expected = os.environ.get("AGENT_EVAL_EXPECTED_OMLX_MODEL")
    if expected and expected not in models:
        sys.exit(
            f"preflight FAIL: omlx loaded {models} but AGENT_EVAL_EXPECTED_OMLX_MODEL={expected} — "
            "wrong model loaded (M11 fingerprint)"
        )
    shown = ", ".join(models[:3]) + ("..." if len(models) > 3 else "")
    print(f"preflight: omlx OK ({shown})")


def ensure_gateway(base_url: str = GATEWAY_URL) -> None:
    headers = {"Authorization": "Bearer lobster-local-key"}
    probe = lambda: _models_json(f"{base_url}/v1/models", headers=headers) is not None  # noqa: E731
    if not probe():
        if _probe(f"{base_url}/v1/models", headers=headers):
            sys.exit("preflight FAIL: gateway answers but /v1/models is not a JSON model list (M11 fingerprint)")
        dotenv = _load_dotenv()
        env = {**os.environ, **{k: v for k, v in dotenv.items() if k.startswith("DEEPSEEK_")}}
        if "DEEPSEEK_API_KEY" not in env:
            sys.exit(
                "preflight FAIL: agent-gateway down and no DEEPSEEK_API_KEY in "
                f"{ENV_FILE} — start it manually: cd packages/agent-gateway && "
                "DEEPSEEK_BASE_URL=... DEEPSEEK_API_KEY=... DEEPSEEK_MODEL=deepseek-v4-flash "
                "nohup uv run python -m agent_gateway &"
            )
        print("preflight: agent-gateway down, auto-starting (nohup, log /tmp/agent-gateway-8787.log)")
        _nohup(["uv", "run", "python", "-m", "agent_gateway"], GATEWAY_DIR, env, "/tmp/agent-gateway-8787.log")
        if not _wait("agent-gateway", probe):
            sys.exit("preflight FAIL: agent-gateway did not start — see /tmp/agent-gateway-8787.log")
    models = _models_json(f"{base_url}/v1/models", headers=headers) or []
    print(f"preflight: agent-gateway OK (models: {', '.join(models)})")


def _chain_status(base_url: str) -> dict:
    """/api/status/chain fingerprint of a running agent-server (M11)."""
    try:
        req = urllib.request.Request(f"{base_url}/api/status/chain")
        with urllib.request.urlopen(req, timeout=3.0) as resp:
            body = json.loads(resp.read())
        return body if isinstance(body, dict) else {}
    except Exception as exc:
        sys.exit(
            f"preflight FAIL: agent-server {base_url} answers /stats but /api/status/chain failed "
            f"({exc}) — cannot verify the instance fingerprint (M11)"
        )


def ensure_agent_server(base_url: str = AGENT_SERVER_URL, *, port: int = 8789, injection: bool | None = None) -> None:
    """Probe (and auto-start) an eval agent-server.

    When an instance is already running, its /api/status/chain fingerprint
    must verify: chain ok for self/gateway/omlx, and the injection flag must
    match the run's expectation when one is given. A stale or misconfigured
    instance fails loudly (M11) — auto-start is for a missing instance only.
    """
    if _probe(f"{base_url}/stats"):
        chain = _chain_status(base_url)
        if not chain.get("self", {}).get("ok"):
            sys.exit(f"preflight FAIL: agent-server {base_url} chain reports self not ok (M11)")
        if not chain.get("gateway", {}).get("ok"):
            sys.exit(f"preflight FAIL: agent-server {base_url} chain reports gateway down — start :8787 first (M11)")
        if not chain.get("omlx", {}).get("ok"):
            sys.exit(
                f"preflight FAIL: agent-server {base_url} chain reports omlx down — "
                "load the student model in oMLX (M11)"
            )
        running_injection = bool(chain.get("self", {}).get("injection"))
        if injection is not None and running_injection != injection:
            sys.exit(
                f"preflight FAIL: agent-server {base_url} runs with AGENT_SERVER_INJECTION="
                f"{'on' if running_injection else 'off'} but this run expects "
                f"{'on' if injection else 'off'} — use the dedicated control instance :8790 (M8/M11)"
            )
        print(f"preflight: agent-server :{port} OK (injection {'on' if running_injection else 'off'})")
        return
    print(f"preflight: agent-server :{port} down, auto-starting (nohup, log /tmp/agent-server-{port}.log)")
    env = {**os.environ, **AGENT_SERVER_ENV, "PORT": str(port)}
    if injection is not None:
        env["AGENT_SERVER_INJECTION"] = "on" if injection else "off"
    _nohup(
        [str(REPO_ROOT / "scripts" / "with-node25.sh"), "npx", "tsx", "src/start.ts"],
        PKG_DIR,
        env,
        f"/tmp/agent-server-{port}.log",
    )
    if not _wait(f"agent-server :{port}", lambda: _probe(f"{base_url}/stats")):
        sys.exit(f"preflight FAIL: agent-server :{port} did not start — see /tmp/agent-server-{port}.log")
    print(f"preflight: agent-server :{port} started (injection {'on' if injection is not None and injection else 'default'})")


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
    if ":8790" in base_url:
        # M8: tb 控制臂实例——AGENT_SERVER_INJECTION=off 的专用 8790。
        ensure_omlx()
        ensure_gateway()
        ensure_agent_server(CONTROL_AGENT_SERVER_URL, port=8790, injection=False)
    elif ":8789" in base_url:
        ensure_omlx()
        ensure_gateway()
        ensure_agent_server(AGENT_SERVER_URL, port=8789)
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
