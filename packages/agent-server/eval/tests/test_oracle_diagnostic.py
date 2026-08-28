"""oracle_diagnostic.py 测试（T8，评审 §一：Oracle Teacher Plan 诊断四条件）。

预注册口径（见 oracle_diagnostic.py docstring）：
  子集选取（D1 重复集，n=5，键 sha256("oracle-diag")）：
    ExhaustedFailure（触顶∧失败）优先 → hard 档（D1 score<0.3）补 → sha256 排序取
  条件 A=9B Alone（control 臂 / injection off）、B=9B+Retrieved Memory
    （experiment 臂 / injection on）——默认复用 run.jsonl 既有行，缺数据报错；
    --run-ab 新跑
  条件 D=Teacher Direct Solve（deepseek-v4-pro 中继）、C=9B+Oracle Teacher Plan
    （injection off + 包装 prompt 直接内嵌计划，绕开检索，评审 §一）
  指标：MemoryGain=B−A、RetrievalLoss=C−B、ExecutionGap=D−C、TeacherSolveRate、
    plan 蒸馏成功率（编号步骤，每步一句；蒸馏失败/格式不符 → C 跳过并计数）
  隔离：transcripts 写 results/oracle-diagnostic-*/ 独立目录，不进 campaign
    transcripts（评审 §十 与 preview.html §10 写入隔离精神）
"""

import json
import sys
import urllib.error
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import oracle_diagnostic as od  # noqa: E402


def _row(day, task_id, arm="experiment", score=0.5, term=None, requests=5, kind="repeat"):
    r = {"day": day, "task_id": task_id, "arm": arm, "score": score, "requests": requests, "kind": kind}
    if term is not None:
        r["termination_reason"] = term
    return r


def _execution(commands=("cat app.json",), term="completed"):
    events = []
    for cmd in commands:
        events.append(
            {"type": "message", "message": {"role": "assistant", "content": [
                {"type": "toolCall", "name": "bash", "arguments": {"command": cmd}}]}}
        )
        events.append({"type": "message", "message": {"role": "toolResult", "content": ["ok"]}})
    return {"status": "completed", "termination_reason": term, "transcript": events,
            "workspace": "/tmp/ws", "requests": len(commands), "trace_ids": [], "escalated": False}


def _grade(score):
    return {"task_id": "t", "score": score, "grading_type": "hybrid", "breakdown": {}, "grading_error": False}


def make_ctx(*, scores=None, distill_response=None, run_agent=None, grade=None):
    """stub ctx：run_agent/grade/client 全部 stub，不真实调 LLM。"""
    if run_agent is None:
        calls = []

        def run_agent(client, model, prompt, ws, timeout_s, *, injection, task_id, domain, arm="", condition=""):
            calls.append({"client": client, "model": model, "prompt": prompt, "injection": injection, "task_id": task_id})
            return _execution()

        run_agent.calls = calls  # type: ignore[attr-defined]
    if grade is None:
        def grade(task_id, execution, ws):
            # 按条件区分：C 条件的 ws 在 cond-C/ 下（stub 只认路径，不真实调 LLM）
            key = f"{task_id}:C" if "cond-C" in str(ws) else task_id
            return _grade(scores.get(key, scores.get(task_id, 0.5)))
    ctx = od.RunContext(
        student_client="STUDENT",
        teacher_client="TEACHER",
        run_agent=run_agent,
        grade=grade,
        setup_workspace=lambda task_id, workdir: Path(workdir) / task_id,
        task_prompt=lambda task_id: f"PROMPT:{task_id}",
        task_timeout=lambda task_id: 300,
        distill=lambda client, text: distill_response,
        teacher_model=od.TEACHER_MODEL,
        student_model="agent-auto",
    )
    return ctx


# ── 子集选取（三优先级） ──


