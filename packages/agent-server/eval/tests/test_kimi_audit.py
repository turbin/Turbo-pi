"""kimi_audit.py 测试（Teacher/Judge 同源稳健性审计，preview.html §13；协议 runbook §4）。

预注册口径（见 kimi_audit.py docstring）：
  抽样：指定 day 已完成任务（run.jsonl 行）中确定性抽 ≤limit 个——按
    sha256(f"{run_id}-d{day}-kimi-audit-{task_id}") 的 hex 排序取前 limit；
    池不足 limit 取全部并标注；抽样键输出进报告。
    臂 = 该任务当日首个完成行（run.jsonl 文件序）对应的臂。
  重判：同 lib_grading 的 _build_judge_prompt（同 rubric：task.llm_judge_rubric
    or _format_grading_criteria）+ _summarize_transcript，调用走本地
    _call_kimi_judge_api（stdlib HTTP 同结构，temperature 固定 1.0——
    kimi-for-coding 只允许 temperature=1，2026-08-21 冒烟实测；与主 judge
    0.0 的温度差是已知口径差异，进报告 kimi.notes；vendored lib_grading 不改），
    base_url=KIMI_BASE_URL 默认 https://api.kimi.com/coding/v1、
    api_key=KIMI_API_KEY、model=KIMI_AUDIT_MODEL 默认 kimi-for-coding，
    解析复用 _parse_judge_text_response + _normalize_judge_response。
  分数：与 grade_task 相同聚合——llm_judge 取归一化 total；hybrid 按
    task.grading_weights 加权 + AUTO_PENALTY_THRESHOLD 罚零（automated 子分
    复用 run.jsonl 已存 breakdown 均值，不重跑 exec）。
  判据（预注册双判据）：① |Δ|≤0.2 占比 ≥2/3；② Spearman ρ>0；两条都满足 →
    consistent，否则 sensitive；n<6 时注明 Spearman 解释力有限。
  纪律：只读 run.jsonl/transcripts，只写 results/<run_id>/kimi-audit-dayN.json。
"""

import hashlib
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import kimi_audit as ka  # noqa: E402

# ── 抽样 ──


def _row(day, task_id, arm="experiment", score=0.5, grading_type="hybrid", automated=None, llm=None):
    grading = {"task_id": task_id, "score": score, "grading_type": grading_type}
    bd = {}
    if automated is not None:
        for i, v in enumerate(automated):
            bd[f"automated.c{i}"] = v
    if llm is not None:
        for i, v in enumerate(llm):
            bd[f"llm_judge.c{i}"] = v
    if bd:
        grading["breakdown"] = bd
    return {"day": day, "task_id": task_id, "arm": arm, "score": score, "grading": grading}


_SAMPLE_IDS = ["task_a", "task_b", "task_c", "task_d", "task_e", "task_f", "task_g", "task_h"]


def _day_rows(day, ids=_SAMPLE_IDS):
    return [_row(day, t) for t in ids]


def _expected_order(run_id, day, ids=_SAMPLE_IDS, limit=6):
    return sorted(ids, key=lambda t: hashlib.sha256(f"{run_id}-d{day}-kimi-audit-{t}".encode()).hexdigest())[:limit]


def test_sample_same_key_same_order():
    rows = _day_rows(2)
    a, _, meta_a = ka.sample_tasks("run-x", 2, rows)
    b, _, meta_b = ka.sample_tasks("run-x", 2, rows)
    assert a == b
    assert meta_a == meta_b


def test_sample_order_matches_preregistered_sha256_key():
    rows = _day_rows(2)
    sampled, _, meta = ka.sample_tasks("run-x", 2, rows, limit=6)
    assert sampled == _expected_order("run-x", 2)
    # 抽样键输出进报告（meta.sample_keys = sha256 hex）
    for tid in sampled:
        assert meta["sample_keys"][tid] == hashlib.sha256(f"run-x-d2-kimi-audit-{tid}".encode()).hexdigest()


