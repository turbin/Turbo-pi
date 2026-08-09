"""Preflight 指纹校验测试（M11，pytest，eval/.venv 运行）。

用本地线程 HTTP 服务伪造 /v1/models 与 /api/status/chain 端点，验证：
- omlx 空模型列表 / 非 JSON 响应必须 fail
- agent-server chain 指纹（gateway/omlx down、injection 不匹配）必须 fail
- 健康链必须通过
"""

import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import preflight  # noqa: E402

MODELS_OK = json.dumps({"data": [{"id": "qwen3.5-27b"}, {"id": "gemma-4-12b-it-4bit"}]}).encode()
CHAIN_OK = json.dumps(
    {"self": {"ok": True, "injection": True}, "gateway": {"ok": True}, "omlx": {"ok": True}}
).encode()


class FakeHandler(BaseHTTPRequestHandler):
    routes: dict = {}

    def do_GET(self):  # noqa: N802
        status, body = self.routes.get(self.path, (404, b"not found"))
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):  # noqa: ARG002
        pass


@pytest.fixture
def http_server():
    server = HTTPServer(("127.0.0.1", 0), FakeHandler)
    FakeHandler.routes = {}
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield server
    server.shutdown()
    thread.join()


@pytest.fixture
def omlx_url(http_server):
    return f"http://127.0.0.1:{http_server.server_port}"


def test_ensure_omlx_requires_loaded_models(omlx_url):
    FakeHandler.routes["/v1/models"] = (200, MODELS_OK)
    preflight.ensure_omlx(omlx_url)  # 不抛异常


def test_ensure_omlx_fails_on_empty_model_list(omlx_url):
    FakeHandler.routes["/v1/models"] = (200, json.dumps({"data": []}).encode())
    with pytest.raises(SystemExit, match="no loaded models"):
        preflight.ensure_omlx(omlx_url)


def test_ensure_omlx_fails_on_non_json_models(omlx_url):
    FakeHandler.routes["/v1/models"] = (200, b"<html>oops</html>")
    with pytest.raises(SystemExit, match="not a JSON model list"):
        preflight.ensure_omlx(omlx_url)


def test_ensure_omlx_fails_on_expected_model_mismatch(omlx_url, monkeypatch):
    FakeHandler.routes["/v1/models"] = (200, MODELS_OK)
    monkeypatch.setenv("AGENT_EVAL_EXPECTED_OMLX_MODEL", "some-other-model")
    with pytest.raises(SystemExit, match="AGENT_EVAL_EXPECTED_OMLX_MODEL"):
        preflight.ensure_omlx(omlx_url)


def test_ensure_agent_server_fails_when_chain_reports_gateway_down(omlx_url):
    FakeHandler.routes["/stats"] = (200, b"ok")
    FakeHandler.routes["/api/status/chain"] = (
        200,
        json.dumps({"self": {"ok": True}, "gateway": {"ok": False}, "omlx": {"ok": True}}).encode(),
    )
    with pytest.raises(SystemExit, match="gateway down"):
        preflight.ensure_agent_server(omlx_url, port=8789)


def test_ensure_agent_server_fails_on_injection_mismatch(omlx_url):
    FakeHandler.routes["/stats"] = (200, b"ok")
    FakeHandler.routes["/api/status/chain"] = (
        200,
        json.dumps({"self": {"ok": True, "injection": True}, "gateway": {"ok": True}, "omlx": {"ok": True}}).encode(),
    )
    with pytest.raises(SystemExit, match="AGENT_SERVER_INJECTION=on.*expects off|expects off"):
        preflight.ensure_agent_server(omlx_url, port=8790, injection=False)


def test_ensure_agent_server_accepts_matching_fingerprint(omlx_url):
    FakeHandler.routes["/stats"] = (200, b"ok")
    FakeHandler.routes["/api/status/chain"] = (200, CHAIN_OK)
    preflight.ensure_agent_server(omlx_url, port=8789, injection=True)  # 不抛异常


def test_ensure_agent_server_fails_when_chain_unreachable(omlx_url):
    FakeHandler.routes["/stats"] = (200, b"ok")
    # /api/status/chain 未注册 → 404 → 指纹不可验证 → fail
    with pytest.raises(SystemExit, match="fingerprint"):
        preflight.ensure_agent_server(omlx_url, port=8789)


def test_ensure_gateway_requires_model_list(omlx_url):
    FakeHandler.routes["/v1/models"] = (200, MODELS_OK)
    preflight.ensure_gateway(omlx_url)  # 不抛异常


def test_ensure_gateway_fails_on_non_json(omlx_url):
    FakeHandler.routes["/v1/models"] = (200, b"garbage")
    with pytest.raises(SystemExit, match="not a JSON model list"):
        preflight.ensure_gateway(omlx_url)
