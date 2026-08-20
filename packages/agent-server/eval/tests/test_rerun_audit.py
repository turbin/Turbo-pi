"""rerun_audit.py 测试（T9，评审 §十五：重复运行稳定性审计）。

预注册口径（见 rerun_audit.py docstring）：
  任务选取（5 个典型，键 sha256("rerun-audit")）：最高分 / ExhaustedFailure /
    改善最大 / 退化最大 / 中位；各类候选排序后轮流取（去重后补足），确定性
  每任务 ×3 重复（8789 injection=on，复用 campaign.run_agent 回路）
  RunToRunVariance = 每任务 score 极差（max−min）+ 样本标准差（statistics.stdev，
    n<2 时记 0.0）
"""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import rerun_audit as ra  # noqa: E402


def _row(day, task_id, arm="experiment", score=0.5, term=None, requests=5):
    r = {"day": day, "task_id": task_id, "arm": arm, "score": score, "requests": requests}
    if term is not None:
        r["termination_reason"] = term
    return r


# ── 任务选取 ──


def _typical_rows():
    """构造五类典型任务齐全的 run.jsonl 行。"""
    rows = []
    # best：最高分任务（所有行最高分）
    rows += [_row(d, "t_best", score=0.95) for d in range(1, 8)]
    # exhausted：触顶∧失败任务
    rows += [_row(1, "t_exh", score=0.2, term="max_turns"), _row(7, "t_exh", score=0.3, term="max_turns")]
    # improved：D1→D7 大幅改善
    rows += [_row(1, "t_imp", score=0.1), _row(7, "t_imp", score=0.8)]
    # regressed：D1→D7 大幅退化
    rows += [_row(1, "t_reg", score=0.8), _row(7, "t_reg", score=0.1)]
    # median：中位任务（代表分 0.85，最接近全体代表分中位数 0.8）
    for d in range(1, 8):
        rows.append(_row(d, "t_med", score=0.85))
    # 干扰任务（远离中位，避免占位）
    rows += [_row(1, "t_noise1", score=0.9), _row(1, "t_noise2", score=0.1)]
    return rows


def test_selection_uses_d7_x2_delta_on_four_arm_main_batch():
    # 修复后（打回项）：delta 配对与任务书§1.4/campaign_cross 对齐——D1 实验臂行 →
    # D7 实验等效臂行（四臂日取 x2）；改善/退化两类在主批形态（D1 双臂 + D7 四臂）
    # 下可选。两组仅 D1 实验臂分不同的数据选取应不同。
    def make(d1_score):
        rows = []
        for i in range(5):
            rows += [_row(1, f"t{i}", score=0.7), _row(1, f"t{i}", arm="control", score=0.7)]
            for arm in ("x1", "x2", "x3", "x4"):
                rows.append(_row(7, f"t{i}", arm=arm, score=0.7))
        rows += [_row(1, "t_imp", score=d1_score), _row(1, "t_imp", arm="control", score=d1_score)]
        for arm in ("x1", "x2", "x3", "x4"):
            rows.append(_row(7, "t_imp", arm=arm, score=0.5))
        return rows
    a = ra.select_audit_tasks(make(0.1), n=5)
    b = ra.select_audit_tasks(make(0.5), n=5)
    assert "t_imp" in a  # a：D1 0.1 → D7 x2 0.5 → delta +0.4 → 改善类入选
    assert "t_imp" not in b  # b：delta 0.0 → 不入选改善/退化类


def test_selection_notes_when_delta_unavailable():
    # 打回项：delta 无配对候选（分类不可区分）时输出 noted 标记。
    rows = []
    for i in range(6):
        rows += [_row(1, f"t_a{i}", score=0.9), _row(1, f"t_b{i}", score=0.3)]  # 无 D7 行
    selected, notes = ra.select_audit_tasks_with_notes(rows, n=5)
    assert len(selected) == 5
    assert any("delta" in n for n in notes)  # noted：delta 配对缺失


def test_selection_notes_when_single_sign_delta():
    # 只有改善（delta>0）任务时，退化类无候选 → noted 标记。
    rows = [
        _row(1, "t_imp", score=0.1),
        _row(7, "t_imp", score=0.8),  # delta +0.7
        _row(1, "t_flat", score=0.5),
        _row(7, "t_flat", score=0.5),  # delta 0.0
    ]
    selected, notes = ra.select_audit_tasks_with_notes(rows, n=5)
    assert "t_imp" in selected
    assert any("退化" in n for n in notes)