def test_subset_priorities():
    rows = [
        _row(1, "t_exh1", score=0.2, term="max_turns"),
        _row(1, "t_exh2", score=0.4, term="max_turns"),
        _row(1, "t_hard", score=0.1, term="completed"),
        _row(1, "t_ok1", score=0.6),
        _row(1, "t_ok2", score=0.8),
    ]
    sel = od.deterministic_subset(rows, n=5)
    # 前两位 = ExhaustedFailure（sha256 序），第三位 = hard 档，其余按 sha256
    assert set(sel[:2]) == {"t_exh1", "t_exh2"}
    assert sel[2] == "t_hard"
    assert set(sel[3:]) == {"t_ok1", "t_ok2"}
    # 键预注册
    assert od.SELECTION_KEY == "oracle-diag"


def test_subset_priority_fill_insufficient_hard():
    rows = [_row(1, "t_exh1", score=0.2, term="max_turns"), _row(1, "t_ok1", score=0.6), _row(1, "t_ok2", score=0.7)]
    sel = od.deterministic_subset(rows, n=5)
    assert sel[0] == "t_exh1"
    assert len(sel) == 3
    assert set(sel[1:]) == {"t_ok1", "t_ok2"}


def test_subset_deterministic_and_n_cap():
    rows = [_row(1, f"t{i:02d}", score=0.3 + (i % 3) * 0.2) for i in range(10)]
    assert od.deterministic_subset(rows, n=5) == od.deterministic_subset(rows, n=5)
    assert len(od.deterministic_subset(rows, n=5)) == 5


def test_subset_filters_non_d1_and_control_and_new():
    rows = [
        _row(1, "t1", score=0.1, term="max_turns"),  # 计入
        _row(2, "t1", score=0.1, term="max_turns"),  # 非 D1 不计
        _row(1, "t2", score=0.1, term="max_turns", arm="control"),  # 对照臂不计
        _row(1, "t3", score=0.1, term="max_turns", kind="new"),  # 非重复集不计
    ]
    assert od.deterministic_subset(rows, n=5) == ["t1"]


def test_subset_old_rows_fallback_capped():
    # 旧行无 termination_reason：requests>=30 ∧ score<0.5 = ExhaustedFailure
    rows = [_row(1, "t_old", score=0.2, requests=30), _row(1, "t_ok", score=0.6)]
    sel = od.deterministic_subset(rows, n=5)
    assert sel[0] == "t_old"


# ── plan 蒸馏解析 ──


def test_parse_distilled_plan_valid():
    text = "1. inspect the workspace\n2. patch the config file\n3. rerun the check"
    assert od.parse_distilled_plan(text) == ["inspect the workspace", "patch the config file", "rerun the check"]


def test_parse_distilled_plan_no_numbers():
    assert od.parse_distilled_plan("no numbered steps here at all") is None


def test_parse_distilled_plan_not_starting_at_one():
    assert od.parse_distilled_plan("2. second step\n3. third step") is None


def test_parse_distilled_plan_step_too_short():
    assert od.parse_distilled_plan("1. x\n2. this is a fine step") is None


# ── 四条件汇总公式 ──


def test_summary_formulas():
    per_task = {
        "t1": {"A": 0.3, "B": 0.5, "C": 0.6, "D": 0.9, "distilled": True},
        "t2": {"A": 0.2, "B": 0.25, "C": None, "D": 0.4, "distilled": False},
    }
    s = od.compute_summary(per_task)
    assert s["memory_gain"]["value"] == pytest.approx(0.125)  # (0.2+0.05)/2
    assert s["retrieval_loss"]["value"] == pytest.approx(0.1)  # 仅 t1 有 C
    assert s["execution_gap"]["value"] == pytest.approx(0.3)
    assert s["teacher_solve_rate"] == 0.5
    assert s["distillation"]["candidates_n"] == 1  # 仅 D>=0.5 的任务
    assert s["distillation"]["success_n"] == 1
    assert s["distillation"]["success_rate"] == 1.0


def test_summary_empty():
    s = od.compute_summary({})
    assert s["memory_gain"]["value"] == 0.0
    assert s["teacher_solve_rate"] == 0.0


# ── 批量运行（stub run_agent） ──