def test_sample_under_limit_takes_all_and_marks_note():
    rows = [_row(2, t) for t in ["task_a", "task_b", "task_c"]]
    sampled, _, meta = ka.sample_tasks("run-x", 2, rows, limit=6)
    assert sorted(sampled) == ["task_a", "task_b", "task_c"]
    assert meta["sample_size"] == 3
    assert meta["note"] is not None
    assert "3" in meta["note"] and "6" in meta["note"]  # 不足 limit 标注
    assert meta["pool_size"] == 3


def test_sample_cross_day_different_order():
    d1 = ka.sample_tasks("run-x", 1, _day_rows(1))[0]
    d2 = ka.sample_tasks("run-x", 2, _day_rows(2))[0]
    assert d1 != d2  # 跨 day 键不同 → 顺序不同
    assert d1 == _expected_order("run-x", 1)
    assert d2 == _expected_order("run-x", 2)


def test_sample_different_run_id_different_order():
    a = ka.sample_tasks("run-x", 1, _day_rows(1))[0]
    b = ka.sample_tasks("run-y", 1, _day_rows(1))[0]
    assert a != b


def test_sample_excludes_non_judge_graded_first_rows():
    rows = [
        _row(2, "t_auto", grading_type="automated"),
        _row(2, "t_err", grading_type="error"),
        _row(2, "t_hyb"),
    ]
    sampled, _, meta = ka.sample_tasks("run-x", 2, rows)
    assert sampled == ["t_hyb"]
    assert meta["excluded_tasks"]["t_auto"] != ""
    assert meta["excluded_tasks"]["t_err"] != ""


def test_sample_filters_by_day():
    rows = _day_rows(1) + _day_rows(2)
    sampled, _, meta = ka.sample_tasks("run-x", 2, rows)
    assert set(sampled) <= set(_SAMPLE_IDS)
    assert meta["pool_size"] == 8


# ── 重判：prompt / 解析复用 ──


def _task(**over):
    from lib_tasks import Task  # noqa: PLC0415

    fields = dict(
        task_id="t1",
        name="n",
        category="c",
        grading_type="hybrid",
        timeout_seconds=300,
        workspace_files=[],
        prompt="Do the thing",
        expected_behavior="The thing is done",
        grading_criteria=["Quality", "Efficiency"],
        automated_checks=None,
        llm_judge_rubric="Rubric: strict evaluator",
        grading_weights={"automated": 0.4, "llm_judge": 0.6},
    )
    fields.update(over)
    return Task(**fields)


def _transcript():
    return [
        {"type": "message", "message": {"role": "assistant", "content": [{"type": "toolCall", "name": "bash", "arguments": {"command": "ls"}}]}},
        {"type": "message", "message": {"role": "toolResult", "content": ["file.txt"]}},
        {"type": "message", "message": {"role": "assistant", "content": [{"type": "text", "text": "done"}]}},
    ]


@pytest.fixture
def judge_env(monkeypatch):
    monkeypatch.setenv("KIMI_API_KEY", "kimi-test-key")
    calls = []

    def fake_call(*, prompt, model, base_url, api_key, **kw):
        calls.append({"prompt": prompt, "model": model, "base_url": base_url, "api_key": api_key, "kw": kw})
        return '{"scores": {"Quality": 0.8, "Efficiency": 0.6}, "total": 0.7, "notes": "ok"}'

    monkeypatch.setattr(ka, "_call_kimi_judge_api", fake_call)
    return calls


def test_judge_call_wiring_defaults(judge_env):
    task = _task()
    ka.judge_with_kimi("P", api_key="kimi-test-key", base_url="https://api.kimi.com/coding/v1", model="kimi-for-coding")
    assert judge_env[0]["base_url"] == "https://api.kimi.com/coding/v1"
    assert judge_env[0]["model"] == "kimi-for-coding"
    assert judge_env[0]["api_key"] == "kimi-test-key"
    assert judge_env[0]["prompt"] == "P"


