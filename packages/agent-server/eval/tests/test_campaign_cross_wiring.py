"""T7 交叉臂 run loop 接线回归（判别性）。

campaign_cross.py 的差分纯函数已由 test_campaign_cross.py 覆盖；但
campaign.py --arms 模式的**实际跑批回路**（injection 开关按臂、冻结臂走
冻结实例、library 维度落库）没有被任何测试触达——dry-run 在回路之前返回，
--metrics 是独立路径。

本文件以 mocked 环境驱动 campaign.main() 真实执行 --arms 回路，断言：
1. 注入开关按臂接线（ARM_INJECTION：x1/x2 开、x3/x4 关）；
2. 冻结臂（x1/x4）走 --frozen-base-url 实例、当日臂（x2/x3）走 AGENT_SERVER；
3. 落库行带 library 维度且不崩溃（无未定义名引用）。

对当前实现：x1/x2 的注入断言红（injection=arm=="experiment" 对 x* 恒 False）、
冻结臂客户端断言红（client_frozen 从未使用）、row 写 NameError（library 未定义）。

运行：cd packages/agent-server/eval && .venv/bin/python -m pytest tests/test_campaign_cross_wiring.py -q
"""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

EVAL_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(EVAL_DIR))

import campaign  # noqa: E402
from campaign_cross import ARM_INJECTION, ARM_LIBRARY  # noqa: E402

CROSS_ARMS = ("x1", "x2", "x3", "x4")
FROZEN_BASE = "http://frozen-instance:8787"


class FakeOpenAI:
    """捕获 base_url 的假 OpenAI 客户端（run_agent 被 monkeypatch，不真正调用）。"""

    def __init__(self, base_url: str, **kwargs):
        self.base_url = base_url


def _run_cross_main(tmp_path, monkeypatch) -> list[dict]:
    """驱动 campaign.main() 跑 --arms 回路，返回逐臂调用记录。"""
    task_ids = [f"task_0000{i}_review_x" for i in range(1, 3)]
    calls: list[dict] = []

    def fake_run_agent(client, model, prompt, ws, timeout_s, *, injection, task_id, domain, arm="", condition=""):
        arm = Path(ws).parts[-1]  # workspace 路径末段 = 臂名（out_dir/day<d>/<arm>）
        calls.append({"arm": arm, "injection": injection, "client": client, "task_id": task_id})
        return {
            "transcript": [{"role": "assistant", "content": "ok"}],
            "escalated": False,
            "trace_ids": ["chatcmpl-fake"],
            "canonical_request_hashes": ["hash-fake"],
            "requests": 1,
            "termination_reason": "completed",
            "condition": "test",
        }

    monkeypatch.setattr(campaign, "load_tasks", lambda: [SimpleNamespace(id=t, timeout_seconds=60) for t in task_ids])
    monkeypatch.setattr(campaign, "daily_batch", lambda tasks, day: {"repeat": task_ids, "new": []})
    # T1/T2：--arms 模式 now 调用 held_out_tasks（SimpleNamespace 任务无
    # category 属性，split_tasks 会炸）——本文件只测注入/冻结臂接线，held 置空。
    monkeypatch.setattr(campaign, "held_out_tasks", lambda tasks: [])
    monkeypatch.setattr(campaign, "setup_workspace", lambda task_id, base: str(base))
    monkeypatch.setattr(campaign, "run_agent", fake_run_agent)
    monkeypatch.setattr(campaign, "safe_grade", lambda task_id, execution, ws: {"score": 0.5})
    monkeypatch.setattr(campaign, "ensure_for_base_url", lambda base: None)
    monkeypatch.setattr(campaign, "task_prompt", lambda task_id: f"do {task_id}")
    monkeypatch.setattr(campaign, "completed_keys", lambda path: set())
    monkeypatch.setattr(campaign, "OpenAI", FakeOpenAI)
    monkeypatch.setattr(campaign, "EVAL_DIR", tmp_path)
    monkeypatch.setattr(sys, "argv",
                        ["campaign.py", "--day", "3", "--arms", ",".join(CROSS_ARMS),
                         "--frozen-base-url", FROZEN_BASE, "--run-id", "review-cross-wiring"])

    try:
        campaign.main()
    except NameError as e:  # 当前实现：row 写 library 未定义 → NameError
        pytest.fail(f"交叉臂回路崩溃（未定义名）: {e}")
    assert len(calls) == len(CROSS_ARMS) * 2, f"每臂应跑 2 任务，实际 {len(calls)} 次调用"
    return calls


def test_cross_arm_run_wires_injection_per_arm(tmp_path, monkeypatch):
    """注入开关必须按臂接线（2×2 设计的注入维度）：x1/x2 开、x3/x4 关。"""
    calls = _run_cross_main(tmp_path, monkeypatch)
    by_arm = {c["arm"]: c["injection"] for c in calls}
    assert by_arm == ARM_INJECTION, f"注入开关未按臂接线: {by_arm}"


def test_cross_arm_run_uses_frozen_client_for_frozen_arms(tmp_path, monkeypatch):
    """冻结臂（x1/x4）必须走 --frozen-base-url 实例、当日臂（x2/x3）走 AGENT_SERVER。"""
    calls = _run_cross_main(tmp_path, monkeypatch)
    for c in calls:
        expected = FROZEN_BASE if ARM_LIBRARY[c["arm"]] == "frozen" else campaign.AGENT_SERVER
        assert c["client"].base_url == expected, (
            f"臂 {c['arm']} 应走 {expected}，实际 {c['client'].base_url}（冻结臂锁库未接线）"
        )


def test_cross_arm_run_writes_library_dimension(tmp_path, monkeypatch):
    """落库行必须带 library 维度（frozen|daily）且按臂正确。"""
    calls = _run_cross_main(tmp_path, monkeypatch)
    rows = [r for r in (tmp_path / "results" / "review-cross-wiring" / "run.jsonl").read_text().splitlines()]
    assert len(rows) == len(CROSS_ARMS) * 2
    parsed = [__import__("json").loads(line) for line in rows]
    for row in parsed:
        assert row.get("library") == ARM_LIBRARY[row["arm"]], f"library 维度缺失或错误: {row['arm']}"