def test_runner_ab_missing_raises(tmp_path):
    rows = [_row(1, "t1", score=0.2, term="max_turns")]  # 无 control 行
    ctx = make_ctx(scores={"t1": 0.9})
    with pytest.raises(RuntimeError, match="--run-ab"):
        od.run_diagnostic_batch(["t1"], rows, ctx, tmp_path / "out")


def test_ab_reuse_first_row_per_arm_in_file_order():
    # 复用口径：每臂文件序首行（不做日过滤）。重复集任务 D1 双臂同行时 A/B 均为
    # D1 行；若任务首个 experiment 行不在 D1（如部分完成批次），A/B 会跨日混配——
    # 观察项（真实主批形态下重复集任务 D1 必含两臂，不触发）。
    rows = [
        _row(3, "t1", arm="experiment", score=0.4),  # 首个 experiment 行（day3）
        _row(1, "t1", arm="control", score=0.7),     # 首个 control 行（day1）
        _row(7, "t1", arm="control", score=0.1),
    ]
    per_task, missing = od.ab_scores_from_rows(rows, ["t1"])
    assert missing == []
    assert per_task["t1"] == {"A": 0.7, "B": 0.4}  # 文件序首行（跨日混配形态被钉住）


def test_ab_reuse_four_arm_rows_use_x2_x3_equivalents():
    # 修复后（打回项）：四臂主批行按 campaign_cross 口径复用——
    # B=experiment/x2（实验等效），A=control/x3（对照等效）；x1/x4 冻结臂不参与。
    rows = [
        _row(7, "t1", arm="x2", score=0.5),
        _row(7, "t1", arm="x3", score=0.7),
        _row(7, "t2", arm="x1", score=0.9),  # 冻结臂不认作 B
        _row(7, "t2", arm="x4", score=0.4),  # 冻结臂不认作 A
    ]
    per_task, missing = od.ab_scores_from_rows(rows, ["t1", "t2"])
    assert per_task["t1"] == {"A": 0.7, "B": 0.5}
    assert per_task["t2"] == {"A": None, "B": None}
    assert missing == ["t2"]  # 冻结臂无等效行 → t2 缺 A/B


def test_ab_reuse_mixed_two_arm_and_four_arm():
    # 双臂行与四臂等效行混在时：A/B 取各自臂集合的文件序首行。
    rows = [
        _row(1, "t1", arm="experiment", score=0.4),  # B（experiment 首行）
        _row(7, "t1", arm="x3", score=0.6),          # A（x3 首行，早于 control）
        _row(7, "t1", arm="control", score=0.2),
    ]
    per_task, missing = od.ab_scores_from_rows(rows, ["t1"])
    assert per_task["t1"] == {"A": 0.6, "B": 0.4}
    assert missing == []


def test_runner_full_flow_stubbed(tmp_path):
    rows = [
        _row(1, "t1", arm="experiment", score=0.4),
        _row(1, "t1", arm="control", score=0.3),
    ]
    ctx = make_ctx(scores={"t1": 0.9, "t1:C": 0.6}, distill_response="1. step one here\n2. step two here")
    out = tmp_path / "out"
    report = od.run_diagnostic_batch(["t1"], rows, ctx, out)
    # 条件 C 的 prompt 必须带包装模板 + 蒸馏步骤（绕开检索直接给计划）
    c_call = [c for c in ctx.run_agent.calls if c["prompt"].startswith("以下是教师为此类任务验证过的正确计划")]
    assert len(c_call) == 1
    assert "1. step one here" in c_call[0]["prompt"]
    assert "PROMPT:t1" in c_call[0]["prompt"]
    assert c_call[0]["injection"] is False
    assert c_call[0]["client"] == "STUDENT"
    # 条件 D 用教师 client，注入关
    d_call = [c for c in ctx.run_agent.calls if c["prompt"] == "PROMPT:t1"]
    assert d_call and d_call[0]["client"] == "TEACHER"
    assert d_call[0]["injection"] is False
    # 条件 A/B 复用既有行，不重跑
    assert len(ctx.run_agent.calls) == 2  # D + C
    # 指标
    assert report["per_task"]["t1"]["A"] == 0.3
    assert report["per_task"]["t1"]["B"] == 0.4
    assert report["per_task"]["t1"]["C"] == 0.6
    assert report["per_task"]["t1"]["D"] == 0.9
    assert report["summary"]["memory_gain"]["value"] == pytest.approx(0.1)
    assert report["summary"]["execution_gap"]["value"] == pytest.approx(0.3)
    # oracle.json + transcripts 落独立目录（隔离，不进 campaign transcripts）
    assert (out / "oracle.json").exists()
    assert (out / "transcripts" / "oracle-D-t1.json").exists()
    assert (out / "transcripts" / "oracle-C-t1.json").exists()
    assert not (tmp_path / "run.jsonl").exists()