def test_judge_call_wiring_env_overrides(monkeypatch):
    monkeypatch.setenv("KIMI_API_KEY", "k2")
    monkeypatch.setenv("KIMI_BASE_URL", "http://kimi.local:9999/v1")
    monkeypatch.setenv("KIMI_AUDIT_MODEL", "kimi-audit-pro")
    calls = []
    monkeypatch.setattr(
        ka, "_call_kimi_judge_api",
        lambda **kw: calls.append(kw) or '{"total": 0.5}',
    )
    ka.judge_with_kimi("P", api_key="k2", base_url="http://kimi.local:9999/v1", model="kimi-audit-pro")
    assert calls[0]["base_url"] == "http://kimi.local:9999/v1"
    assert calls[0]["model"] == "kimi-audit-pro"


def test_prompt_reuses_lib_grading_builders(judge_env):
    """prompt 与主 judge 同源：_build_judge_prompt(task, 同一摘要, 同一 rubric)。"""
    from lib_grading import _build_judge_prompt, _format_grading_criteria, _summarize_transcript  # noqa: PLC0415

    task = _task()
    transcript = _transcript()
    ka.judge_with_kimi("P", api_key="k", base_url="b", model="m")
    # 上面只验证接线；这里直接构造同源 prompt 对比
    expected = _build_judge_prompt(
        task,
        _summarize_transcript(transcript),
        task.llm_judge_rubric or _format_grading_criteria(task),
    )
    # 同一摘要：Tool: bash(...) / Result / User 形态
    assert "Tool: bash" in _summarize_transcript(transcript)
    assert "Rubric: strict evaluator" in expected
    # 重判走 audit_day 时 prompt 必须等于该同源构造（在 audit 集成测试中验证）


def test_prompt_rubric_fallback_to_grading_criteria(judge_env):
    from lib_grading import _build_judge_prompt, _format_grading_criteria, _summarize_transcript  # noqa: PLC0415

    task = _task(llm_judge_rubric=None)
    transcript = _transcript()
    expected = _build_judge_prompt(task, _summarize_transcript(transcript), _format_grading_criteria(task))
    assert "- Quality" in expected and "- Efficiency" in expected


def test_response_parsing_reuses_parse_judge_text_response(judge_env):
    """code-fence JSON 与 prose total 两种原始响应都按 _parse_judge_text_response 口径解析。"""
    parsed = ka.judge_with_kimi("P", api_key="k", base_url="b", model="m")
    assert parsed["total"] == 0.7
    assert parsed["scores"] == {"Quality": 0.8, "Efficiency": 0.6}
    assert parsed["notes"] == "ok"

    calls = []

    def prose_call(**kw):
        calls.append(kw)
        return "Here is my grading. Total: 0.65 overall."

    ka._call_kimi_judge_api = prose_call  # type: ignore[assignment]
    parsed2 = ka.judge_with_kimi("P", api_key="k", base_url="b", model="m")
    assert parsed2["total"] == 0.65
    assert "prose" in parsed2["notes"]


# ── 本地 Kimi 调用（temperature=1.0；vendored lib_grading 不改） ──


class _FakeHttpResp:
    """urlopen 假响应（context manager + read）。"""

    def __init__(self, body: bytes):
        self._body = body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        return self._body


def _http_error(url, body: bytes):
    fp = type("_FP", (), {})()
    fp.headers = {}
    fp.close = lambda: None
    fp.read = lambda n=-1: body
    return urllib.error.HTTPError(url, 400, "Bad Request", {}, fp)


