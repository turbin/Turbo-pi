"""D7 实例交叉 harness（修订③ 方案 A，2026-08-23 用户批准）回归测试。

预注册口径（doc/design/2026-08-23-d2-adversarial-review-and-amendments.md §4）：
- --frozen-base-url 支持逗号分隔双 URL（a=第一 URL、b=第二 URL）；单 URL
  模式行为完全不变（向后兼容）；
- 冻结臂（X1/X4）任务实例分配 = sha256(f"{run_id}-d{day}-{task_id}-frozen-instance")
  奇偶对半（确定性，同 run-id 重跑一致；20 任务 10/10 或 ±1）；
- run.jsonl 行 frozen 臂带 frozen_instance 字段（a/b），非 frozen 臂行无该字段；
- task_observation 的 lf_meta 同带该维度；
- dry-run 输出冻结臂任务的实例分配；
- campaign_cross 差分核算不受 frozen_instance 影响（实例维度在 D7 报告中
  另行分层，metrics_v2 暂不改）。

运行：cd packages/agent-server/eval && .venv/bin/python -m pytest tests/test_campaign_frozen_instances.py -q
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

EVAL_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(EVAL_DIR))

import campaign  # noqa: E402
from campaign_cross import ARM_LIBRARY  # noqa: E402

CROSS_ARMS = ("x1", "x2", "x3", "x4")
FROZEN_A = "http://127.0.0.1:8790/v1"
FROZEN_B = "http://127.0.0.1:8791/v1"
DUAL_BASES = f"{FROZEN_A},{FROZEN_B}"


class FakeOpenAI:
    """捕获 base_url 的假 OpenAI 客户端（run_agent 被 monkeypatch，不真正调用）。"""

    def __init__(self, base_url: str, **kwargs):
        self.base_url = base_url


def _run_cross_main(tmp_path, monkeypatch, frozen_base_url: str, run_id: str,
                    n_repeat: int = 20, *, dry_run: bool = False, capture_meta: bool = False) -> dict:
    """驱动 campaign.main() 跑 --arms 回路，返回逐臂调用记录（及可选 lf_meta 捕获）。"""
    task_ids = [f"task_{i:04d}_frz" for i in range(n_repeat)]
    calls: list[dict] = []
    metas: list[dict] = []

    def fake_run_agent(client, model, prompt, ws, timeout_s, *, injection, task_id, domain):
        arm = Path(ws).parts[-1]  # workspace 路径末段 = 臂名（out_dir/day<d>/<arm>）
        calls.append({"arm": arm, "injection": injection, "client": client, "task_id": task_id})
        return {"transcript": [{"role": "assistant", "content": "ok"}],
                "escalated": False, "trace_ids": ["chatcmpl-fake"], "requests": 1,
                "termination_reason": "completed"}

    monkeypatch.setattr(campaign, "load_tasks", lambda: [SimpleNamespace(id=t, timeout_seconds=60) for t in task_ids])
    monkeypatch.setattr(campaign, "daily_batch", lambda tasks, day: {"repeat": task_ids, "new": []})
    monkeypatch.setattr(campaign, "held_out_tasks", lambda tasks: [])
    monkeypatch.setattr(campaign, "setup_workspace", lambda task_id, base: str(base))
    monkeypatch.setattr(campaign, "run_agent", fake_run_agent)
    monkeypatch.setattr(campaign, "safe_grade", lambda task_id, execution, ws: {"score": 0.5})
    monkeypatch.setattr(campaign, "ensure_for_base_url", lambda base: None)
    monkeypatch.setattr(campaign, "task_prompt", lambda task_id: f"do {task_id}")
    monkeypatch.setattr(campaign, "completed_keys", lambda path: set())
    monkeypatch.setattr(campaign, "OpenAI", FakeOpenAI)
    monkeypatch.setattr(campaign, "EVAL_DIR", tmp_path)
    if capture_meta:
        def fake_obs(lf, *, seed, name, metadata):
            metas.append(dict(metadata))
            return contextlib.nullcontext(campaign._NullObservation())

        monkeypatch.setattr(campaign, "task_observation", fake_obs)
    argv = ["campaign.py", "--day", "7", "--arms", "x1,x2,x3,x4",
            "--frozen-base-url", frozen_base_url, "--run-id", run_id]
    if dry_run:
        argv.append("--dry-run")
    monkeypatch.setattr(sys, "argv", argv)

    campaign.main()
    return {"calls": calls, "metas": metas}


def _load_rows(tmp_path, run_id: str) -> list[dict]:
    path = tmp_path / "results" / run_id / "run.jsonl"
    return [json.loads(l) for l in path.read_text().splitlines() if l.strip()]


# ── 分配函数：确定性 / 预注册键 / 对半平衡 ────────────────────────────────


def test_frozen_instance_assignment_deterministic():
    """同 run-id 重跑分配一致（确定性，断点续跑同实例）；输出限 a/b。"""
    a1 = campaign.frozen_instance_for("run-x", 7, "task_0001_frz")
    assert a1 == campaign.frozen_instance_for("run-x", 7, "task_0001_frz")
    assert a1 in ("a", "b")


def test_frozen_instance_key_is_pre_registered(monkeypatch):
    """预注册分配键 = sha256(f"{run_id}-d{day}-{task_id}-frozen-instance")。"""
    seen: list[bytes] = []
    real_sha256 = hashlib.sha256

    def spy(b: bytes = b"", *a, **k):
        seen.append(b)
        return real_sha256(b, *a, **k)

    monkeypatch.setattr(campaign.hashlib, "sha256", spy)
    campaign.frozen_instance_for("run-k", 3, "task_00007")
    assert f"run-k-d3-task_00007-frozen-instance".encode() in seen


def test_frozen_instance_balance_20_tasks():
    """20 任务对半（10/10 或 ±1）——实例效应在两实例间均衡抵消（pin run-2：
    恰 10/10，确定性验证不靠运气）。"""
    counts = {"a": 0, "b": 0}
    for i in range(20):
        counts[campaign.frozen_instance_for("run-2", 7, f"task_{i:04d}_frz")] += 1
    assert counts == {"a": 10, "b": 10}


# ── 单 URL 模式：行为完全不变（向后兼容） ─────────────────────────────────


def test_single_url_all_frozen_tasks_use_single_client(tmp_path, monkeypatch):
    """单 URL：全部冻结臂任务走唯一实例，当日臂走 AGENT_SERVER（旧口径不变）。"""
    res = _run_cross_main(tmp_path, monkeypatch, FROZEN_A, run_id="single-inst")
    for c in res["calls"]:
        expected = FROZEN_A if ARM_LIBRARY[c["arm"]] == "frozen" else campaign.AGENT_SERVER
        assert c["client"].base_url == expected, f"臂 {c['arm']} 应走 {expected}"


def test_single_url_rows_frozen_instance_constant_a(tmp_path, monkeypatch):
    """单 URL 落库：frozen 臂行 frozen_instance 恒 "a"（唯一实例）；非 frozen
    臂行无该字段。"""
    _run_cross_main(tmp_path, monkeypatch, FROZEN_A, run_id="single-inst")
    rows = _load_rows(tmp_path, "single-inst")
    assert len(rows) == 80
    for r in rows:
        if r["arm"] in ("x1", "x4"):
            assert r["frozen_instance"] == "a", f"单 URL 冻结臂行应恒 a: {r['arm']}"
        else:
            assert "frozen_instance" not in r, f"非 frozen 臂行不得有 frozen_instance: {r['arm']}"


# ── 双 URL 模式：对半分配 / 字段落库 / client 接线 ────────────────────────


def test_dual_url_frozen_calls_split_balanced_between_clients(tmp_path, monkeypatch):
    """双 URL：冻结臂 40 次调用（x1+x4 × 20 任务）在两实例间对半（±2 =
    任务级 ±1 的两臂镜像）。pin run-2：任务级恰 10/10，调用级 20/20。"""
    res = _run_cross_main(tmp_path, monkeypatch, DUAL_BASES, run_id="run-2")
    by_base: dict[str, int] = {}
    for c in res["calls"]:
        if ARM_LIBRARY[c["arm"]] == "frozen":
            by_base[c["client"].base_url] = by_base.get(c["client"].base_url, 0) + 1
    assert set(by_base) == {FROZEN_A, FROZEN_B}
    assert abs(by_base[FROZEN_A] - by_base[FROZEN_B]) <= 2


def test_dual_url_rows_carry_frozen_instance_matching_client(tmp_path, monkeypatch):
    """双 URL 落库：frozen 行 frozen_instance ∈ {a,b} 且与所用 client 的
    base URL 一一对应（a=第一 URL、b=第二 URL）；非 frozen 行无该字段。"""
    res = _run_cross_main(tmp_path, monkeypatch, DUAL_BASES, run_id="dual-rows")
    rows = _load_rows(tmp_path, "dual-rows")
    client_for = {f"{c['arm']}:{c['task_id']}": c["client"].base_url for c in res["calls"]}
    for r in rows:
        key = f"{r['arm']}:{r['task_id']}"
        if r["arm"] in ("x1", "x4"):
            assert r["frozen_instance"] in ("a", "b")
            expected = FROZEN_A if r["frozen_instance"] == "a" else FROZEN_B
            assert client_for[key] == expected, f"{key} 实例标签与 client 接线不符"
        else:
            assert "frozen_instance" not in r


def test_dual_url_same_task_same_instance_across_frozen_arms(tmp_path, monkeypatch):
    """同任务在 x1/x4 两冻结臂分配同一实例——冻结-current 对比中实例效应
    完全抵消（每臂各含两实例的各半任务）。"""
    _run_cross_main(tmp_path, monkeypatch, DUAL_BASES, run_id="dual-consist")
    rows = _load_rows(tmp_path, "dual-consist")
    by_task: dict[str, set[str]] = {}
    for r in rows:
        if r["arm"] in ("x1", "x4"):
            by_task.setdefault(r["task_id"], set()).add(r["frozen_instance"])
    assert len(by_task) == 20
    assert all(len(v) == 1 for v in by_task.values())


def test_dual_url_lf_meta_carries_frozen_instance(tmp_path, monkeypatch):
    """task_observation 的 lf_meta 同带 frozen_instance 维度（frozen 臂），
    非 frozen 臂不带。"""
    res = _run_cross_main(tmp_path, monkeypatch, DUAL_BASES, run_id="dual-meta", capture_meta=True)
    rows = _load_rows(tmp_path, "dual-meta")
    meta_by = {f"{m['arm']}:{m['task_id']}": m for m in res["metas"]}
    assert len(meta_by) == 80
    for r in rows:
        meta = meta_by[f"{r['arm']}:{r['task_id']}"]
        if r["arm"] in ("x1", "x4"):
            assert meta["frozen_instance"] == r["frozen_instance"]
        else:
            assert "frozen_instance" not in meta


def test_dual_url_dry_run_shows_frozen_instance_assignment(tmp_path, monkeypatch, capsys):
    """dry-run 输出冻结臂任务的实例分配（每任务一行 frozen instance: a/b，与分配函数一致）。"""
    _run_cross_main(tmp_path, monkeypatch, DUAL_BASES, run_id="dual-dry", dry_run=True)
    out = capsys.readouterr().out
    per_task: dict[str, str] = {}
    cur_tid: str | None = None
    for raw in out.splitlines():
        l = raw.strip()
        if l.startswith("task_"):
            cur_tid = l.split(":", 1)[0]
        elif l.startswith("frozen instance: ") and cur_tid:
            inst = l.split(" ")[2]
            inner = l[l.index("(") + 1: l.index(")")]
            assert set(inner.split(", ")) == {"x1", "x4"}, f"冻结臂标注异常: {l}"
            per_task[cur_tid] = inst
    assert len(per_task) == 20, "每个冻结任务应有实例分配行"
    for i in range(20):
        tid = f"task_{i:04d}_frz"
        expected = campaign.frozen_instance_for("dual-dry", 7, tid)
        assert per_task[tid] == expected, f"{tid} dry-run 实例与分配函数不一致"