def test_runner_distillation_failure_skips_c_and_counts(tmp_path):
    rows = [_row(1, "t1", arm="experiment", score=0.4), _row(1, "t1", arm="control", score=0.3)]
    ctx = make_ctx(scores={"t1": 0.9}, distill_response="no numbered steps here at all")
    report = od.run_diagnostic_batch(["t1"], rows, ctx, tmp_path / "out")
    assert report["per_task"]["t1"]["C"] is None
    assert report["per_task"]["t1"]["distilled"] is False
    assert report["summary"]["distillation"]["success_n"] == 0
    assert report["summary"]["distillation"]["failures_n"] == 1
    # 只跑了 D，没跑 C
    assert len(ctx.run_agent.calls) == 1


def test_runner_d_failure_no_distillation(tmp_path):
    rows = [_row(1, "t1", arm="experiment", score=0.4), _row(1, "t1", arm="control", score=0.3)]
    ctx = make_ctx(scores={"t1": 0.3})  # D 失败（score<0.5）→ 不蒸馏不跑 C
    report = od.run_diagnostic_batch(["t1"], rows, ctx, tmp_path / "out")
    assert report["per_task"]["t1"]["C"] is None
    assert report["per_task"]["t1"]["distilled"] is False
    assert len(ctx.run_agent.calls) == 1


def test_runner_run_ab_runs_all_four(tmp_path):
    rows = [_row(1, "t1", score=0.4, term="max_turns")]  # 有 experiment 行但无 control
    ctx = make_ctx(scores={"t1": 0.5}, distill_response="1. step one here")
    report = od.run_diagnostic_batch(["t1"], rows, ctx, tmp_path / "out", run_ab=True)
    calls = ctx.run_agent.calls
    ab = [c for c in calls if c["prompt"] == "PROMPT:t1" and c["client"] == "STUDENT"]
    assert len(ab) == 2  # A（injection off）+ B（injection on）
    assert {c["injection"] for c in ab} == {False, True}
    assert report["per_task"]["t1"]["A"] == 0.5
    assert report["per_task"]["t1"]["B"] == 0.5


def test_teacher_client_reads_env_only(monkeypatch):
    monkeypatch.setenv("JUDGE_API_KEY", "k-secret-123")
    assert od.teacher_client().api_key == "k-secret-123"


def test_probe_teacher_url_normalization(monkeypatch):
    # pi-test 5.4：探针 URL 不得双 /v1（DEFAULT_TEACHER_BASE_URL 已含 /v1）
    captured = {}

    def fake_urlopen(url, timeout=0):
        captured["url"] = url
        raise urllib.error.HTTPError(url, 404, "not found", {}, None)  # 可达（404 → 视为在）

    monkeypatch.setattr(od.urllib.request, "urlopen", fake_urlopen)
    od._probe_teacher("http://127.0.0.1:8899/v1")
    assert captured["url"] == "http://127.0.0.1:8899/v1/models"
    od._probe_teacher("http://127.0.0.1:8899")
    assert captured["url"] == "http://127.0.0.1:8899/v1/models"
    od._probe_teacher("http://127.0.0.1:8899/v1/")
    assert captured["url"] == "http://127.0.0.1:8899/v1/models"


def test_plan_wrapper_template_preregistered():
    assert "以下是教师为此类任务验证过的正确计划" in od.PLAN_WRAPPER_TEMPLATE
    assert od.TEACHER_MODEL == "deepseek-v4-pro"