def test_call_kimi_judge_api_payload_temperature_1(monkeypatch):
    """kimi-for-coding 只允许 temperature=1（2026-08-21 冒烟实测：0.0 → 400
    "invalid temperature: only 1 is allowed for this model"）→ 本地函数固定 1.0。"""
    captured = {}

    def fake_urlopen(req, timeout=None):
        captured["req"] = req
        captured["timeout"] = timeout
        return _FakeHttpResp(b'{"choices": [{"message": {"content": "GRADED"}}]}')

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    out = ka._call_kimi_judge_api(
        "P", model="kimi-for-coding", base_url="https://api.kimi.com/coding/v1", api_key="k"
    )
    assert out == "GRADED"
    req = captured["req"]
    payload = json.loads(req.data)
    assert payload["temperature"] == 1.0  # 冒烟实测修复：kimi-for-coding 拒绝 0.0
    assert payload["model"] == "kimi-for-coding"
    assert payload["max_tokens"] == 20480
    assert payload["messages"] == [{"role": "user", "content": "P"}]
    assert req.full_url == "https://api.kimi.com/coding/v1/chat/completions"
    assert req.get_header("Authorization") == "Bearer k"
    assert req.get_method() == "POST"
    assert captured["timeout"] is not None


def test_call_kimi_judge_api_trailing_slash_base_url(monkeypatch):
    captured = {}

    def fake_urlopen(req, timeout=None):
        captured["req"] = req
        return _FakeHttpResp(b'{"choices": [{"message": {"content": "x"}}]}')

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    ka._call_kimi_judge_api("P", model="m", base_url="http://k.local:9/v1/", api_key="k")
    assert captured["req"].full_url == "http://k.local:9/v1/chat/completions"


def test_call_kimi_judge_api_http_error_fails_loud(monkeypatch):
    """HTTP 400（冒烟实测的 invalid temperature 同形错误）→ RuntimeError 带状态码+响应体。"""

    def fake_urlopen(req, timeout=None):
        raise _http_error(
            req.full_url,
            b'{"error": {"message": "invalid temperature: only 1 is allowed for this model"}}',
        )

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    with pytest.raises(RuntimeError, match=r"400.*invalid temperature"):
        ka._call_kimi_judge_api("P", model="m", base_url="http://k.local/v1", api_key="k")


def test_call_kimi_judge_api_no_choices_fails_loud(monkeypatch):
    def fake_urlopen(req, timeout=None):
        return _FakeHttpResp(b'{"error": "oops"}')

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    with pytest.raises(RuntimeError, match="no choices"):
        ka._call_kimi_judge_api("P", model="m", base_url="http://k.local/v1", api_key="k")


def test_judge_with_kimi_wires_local_function(monkeypatch):
    """judge_with_kimi 接线改指本地 _call_kimi_judge_api（不再走 lib_grading）。"""
    calls = []

    def fake_call(*, prompt, model, base_url, api_key, **kw):
        calls.append({"prompt": prompt, "model": model, "base_url": base_url, "api_key": api_key})
        return '{"scores": {"Q": 0.9}, "total": 0.9}'

    monkeypatch.setattr(ka, "_call_kimi_judge_api", fake_call)
    parsed = ka.judge_with_kimi("P", api_key="k", base_url="b", model="m")
    assert len(calls) == 1
    assert calls[0] == {"prompt": "P", "model": "m", "base_url": "b", "api_key": "k"}
    assert parsed["total"] == 0.9


def test_report_notes_temperature_caliber_difference(kimi_audit_env):
    """温度差（audit 1.0 vs 主 judge 0.0）是已知口径差异，进报告 kimi.notes。"""
    run_dir, _ = kimi_audit_env
    report = ka.audit_day(run_dir, 2)
    assert report["kimi"]["temperature"] == 1.0
    assert "temperature" in report["kimi"]["notes"].lower()


# ── 分数口径（与 grade_task 相同聚合） ──


def test_audit_score_llm_judge_uses_normalized_total():
    assert ka.audit_score("llm_judge", {}, None, {"scores": {}, "total": 0.65}) == pytest.approx(0.65)