def test_selection_picks_five_typical():
    sel = ra.select_audit_tasks(_typical_rows(), n=5)
    assert len(sel) == 5
    assert "t_best" in sel
    assert "t_exh" in sel
    assert "t_imp" in sel
    assert "t_reg" in sel
    assert "t_med" in sel


def test_selection_deterministic():
    rows = _typical_rows()
    assert ra.select_audit_tasks(rows, n=5) == ra.select_audit_tasks(rows, n=5)


def test_selection_dedup_and_fill():
    # 只有 best/median 两类有候选（无触顶、无 D1→D7 配对）→ 去重后按确定性键补足
    rows = []
    for i in range(8):
        rows += [_row(1, f"t_a{i}", score=0.9), _row(1, f"t_b{i}", score=0.3)]
    sel = ra.select_audit_tasks(rows, n=5)
    assert len(sel) == 5
    assert "t_a0" in sel  # 最高分
    assert len(set(sel)) == 5
    # 补足候选确定性（同一输入两次一致）
    assert ra.select_audit_tasks(rows, n=5) == sel


def test_selection_key_preregistered():
    assert ra.SELECTION_KEY == "rerun-audit"


def test_selection_no_rows():
    assert ra.select_audit_tasks([], n=5) == []


# ── 方差公式 ──


def test_variance_formulas():
    v = ra.run_to_run_variance([1.0, 2.0, 3.0])
    assert v == {"n": 3, "mean": 2.0, "min": 1.0, "max": 3.0, "range": 2.0, "stddev": 1.0}


def test_variance_single_value():
    v = ra.run_to_run_variance([0.5])
    assert v["range"] == 0.0
    assert v["stddev"] == 0.0


def test_variance_empty():
    v = ra.run_to_run_variance([])
    assert v["n"] == 0
    assert v["stddev"] == 0.0


# ── 批量运行（stub run_agent） ──


def _execution():
    return {"status": "completed", "termination_reason": "completed", "transcript": [],
            "workspace": "/tmp/ws", "requests": 1, "trace_ids": [], "escalated": False}


def test_run_audit_stub(tmp_path):
    seq = {"t1": [0.6, 0.7, 0.8], "t2": [0.2, 0.2, 0.5]}

    def run_agent(client, model, prompt, ws, timeout_s, *, injection, task_id, domain):
        return _execution()

    def grade_seq(task_id, execution, ws):
        return {"task_id": task_id, "score": seq[task_id].pop(0), "grading_error": False}

    ctx = ra.RunContext(
        student_client="STUDENT",
        run_agent=run_agent,
        grade=grade_seq,
        setup_workspace=lambda task_id, workdir: Path(workdir) / task_id,
        task_prompt=lambda task_id: f"PROMPT:{task_id}",
        task_timeout=lambda task_id: 300,
    )
    out = tmp_path / "out"
    report = ra.run_audit(["t1", "t2"], ctx, out, repeats=3)
    assert report["per_task"]["t1"]["scores"] == [0.6, 0.7, 0.8]
    assert report["per_task"]["t1"]["variance"]["range"] == pytest.approx(0.2)
    assert report["per_task"]["t2"]["variance"]["stddev"] == pytest.approx(0.1732050807568879)
    assert report["summary"]["mean_range"] == pytest.approx(0.25)  # (0.2+0.3)/2
    assert (out / "audit.json").exists()
    # 无 transcripts 落盘（纯稳定性测量，不产生 evolution 输入）
    assert not (out / "transcripts").exists()


def test_run_audit_injection_on(tmp_path):
    seen = []

    def run_agent(client, model, prompt, ws, timeout_s, *, injection, task_id, domain):
        seen.append((injection, task_id))
        return _execution()

    def grade(task_id, execution, ws):
        return {"task_id": task_id, "score": 0.5, "grading_error": False}

    ctx = ra.RunContext(
        student_client="STUDENT",
        run_agent=run_agent,
        grade=grade,
        setup_workspace=lambda task_id, workdir: Path(workdir) / task_id,
        task_prompt=lambda task_id: "p",
        task_timeout=lambda task_id: 300,
    )
    ra.run_audit(["t1"], ctx, tmp_path / "out", repeats=3)
    assert all(inj is True for inj, _ in seen)
    assert len(seen) == 3
