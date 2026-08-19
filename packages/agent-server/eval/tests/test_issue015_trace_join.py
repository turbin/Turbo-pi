"""issue-015 回归：run_agent 对账键必须取 marker.trace_id 而非 body id。

M1/F0（issue-013 修复）后 agent-server 把响应 body id 覆写为自己的请求 id
（UUID 带横线），run.jsonl.trace_ids 与 gateway model_runs 的 join 静默断裂
（9B pilot 暴露：finish_reason 分布查询全空）。修复：body x_gateway 内嵌
标记（issue-004）优先，header 标记回落，body id 最后回落。
"""

import json
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import campaign  # noqa: E402

GATEWAY_TID = "chatcmpl-37c8ace29409430e8451f9fb19c1ee2c"
AGENT_SERVER_ID = "chatcmpl-7f3f036a-e5cd-447f-90f7-612696fa29c8"


def test_body_marker_preferred_for_trace_id():
    resp = SimpleNamespace(
        id=AGENT_SERVER_ID,
        x_gateway={"escalated": False, "reason": None, "provider": "omlx", "trace_id": GATEWAY_TID},
    )
    assert campaign._response_trace_id(resp) == GATEWAY_TID


def test_body_marker_escalated_read():
    resp = SimpleNamespace(
        id=AGENT_SERVER_ID,
        x_gateway={"escalated": True, "reason": "finish_reason_length", "provider": "deepseek", "trace_id": GATEWAY_TID},
    )
    assert campaign._response_marker(resp)["escalated"] is True


def test_header_marker_fallback():
    resp = SimpleNamespace(id=AGENT_SERVER_ID, headers={"x-gateway": json.dumps({"trace_id": GATEWAY_TID, "escalated": True})})
    assert campaign._response_trace_id(resp) == GATEWAY_TID
    assert campaign._response_marker(resp)["escalated"] is True


def test_body_id_last_resort():
    resp = SimpleNamespace(id=AGENT_SERVER_ID)
    assert campaign._response_trace_id(resp) == AGENT_SERVER_ID


def test_no_marker_no_id_returns_empty():
    assert campaign._response_trace_id(SimpleNamespace()) == ""