def test_audit_score_hybrid_combines_like_grade_task():
    """同 _combine_grades：权重加权 + AUTO_PENALTY_THRESHOLD 罚零（automated 分 =
    breakdown automated.* 均值）。"""
    weights = {"automated": 0.4, "llm_judge": 0.6}
    bd = {"automated.c0": 1.0, "automated.c1": 0.5, "llm_judge.c0": 0.9}
    # auto=0.75 恰在阈值上（0.75 < 0.75 为 False）→ llm 贡献保留
    assert ka.audit_score("hybrid", bd, weights, {"scores": {}, "total": 0.5}) == pytest.approx(0.75 * 0.4 + 0.5 * 0.6)
    # auto=0.7 低于阈值 → llm 贡献罚零
    bd2 = {"automated.c0": 0.7, "automated.c1": 0.7}
    assert ka.audit_score("hybrid", bd2, weights, {"scores": {}, "total": 0.9}) == pytest.approx(0.7 * 0.4)
    # 缺省权重 0.5/0.5
    assert ka.audit_score("hybrid", bd, None, {"scores": {}, "total": 0.5}) == pytest.approx((0.75 + 0.5) / 2)
    # 空 automated breakdown → auto=0 → llm 罚零 → 0
    assert ka.audit_score("hybrid", {}, weights, {"scores": {}, "total": 0.9}) == pytest.approx(0.0)


# ── 双判据 ──


def test_criterion1_delta_exactly_0_2_passes():
    c = ka.criterion1_within([0.2, -0.2, 0.0, 0.1])
    assert c["n_within"] == 4
    assert c["passed"] is True


def test_criterion1_two_thirds_boundary():
    # n=6：4/6 恰为 2/3 → 过；3/6 不过
    c_pass = ka.criterion1_within([0.0, 0.1, -0.05, 0.2, 0.9, 0.8])
    assert c_pass["n_within"] == 4 and c_pass["passed"] is True
    c_fail = ka.criterion1_within([0.0, 0.1, -0.05, 0.9, 0.9, 0.8])
    assert c_fail["n_within"] == 3 and c_fail["passed"] is False
    # n=3：2/3 需要 2/3（2 个）
    assert ka.criterion1_within([0.0, 0.1, 0.9])["passed"] is True
    assert ka.criterion1_within([0.0, 0.9, 0.9])["passed"] is False
    # n=1：单任务占比 1/1 ≥ 2/3
    assert ka.criterion1_within([0.1])["passed"] is True


def test_spearman_basic_sign():
    assert ka.spearman_rho([1, 2, 3, 4], [1, 2, 3, 4]) == pytest.approx(1.0)
    assert ka.spearman_rho([1, 2, 3, 4], [4, 3, 2, 1]) == pytest.approx(-1.0)


def test_spearman_ties_average_ranks():
    # 并列取平均秩：xs [1,2,2,3] 秩 [1,2.5,2.5,4]，ys [4,2,2,1] 秩 [4,2.5,2.5,1] → ρ=-1
    assert ka.spearman_rho([1, 2, 2, 3], [4, 2, 2, 1]) == pytest.approx(-1.0)
    assert ka.spearman_rho([1, 2, 2, 3], [1, 3, 3, 4]) == pytest.approx(1.0)


def test_criterion2_spearman_sign():
    c_pos = ka.criterion2_spearman([0.5, 0.6, 0.7, 0.8], [0.5, 0.6, 0.7, 0.8])
    assert c_pos["rho"] > 0 and c_pos["passed"] is True
    c_neg = ka.criterion2_spearman([0.5, 0.6, 0.7, 0.8], [0.8, 0.7, 0.6, 0.5])
    assert c_neg["rho"] < 0 and c_neg["passed"] is False
    # rho=0（无单调方向）→ 不过：ys 秩 [2,4,1,3] 与 xs 秩 [1,2,3,4] 不相关
    c_zero = ka.criterion2_spearman([0.5, 0.6, 0.7, 0.8], [0.6, 0.8, 0.4, 0.7])
    assert c_zero["rho"] == pytest.approx(0.0)
    assert c_zero["passed"] is False


def test_criterion2_zero_variance_not_evaluable_fails():
    c = ka.criterion2_spearman([0.5, 0.5, 0.5], [0.5, 0.6, 0.7])
    assert c["rho"] is None
    assert c["passed"] is False
    assert c["note"] is not None


def test_criterion2_small_n_note():
    c = ka.criterion2_spearman([0.5, 0.6, 0.7], [0.5, 0.6, 0.7])
    assert c["rho"] == pytest.approx(1.0) and c["passed"] is True
    assert c["note"] is not None  # n<6 注明解释纪律
    c6 = ka.criterion2_spearman([0.5, 0.6, 0.7, 0.8, 0.9, 1.0], [0.5, 0.6, 0.7, 0.8, 0.9, 1.0])
    assert c6["note"] is None


def test_verdict_requires_both_criteria():
    assert ka.verdict({"passed": True}, {"passed": True}) == "consistent"
    assert ka.verdict({"passed": False}, {"passed": True}) == "sensitive"
    assert ka.verdict({"passed": True}, {"passed": False}) == "sensitive"
    assert ka.verdict({"passed": False}, {"passed": False}) == "sensitive"


# ── 纪律：只读既有产物 + 只写独立报告 ──


def _make_run_dir(tmp_path, day=2, score_map=None, arms=None):
    """构造最小 run 目录：run.jsonl（首行臂 = transcript 臂）+ transcripts。

    hybrid 行带 automated 全 1.0 breakdown（auto=1.0 ≥ 罚零阈值 0.75），
    kimi total 经 0.4/0.6 加权后与 score_deepseek 对齐（见 kimi_audit_env）。
    """
    score_map = score_map or {"task_a": 0.7, "task_b": 0.6, "task_c": 0.5}
    arms = arms or {"task_a": "x2", "task_b": "x1", "task_c": "x3"}
    run_dir = tmp_path / "results" / "campaign-x"
    run_dir.mkdir(parents=True)
    rows = []
    for tid in ["task_a", "task_b", "task_c"]:
        # 每任务两行：首行（文件序）= transcript 臂，第二行另一臂
        rows.append(_row(day, tid, arm=arms[tid], score=score_map[tid], automated=[1.0, 1.0], llm=[0.9, 0.8]))
        rows.append(_row(day, tid, arm="x4", score=score_map[tid], automated=[1.0, 1.0], llm=[0.9, 0.8]))
        tdir = run_dir / "transcripts" / f"day{day}"
        tdir.mkdir(parents=True, exist_ok=True)
        (tdir / f"{arms[tid]}-{tid}.json").write_text(
            json.dumps({"task_id": tid, "arm": arms[tid], "day": day,
                        "prompt": f"P:{tid}", "transcript": _transcript(), "score": score_map[tid]})
        )
    (run_dir / "run.jsonl").write_text("\n".join(json.dumps(r) for r in rows) + "\n")
    return run_dir


@pytest.fixture
def kimi_audit_env(monkeypatch, tmp_path):
    """端到端 audit_day 环境：mock Kimi 调用 + 固定 task 加载。"""
    monkeypatch.setenv("KIMI_API_KEY", "kimi-test-key")
    run_dir = _make_run_dir(tmp_path)
    calls = []

    def fake_call(*, prompt, model, base_url, api_key, **kw):
        calls.append({"prompt": prompt, "model": model, "base_url": base_url, "api_key": api_key})
        tid = prompt.split("P:")[1].split()[0] if "P:" in prompt else "task_a"
        # weights 0.4/0.6 + auto=1.0 → score_kimi = 0.4 + 0.6*total；
        # 取 total 使 score_kimi == score_deepseek（delta=0，ρ=1）
        total = {"task_a": 0.5, "task_b": 0.333333, "task_c": 0.166667}.get(tid, 0.5)
        return json.dumps({"scores": {"Quality": total}, "total": total, "notes": "ok"})

    monkeypatch.setattr(ka, "_call_kimi_judge_api", fake_call)
    monkeypatch.setattr(ka, "load_task", lambda tid: _task(task_id=tid, prompt=f"P:{tid}"))
    return run_dir, calls


def test_audit_day_prompt_equals_lib_grading_construction(kimi_audit_env):
    """重判 prompt 与主 judge 完全同源（同 rubric + 同摘要 + 同 _build_judge_prompt）。"""
    from lib_grading import _build_judge_prompt, _format_grading_criteria, _summarize_transcript  # noqa: PLC0415

    run_dir, calls = kimi_audit_env
    report = ka.audit_day(run_dir, 2)
    for i, tid in enumerate(report["per_task"]):
        task = _task(task_id=tid, prompt=f"P:{tid}")
        expected = _build_judge_prompt(task, _summarize_transcript(_transcript()), task.llm_judge_rubric)
        assert calls[i]["prompt"] == expected
        assert calls[i]["model"] == "kimi-for-coding"
        assert calls[i]["base_url"] == "https://api.kimi.com/coding/v1"
        assert calls[i]["api_key"] == "kimi-test-key"


def test_audit_day_report_and_discipline(kimi_audit_env):
    """纪律：运行前后 run.jsonl 与 transcripts 内容不变；只新增独立报告文件。"""
    run_dir, _ = kimi_audit_env
    snap = {str(p.relative_to(run_dir)): p.read_bytes() for p in sorted(run_dir.rglob("*")) if p.is_file()}
    before_files = {str(p.relative_to(run_dir)) for p in run_dir.rglob("*") if p.is_file()}
    report = ka.audit_day(run_dir, 2)
    after = {str(p.relative_to(run_dir)): p.read_bytes() for p in sorted(run_dir.rglob("*")) if p.is_file()}
    for name, content in snap.items():
        assert after[name] == content  # run.jsonl / transcripts 内容不变
    new_files = set(after) - before_files
    assert new_files == {"kimi-audit-day2.json"}  # 只写独立报告

    # 报告结构：抽样键 + 逐任务对照 + 双判据 + verdict
    assert report["run_id"] == "campaign-x" and report["day"] == 2
    assert set(report["sampling"]["sample_keys"]) == {"task_a", "task_b", "task_c"}
    assert report["sampling"]["pool_size"] == 3 and report["sampling"]["note"] is not None
    pt = report["per_task"]
    assert set(pt) == {"task_a", "task_b", "task_c"}
    assert pt["task_a"]["arm"] == "x2"  # 首行臂
    # hybrid 口径：weights 0.4/0.6 + auto=1.0 → score_kimi = 0.4 + 0.6*total
    assert pt["task_a"]["score_kimi"] == pytest.approx(0.7)
    assert pt["task_a"]["delta"] == pytest.approx(0.0)
    assert pt["task_b"]["delta"] == pytest.approx(0.4 + 0.6 * 0.333333 - 0.6, abs=1e-3)
    c = report["criteria"]
    assert c["criterion1"]["passed"] is True
    assert c["criterion2"]["rho"] == pytest.approx(1.0)
    assert c["verdict"] == "consistent"
    assert (run_dir / "kimi-audit-day2.json").exists()


def test_audit_day_uses_first_row_arm(monkeypatch, tmp_path):
    """臂取该任务当日首个完成行对应的臂（文件序）。"""
    monkeypatch.setenv("KIMI_API_KEY", "k")
    run_dir = _make_run_dir(tmp_path, arms={"task_a": "x1", "task_b": "x2", "task_c": "x3"})
    # task_a 首行臂改成 x1 → transcript 应取 x1-task_a.json
    calls = []

    def fake_call(*, prompt, model, base_url, api_key, **kw):
        calls.append(prompt)
        return '{"total": 0.5}'

    monkeypatch.setattr(ka, "_call_kimi_judge_api", fake_call)
    monkeypatch.setattr(ka, "load_task", lambda tid: _task(task_id=tid, prompt=f"P:{tid}"))
    report = ka.audit_day(run_dir, 2)
    assert report["per_task"]["task_a"]["arm"] == "x1"


# ── fail-loud ──


def test_missing_transcript_fails_loud(monkeypatch, tmp_path):
    monkeypatch.setenv("KIMI_API_KEY", "k")
    monkeypatch.setattr(ka, "load_task", lambda tid: _task(task_id=tid, prompt=f"P:{tid}"))
    run_dir = _make_run_dir(tmp_path)
    # 删掉抽样序第一个任务的 transcript（抽样序 = sha256 序，先查先报）
    rows = [json.loads(l) for l in (run_dir / "run.jsonl").read_text().splitlines() if l.strip()]
    first, first_rows, _ = ka.sample_tasks("campaign-x", 2, rows)
    (run_dir / "transcripts" / "day2" / f"{first_rows[first[0]]['arm']}-{first[0]}.json").unlink()
    with pytest.raises(RuntimeError, match="transcript"):
        ka.audit_day(run_dir, 2)


def test_missing_api_key_fails_loud(monkeypatch, tmp_path):
    monkeypatch.delenv("KIMI_API_KEY", raising=False)
    run_dir = _make_run_dir(tmp_path)
    called = []

    def fake_call(**kw):
        called.append(kw)
        return '{"total": 0.5}'

    monkeypatch.setattr(ka, "_call_kimi_judge_api", fake_call)
    with pytest.raises(RuntimeError, match="KIMI_API_KEY"):
        ka.audit_day(run_dir, 2)
    assert called == []  # 未做任何 LLM 调用


def test_audit_day_no_rows_for_day_fails_loud(tmp_path):
    run_dir = _make_run_dir(tmp_path, day=2)
    with pytest.raises(RuntimeError, match="day 3"):
        ka.audit_day(run_dir, 3)


def test_audit_day_no_run_jsonl_fails_loud(tmp_path):
    with pytest.raises(RuntimeError, match="run.jsonl"):
        ka.audit_day(tmp_path / "nope", 1)


def test_audit_day_judge_api_error_fails_loud(monkeypatch, tmp_path):
    monkeypatch.setenv("KIMI_API_KEY", "k")
    monkeypatch.setattr(ka, "load_task", lambda tid: _task(task_id=tid, prompt=f"P:{tid}"))
    run_dir = _make_run_dir(tmp_path)

    def boom(**kw):
        raise RuntimeError("LLM judge API returned 429: rate limited")

    monkeypatch.setattr(ka, "_call_kimi_judge_api", boom)
    with pytest.raises(RuntimeError, match="429"):
        ka.audit_day(run_dir, 2)


# ── CLI ──


def test_main_cli(kimi_audit_env, capsys, monkeypatch):
    monkeypatch.setenv("KIMI_API_KEY", "kimi-test-key")
    run_dir, _ = kimi_audit_env
    rc = ka.main([str(run_dir), "--day", "2", "--limit", "6"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "consistent" in out
    assert "task_a" in out
    assert (run_dir / "kimi-audit-day2.json").exists()
    report = json.loads((run_dir / "kimi-audit-day2.json").read_text())
    assert report["sampling"]["limit"] == 6


def test_main_cli_transcripts_dir_override(kimi_audit_env, capsys, tmp_path, monkeypatch):
    monkeypatch.setenv("KIMI_API_KEY", "kimi-test-key")
    run_dir, _ = kimi_audit_env
    alt = tmp_path / "alt-transcripts"
    (alt / "day2").mkdir(parents=True)
    for tid, arm in (("task_a", "x2"), ("task_b", "x1"), ("task_c", "x3")):
        (alt / "day2" / f"{arm}-{tid}.json").write_text(json.dumps({"transcript": _transcript()}))
    rc = ka.main([str(run_dir), "--day", "2", "--transcripts-dir", str(alt)])
    assert rc == 0
    assert "consistent" in capsys.readouterr().out
