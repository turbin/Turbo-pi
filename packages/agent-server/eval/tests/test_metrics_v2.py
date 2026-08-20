"""T6+T10 metrics_v2 测试（pytest，eval/.venv 运行）。

预注册口径（doc/design/plans/2026-08-19-d-stage-addendum-v2-dev-tasks.md §1.1/§1.5；
评审 doc/design/D阶段实验设计补充评审_指标与条件检查.md）：
  Success@K           K∈{5,10,15,20,30}，成功=score≥0.5，rounds≤K（含边界）；
                      轮数=transcript assistant 回合（trajectory_metrics.parse_rounds）；
                      缺 transcript / 缺 score 的行计 unknown（评审§四）。
  失败迁移矩阵         kind==repeat 任务 D1→D7（D1=min day，D7=max day）四象限配对；
                      触顶=termination_reason=="max_turns"，旧行 fallback requests>=30
                      （preview.html §8.1）；D7 实验等效臂=x2（四臂日），否则 experiment
                      （campaign_cross：X2=原实验臂口径）（评审§十二）。
  RecoveryConversion  P(D7∈{Efficient,Boundary}Success | D1=ExhaustedFailure) 双口径。
  RegressionRate      P(score_D7 < score_D1 − 0.1)，δ=0.1 预注册（严格小于）（评审§十三）。
  MemoryInducedRegressionRate 同日 ON/OFF 配对（experiment vs control；四臂日 x2 vs x3）。
  Useful/FalseHit     任务级近似：hit=true 任务 score_ON ≥ score_OFF − δ → useful；
                      配对缺失按同日臂均值近似并标注 approximated（评审§二）。
  Functional/Judge    grading.breakdown 按 automated./llm_judge. 前缀分组（评审§五）。
  难度分层             D1 实验臂三档 easy≥0.6 / medium 0.3-0.6 / hard<0.3
                      + task_id 关键词 dsl/workflow/multi 辅层（评审§十一）。
  TreatmentCompliance 四臂日 X3/X4 行 request_traces（task_id join）零注入；
                      无四臂数据 n=0 不 fail（评审§十）。
  economics            teacher 台账摊销（§1.5 / 评审§十六）：单价表预注册常量
                      deepseek-v4-pro $0.435/M in / $0.87/M out（2026-07-30）。
"""

import json
import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import metrics_v2 as mv  # noqa: E402


# ── fixture helpers ─────────────────────────────────────────────────────


def _row(day, task, arm="experiment", kind="repeat", score=0.8, requests=10,
         termination_reason="completed", breakdown=None):
    row = {
        "day": day,
        "task_id": task,
        "kind": kind,
        "arm": arm,
        "score": score,
        "passed": score >= 0.5,
        "escalated": False,
        "requests": requests,
    }
    if termination_reason is not None:
        row["termination_reason"] = termination_reason
    if breakdown is not None:
        row["grading"] = {"score": score, "breakdown": breakdown, "grading_error": False}
    return row


def _transcript_doc(day, arm, task, n_rounds):
    events = [
        {
            "type": "message",
            "message": {"role": "assistant", "content": [{"type": "text", "text": f"step {i}"}]},
        }
        for i in range(n_rounds)
    ]
    return {"day": day, "arm": arm, "task_id": task, "prompt": "p", "transcript": events, "score": 0.8}


def _write_run(run_dir: Path, rows: list[dict], docs: list[dict]) -> None:
    (run_dir / "run.jsonl").write_text("\n".join(json.dumps(r) for r in rows) + "\n")
    for doc in docs:
        p = run_dir / "transcripts" / f"day{doc['day']}" / f"{doc['arm']}-{doc['task_id']}.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(doc))


def _trace_db(path: Path, traces: list[dict]) -> None:
    con = sqlite3.connect(path)
    con.execute(
        "CREATE TABLE request_traces (request_id TEXT, task_id TEXT, hit INTEGER,"
        " injected_tokens INTEGER, injected_ids TEXT, prompt_tokens INTEGER,"
        " completion_tokens INTEGER, ts TEXT)"
    )
    for t in traces:
        con.execute(
            "INSERT INTO request_traces VALUES (?,?,?,?,?,?,?,?)",
            (
                t.get("request_id", "r1"),
                t["task_id"],
                int(t.get("hit", 0)),
                int(t.get("injected_tokens", 0)),
                json.dumps(t.get("injected_ids", [])),
                t.get("prompt_tokens", 100),  # None → NULL（缺失形态，供 skipped 用例）
                t.get("completion_tokens", 50),
                t.get("ts", "2026-08-19T00:00:00Z"),  # None → NULL（unknown 日用例）
            ),
        )
    con.commit()
    con.close()


def _gateway_db(path: Path, runs: list[dict]) -> None:
    con = sqlite3.connect(path)
    con.execute(
        "CREATE TABLE model_runs (id INTEGER PRIMARY KEY, trace_id TEXT, purpose TEXT,"
        " state TEXT, cost_micro_usd INTEGER)"
    )
    for i, r in enumerate(runs):
        con.execute(
            "INSERT INTO model_runs VALUES (?,?,?,?,?)",
            (i + 1, r.get("trace_id", f"t{i}"), r["purpose"], r["state"], r.get("cost_micro_usd")),
        )
    con.commit()
    con.close()


def _ledger(path: Path, lines: list[dict]) -> None:
    path.write_text("\n".join(json.dumps(l) for l in lines) + "\n")


# ── Success@K ──────────────────────────────────────────────────────────


def test_success_at_k_rates_inclusive_and_grouping(tmp_path):
    rows = [
        _row(1, "ta", arm="experiment", score=0.8),   # 4 rounds
        _row(1, "tb", arm="experiment", score=0.8),   # 12 rounds
        _row(1, "tc", arm="experiment", score=0.2),   # 20 rounds
        _row(1, "td", arm="control", score=0.9),      # 3 rounds
    ]
    docs = [
        _transcript_doc(1, "experiment", "ta", 4),
        _transcript_doc(1, "experiment", "tb", 12),
        _transcript_doc(1, "experiment", "tc", 20),
        _transcript_doc(1, "control", "td", 3),
    ]
    _write_run(tmp_path, rows, docs)
    rep = mv.success_at_k(rows, tmp_path)
    exp = rep["by_arm"]["experiment"]
    assert exp["tasks"] == 3 and exp["scored_n"] == 3 and exp["unknown_n"] == 0
    assert exp["success_n"] == 2
    assert exp["k5"] == pytest.approx(1 / 3)
    assert exp["k10"] == pytest.approx(1 / 3)
    assert exp["k15"] == pytest.approx(2 / 3)
    assert exp["k20"] == pytest.approx(2 / 3)
    assert exp["k30"] == pytest.approx(2 / 3)
    assert rep["by_arm"]["control"]["k5"] == pytest.approx(1.0)
    assert rep["by_day"]["1"]["k5"] == pytest.approx(2 / 4)
    assert rep["total"]["k30"] == pytest.approx(3 / 4)
    assert rep["ks"] == [5, 10, 15, 20, 30]


def test_success_at_k_rounds_boundary_inclusive(tmp_path):
    # rounds 恰好 == K 计入该 K（"第 K 轮前（含）"）。
    rows = [_row(1, "ta", score=0.8)]
    docs = [_transcript_doc(1, "experiment", "ta", 5)]
    _write_run(tmp_path, rows, docs)
    rep = mv.success_at_k(rows, tmp_path)
    assert rep["total"]["k5"] == pytest.approx(1.0)


def test_success_at_k_empty_transcript_counts_zero_rounds(tmp_path):
    # 空 transcript（文件存在但无事件）→ rounds=0 → 全部 K 命中。
    # 观察项：与"缺 transcript 计 unknown"不同，空 transcript 会高估 Success@K。
    rows = [_row(1, "ta", score=0.8)]
    docs = [{"day": 1, "arm": "experiment", "task_id": "ta", "prompt": "p", "transcript": [], "score": 0.8}]
    _write_run(tmp_path, rows, docs)
    rep = mv.success_at_k(rows, tmp_path)
    assert rep["total"]["unknown_n"] == 0
    assert rep["total"]["k5"] == pytest.approx(1.0)


def test_success_at_k_unknown_transcript_and_missing_score(tmp_path):
    rows = [
        _row(1, "ta", score=0.8),          # 有 transcript
        _row(1, "te", score=0.7),          # 无 transcript 文件
        {**_row(1, "tf", score=0.8), "score": None},  # 无 score
    ]
    docs = [_transcript_doc(1, "experiment", "ta", 4)]
    _write_run(tmp_path, rows, docs)
    rep = mv.success_at_k(rows, tmp_path)
    t = rep["total"]
    assert t["tasks"] == 3
    assert t["scored_n"] == 2
    assert t["unknown_n"] == 2  # te 缺 transcript + tf 缺 score
    assert t["k5"] == pytest.approx(1 / 2)


# ── 失败迁移矩阵 + RecoveryConversion ──────────────────────────────────


def test_migration_quadrants_matrix_and_recovery(tmp_path):
    # 旧行 fallback：ta/td 的 D1 行无 termination_reason，requests>=30 → ExhaustedFailure。
    rows = [
        {"day": 1, "task_id": "ta", "kind": "repeat", "arm": "experiment", "score": 0.2, "requests": 30},
        _row(7, "ta", arm="x2", score=0.8, requests=8, termination_reason="completed"),   # EF→ES
        _row(1, "tb", arm="experiment", score=0.8, requests=6, termination_reason="completed"),
        _row(7, "tb", arm="x2", score=0.7, requests=30, termination_reason="max_turns"),  # ES→BS
        {"day": 1, "task_id": "tc", "kind": "repeat", "arm": "experiment", "score": 0.2, "requests": 5},
        _row(7, "tc", arm="x2", score=0.2, requests=4, termination_reason="completed"),   # EE→EE
        {"day": 1, "task_id": "td", "kind": "repeat", "arm": "experiment", "score": 0.3, "requests": 30},
        _row(7, "td", arm="x2", score=0.2, requests=30, termination_reason="max_turns"),  # EF→EF
    ]
    rep = mv.migration(rows)
    m = rep["matrix"]
    assert m["D1_ExhaustedFailure"]["D7_EfficientSuccess"] == 1  # ta
    assert m["D1_EfficientSuccess"]["D7_BoundarySuccess"] == 1   # tb
    assert m["D1_EarlyFailure"]["D7_EarlyFailure"] == 1          # tc
    assert m["D1_ExhaustedFailure"]["D7_ExhaustedFailure"] == 1  # td
    assert rep["paired_n"] == 4
    rc = rep["recovery_conversion"]
    assert rc["d1_exhausted_n"] == 2
    assert rc["efficient_only"] == pytest.approx(0.5)          # ta：1/2
    assert rc["efficient_or_boundary"] == pytest.approx(0.5)
    assert rc["efficient_only_n"] == 1
    assert rc["efficient_or_boundary_n"] == 1


def test_recovery_conversion_boundary_success_in_or_scope(tmp_path):
    # EF→Boundary：efficient_only 不含，efficient_or_boundary 含。
    rows = [
        _row(1, "te", arm="experiment", score=0.2, requests=30, termination_reason="max_turns"),
        _row(7, "te", arm="x2", score=0.8, requests=30, termination_reason="max_turns"),
    ]
    rc = mv.migration(rows)["recovery_conversion"]
    assert rc["efficient_only"] == pytest.approx(0.0)
    assert rc["efficient_or_boundary"] == pytest.approx(1.0)


def test_migration_d7_both_arms_should_prefer_x2(tmp_path):
    # docstring 预注册：D7 实验等效臂 = x2（四臂日，campaign_cross 口径）；
    # D7 同日同时存在 experiment 与 x2 行时取 x2（任务书 §1.1）。
    rows = [
        _row(1, "ta", arm="experiment", score=0.2, requests=30, termination_reason="max_turns"),
        _row(7, "ta", arm="experiment", score=0.9, requests=5, termination_reason="completed"),
        _row(7, "ta", arm="x2", score=0.3, requests=5, termination_reason="completed"),
    ]
    rep = mv.migration(rows)
    # 期望：D7 取 x2 → EF→EarlyFailure（不取 experiment → EF→EfficientSuccess）
    assert rep["matrix"]["D1_ExhaustedFailure"]["D7_EarlyFailure"] == 1
    assert rep["matrix"]["D1_ExhaustedFailure"]["D7_EfficientSuccess"] == 0


def test_migration_two_arm_d7_uses_experiment(tmp_path):
    # 非四臂日 D7 无 x2 行：实验等效臂回退 experiment。
    rows = [
        _row(1, "ta", arm="experiment", score=0.2, requests=30, termination_reason="max_turns"),
        _row(7, "ta", arm="experiment", score=0.9, requests=5, termination_reason="completed"),
    ]
    rep = mv.migration(rows)
    assert rep["matrix"]["D1_ExhaustedFailure"]["D7_EfficientSuccess"] == 1
    assert rep["paired_n"] == 1


def test_migration_excludes_non_repeat_and_missing_d1_or_d7(tmp_path):
    rows = [
        _row(1, "ta", arm="experiment", score=0.2, requests=30, termination_reason="max_turns"),
        _row(7, "ta", arm="x2", score=0.9, requests=5, termination_reason="completed"),
        _row(1, "tb", kind="new", arm="experiment", score=0.8),  # 非 repeat 不配对
        _row(7, "tb", kind="new", arm="x2", score=0.9),
        _row(1, "tc", arm="experiment", score=0.8),              # 缺 D7 行
    ]
    rep = mv.migration(rows)
    assert rep["paired_n"] == 1
    assert rep["unpaired_n"] == 1  # tc 缺 D7 行；tb 为 new 不在作用域


# ── RegressionRate ─────────────────────────────────────────────────────


def test_regression_rate_delta_boundary(tmp_path):
    rows = [
        _row(1, "sa", arm="experiment", score=0.8),
        _row(7, "sa", arm="experiment", score=0.69),  # 0.69 < 0.8−0.1 → regressed
        _row(1, "sb", arm="experiment", score=0.8),
        _row(7, "sb", arm="experiment", score=0.70),  # 边界：恰差 0.1 → 不算（严格小于）
        _row(1, "sc", arm="experiment", score=0.5),
        _row(7, "sc", arm="experiment", score=0.9),   # improved
    ]
    rep = mv.regression(rows)["d1_d7"]
    assert rep["paired_n"] == 3
    assert rep["regressed_n"] == 1
    assert rep["improved_n"] == 1
    assert rep["unchanged_n"] == 1
    assert rep["regression_rate"] == pytest.approx(1 / 3)
    assert rep["delta"] == pytest.approx(0.1)


# ── MemoryInducedRegressionRate ────────────────────────────────────────


def test_memory_induced_regression_same_day_pairing(tmp_path):
    rows = [
        _row(1, "ta", arm="experiment", score=0.4),
        _row(1, "ta", arm="control", score=0.8),   # ON < OFF − 0.1 → regressed
        _row(1, "tb", arm="experiment", score=0.9),
        _row(1, "tb", arm="control", score=0.7),   # 不回归
        _row(3, "tc", arm="experiment", score=0.5),  # 无对照臂日 → 不配对
        _row(7, "tx", arm="x2", score=0.3),
        _row(7, "tx", arm="x3", score=0.6),        # 四臂日 x2 vs x3 → regressed
        _row(7, "ty", arm="x2", score=0.8),
        _row(7, "ty", arm="x3", score=0.7),        # 不回归
        _row(7, "tz", arm="x1", score=0.2),        # x1/x4 不参与 ON/OFF 差分
        _row(7, "tz", arm="x4", score=0.2),
    ]
    rep = mv.regression(rows)["memory_induced"]
    assert rep["paired_n"] == 4
    assert rep["regressed_n"] == 2
    assert rep["regression_rate"] == pytest.approx(0.5)
    assert rep["by_day"]["1"]["regression_rate"] == pytest.approx(0.5)
    assert rep["by_day"]["7"]["regression_rate"] == pytest.approx(0.5)
    assert rep["by_day"]["3"]["paired_n"] == 0
    assert rep["delta"] == pytest.approx(0.1)


# ── UsefulHitRate / FalseHitRate ───────────────────────────────────────


def test_transfer_hits_paired_and_arm_mean_approximation(tmp_path):
    db = tmp_path / "experience.db"
    _trace_db(db, [
        {"task_id": "ta", "hit": 1},   # paired：useful
        {"task_id": "ta", "hit": 1},
        {"task_id": "tb", "hit": 1},   # paired：false（负迁移）
        {"task_id": "tc", "hit": 1},   # 无 OFF 行 → 臂均值近似
        {"task_id": "td", "hit": 0},   # 非 hit
        {"task_id": "tx", "hit": 1},   # 无任何行 → unclassified
    ])
    rows = [
        _row(1, "ta", arm="experiment", score=0.8),
        _row(1, "ta", arm="control", score=0.5),   # 0.8 ≥ 0.5−0.1 → useful
        _row(1, "tb", arm="experiment", score=0.3),
        _row(1, "tb", arm="control", score=0.8),   # 0.3 < 0.8−0.1 → false
        _row(1, "tc", arm="experiment", score=0.7),  # OFF≈control 均值 0.65 → useful
    ]
    rep = mv.transfer_hits(rows, mv._load_traces(db))
    assert rep["hit_true_n"] == 4
    assert rep["classified_n"] == 3
    assert rep["paired_n"] == 2
    assert rep["approximated_n"] == 1
    assert rep["unclassified_n"] == 1
    assert rep["useful_n"] == 2
    assert rep["false_n"] == 1
    assert rep["useful_hit_rate"] == pytest.approx(2 / 3)
    assert rep["false_hit_rate"] == pytest.approx(1 / 3)
    by_task = {t["task_id"]: t for t in rep["by_task"]}
    assert by_task["ta"]["useful"] is True and by_task["ta"]["approx"] == "none"
    assert by_task["tb"]["useful"] is False and by_task["tb"]["approx"] == "none"
    assert by_task["tc"]["useful"] is True and by_task["tc"]["approx"] == "off"


def test_transfer_hits_no_trace_db_degrades(tmp_path):
    rows = [_row(1, "ta", arm="experiment", score=0.8)]
    rep = mv.transfer_hits(rows, None)
    assert rep["hit_true_n"] == 0
    assert rep["classified_n"] == 0
    assert rep["note"]  # 降级说明非空


# ── Functional vs Judge 分层 ───────────────────────────────────────────


def test_functional_judge_breakdown_grouping(tmp_path):
    rows = [
        _row(1, "fa", arm="experiment", breakdown={
            "automated.a1": 1.0, "automated.a2": 1.0, "llm_judge.J1": 0.8,
        }),  # hard pass；judge 0.8 → 不背离
        _row(1, "fb", arm="experiment", breakdown={
            "automated.a1": 1.0, "automated.a2": 0.0, "llm_judge.J1": 0.6,
        }),  # functional 0.5，非 hard pass，judge≥0.5 → 背离
        _row(1, "fc", arm="control", breakdown={"automated.a1": 0.5}),  # 无 judge 项
        _row(1, "fd", arm="experiment"),                                # 无 breakdown
        _row(1, "fe", arm="experiment", breakdown={"llm_judge.J1": 0.9}),  # 无 automated 项
    ]
    rep = mv.functional_judge(rows)
    assert rep["functional_n"] == 3
    assert rep["judge_n"] == 3
    assert rep["no_breakdown_n"] == 2
    assert rep["functional_score_mean"] == pytest.approx((1.0 + 0.5 + 0.5) / 3)
    assert rep["judge_score_mean"] == pytest.approx((0.8 + 0.6 + 0.9) / 3)
    assert rep["hard_pass_n"] == 1
    assert rep["functional_success_rate"] == pytest.approx(1 / 3)
    div = rep["divergence"]
    assert [d["task_id"] for d in div] == ["fb"]
    assert div[0]["judge_score"] == pytest.approx(0.6)
    assert div[0]["functional_score"] == pytest.approx(0.5)
    assert rep["by_day"]["1"]["functional_success_rate"] == pytest.approx(1 / 3)
    assert rep["by_arm"]["experiment"]["hard_pass_n"] == 1


def test_functional_partial_automated_breakdown_participates(tmp_path):
    # breakdown 缺部分 automated 键的行仍参与：现存键均值 + HardPass 判定
    # （"automated.* 均值"口径对缺键行存在高估方向——只余 1.0 键的行判 HardPass）。
    rows = [
        _row(1, "fa", arm="experiment", breakdown={"automated.a1": 1.0}),  # 缺 a2 键
        _row(1, "fb", arm="experiment", breakdown={"automated.a1": 0.0, "automated.a2": 1.0}),
    ]
    rep = mv.functional_judge(rows)
    assert rep["functional_n"] == 2
    assert rep["hard_pass_n"] == 1  # fa 仅存 1.0 键也判 HardPass（缺键行带偏方向）
    assert rep["functional_score_mean"] == pytest.approx((1.0 + 0.5) / 2)


def test_functional_judge_all_groups_empty(tmp_path):
    rep = mv.functional_judge([])
    assert rep["functional_n"] == 0
    assert rep["functional_score_mean"] is None
    assert rep["functional_success_rate"] == pytest.approx(0.0)


# ── 难度分层 ───────────────────────────────────────────────────────────


def test_difficulty_tiers_and_memory_gain(tmp_path):
    rows = [
        _row(1, "task_easy_thing", arm="experiment", score=0.7),
        _row(7, "task_easy_thing", arm="x2", score=0.9),
        _row(1, "task_mid", arm="experiment", score=0.5),
        _row(7, "task_mid", arm="x2", score=0.4),
        _row(1, "task_hard", arm="experiment", score=0.2),
        _row(7, "task_hard", arm="x2", score=0.3),
        _row(1, "task_easy_only_d1", arm="experiment", score=0.65),  # 无 D7 → 不计增益
        _row(1, "task_dsl_flow", arm="experiment", score=0.5),       # 关键词 dsl
        _row(7, "task_dsl_flow", arm="x2", score=0.4),
        _row(1, "workflow_task", arm="experiment", score=0.7),       # 关键词 workflow
        _row(7, "workflow_task", arm="x2", score=0.9),
        _row(1, "multi_agent_x", arm="experiment", score=0.2),       # 关键词 multi
        _row(7, "multi_agent_x", arm="x2", score=0.3),
    ]
    rep = mv.difficulty_layers(rows)
    tiers = rep["tiers"]
    assert tiers["easy"]["n"] == 3      # task_easy_thing + task_easy_only_d1 + workflow_task(0.7)
    assert tiers["easy"]["memory_gain"] == pytest.approx(0.2)   # 仅配对任务：0.9−0.7 ×2
    assert tiers["medium"]["n"] == 2    # task_mid + task_dsl_flow(0.5)
    assert tiers["medium"]["memory_gain"] == pytest.approx(-0.1)
    assert tiers["hard"]["n"] == 2      # task_hard + multi_agent_x（0.2）
    assert tiers["hard"]["memory_gain"] == pytest.approx(0.1)
    kw = rep["keywords"]
    assert kw["dsl"]["n"] == 1 and kw["dsl"]["memory_gain"] == pytest.approx(-0.1)
    assert kw["workflow"]["memory_gain"] == pytest.approx(0.2)
    assert kw["multi"]["memory_gain"] == pytest.approx(0.1)
    assert rep["tier_boundaries"] == {"easy": 0.6, "medium": 0.3}


def test_difficulty_tier_boundaries(tmp_path):
    # easy ≥ 0.6；medium 0.3 ≤ s < 0.6；hard < 0.3。
    rows = [
        _row(1, "s060", arm="experiment", score=0.6),
        _row(1, "s059", arm="experiment", score=0.59),
        _row(1, "s030", arm="experiment", score=0.3),
        _row(1, "s029", arm="experiment", score=0.29),
    ]
    rep = mv.difficulty_layers(rows)
    assert rep["tiers"]["easy"]["n"] == 1
    assert rep["tiers"]["medium"]["n"] == 2
    assert rep["tiers"]["hard"]["n"] == 1


# ── TreatmentCompliance ────────────────────────────────────────────────


def test_treatment_compliance_ok_violation_unverifiable(tmp_path):
    db = tmp_path / "experience.db"
    _trace_db(db, [
        {"task_id": "ta", "hit": 0, "injected_tokens": 0, "injected_ids": []},   # 零注入 ×3
        {"task_id": "ta", "hit": 0, "injected_tokens": 0, "injected_ids": []},
        {"task_id": "ta", "hit": 1, "injected_tokens": 0, "injected_ids": []},
        {"task_id": "ta", "hit": 1, "injected_tokens": 120, "injected_ids": ["c1"]},  # ON 臂痕迹（x2）
        {"task_id": "tb", "hit": 1, "injected_tokens": 90, "injected_ids": ["c2"]},   # 全非零 → 违规
        {"task_id": "tb", "hit": 1, "injected_tokens": 90, "injected_ids": ["c2"]},
    ])
    four_arm = []
    for t in ("ta", "tb", "tc"):
        for arm in ("x1", "x2", "x3", "x4"):
            four_arm.append(_row(7, t, arm=arm, score=0.6, requests=5, termination_reason="completed"))
    rep = mv.treatment_compliance(four_arm, mv._load_traces(db))
    assert rep["n"] == 3          # 作用域任务数（x3/x4 行出现的任务）
    assert rep["checked_tasks"] == 2
    assert rep["ok_n"] == 1       # ta：存在零注入痕迹
    assert rep["violation_n"] == 1  # tb：全部痕迹非零
    assert rep["unverifiable_n"] == 1  # tc：无痕迹
    assert rep["compliance_rate"] == pytest.approx(0.5)
    assert [v["task_id"] for v in rep["violations"]] == ["tb"]
    assert rep["violations"][0]["zero_n"] == 0
    assert rep["violations"][0]["nonzero_n"] == 2


def test_treatment_compliance_no_four_arm_data_not_fail(tmp_path):
    rows = [_row(1, "ta", arm="experiment", score=0.8)]
    rep = mv.treatment_compliance(rows, [])
    assert rep["n"] == 0
    assert rep["compliance_rate"] is None
    assert rep["violations"] == []


# ── economics（T10）────────────────────────────────────────────────────


def test_economics_amortized_teacher_cost_and_total(tmp_path):
    ledger = tmp_path / "usage.jsonl"
    _ledger(ledger, [
        {"ts": "2026-08-19T00:00:00Z", "model": "deepseek-v4-pro", "prompt_tokens": 1000,
         "completion_tokens": 500, "caller": "skill_evolution"},
        {"ts": "2026-08-19T00:00:01Z", "model": "deepseek-v4-pro", "prompt_tokens": 2000,
         "completion_tokens": 1000, "caller": "verification_selection"},
        {"ts": "2026-08-19T00:00:02Z", "model": "other-model", "prompt_tokens": 9999,
         "completion_tokens": 9999, "caller": "x"},  # 非 teacher 模型不计摊销
    ])
    edb = tmp_path / "experience.db"
    _trace_db(edb, [
        {"task_id": "ta", "hit": 1},  # ta score 0.8 ≥ 0.5 → successful reuse ×3
        {"task_id": "ta", "hit": 1},
        {"task_id": "ta", "hit": 1},
        {"task_id": "tb", "hit": 1},  # tb score 0.2 → 不计
        {"task_id": "ta", "hit": 0},
    ])
    gdb = tmp_path / "gateway.db"
    _gateway_db(gdb, [
        {"purpose": "escalation", "state": "succeeded", "cost_micro_usd": 100_000},
        {"purpose": "escalation", "state": "succeeded", "cost_micro_usd": 50_000},
        {"purpose": "escalation", "state": "failed", "cost_micro_usd": 10_000},
        {"purpose": "primary", "state": "succeeded", "cost_micro_usd": 10_000},
    ])
    rows = [
        _row(1, "ta", arm="experiment", score=0.8),
        _row(1, "tb", arm="experiment", score=0.2),
    ]
    traces = mv._load_traces(edb)
    rep = mv.economics(rows, traces, gdb, ledger)
    teacher_cost = 3000 * 0.435e-6 + 1500 * 0.87e-6
    assert rep["teacher_total_cost_usd"] == pytest.approx(teacher_cost)
    assert rep["teacher_tokens"] == {"prompt": 3000, "completion": 1500, "calls": 2}
    assert rep["successful_reuse_count"] == 3
    assert rep["amortized_teacher_cost_usd"] == pytest.approx(teacher_cost / 3)
    assert rep["student_inference"]["cost_usd"] == pytest.approx(0.0)
    assert rep["student_inference"]["prompt_tokens"] == 5 * 100  # 5 条 trace 的 fixture 默认
    assert rep["escalation"]["runs"] == 2
    assert rep["escalation"]["cost_usd"] == pytest.approx(0.15)
    assert rep["infra"]["cost_usd"] == pytest.approx(0.0)
    assert rep["total_system_cost_usd"] == pytest.approx(0.15 + teacher_cost / 3)
    assert rep["price_table"]["input_usd_per_token"] == pytest.approx(0.435e-6)
    assert rep["price_table"]["output_usd_per_token"] == pytest.approx(0.87e-6)


def test_economics_zero_reuse_denominator(tmp_path):
    ledger = tmp_path / "usage.jsonl"
    _ledger(ledger, [
        {"ts": "t", "model": "deepseek-v4-pro", "prompt_tokens": 100, "completion_tokens": 10,
         "caller": "c"},
    ])
    edb = tmp_path / "experience.db"
    _trace_db(edb, [{"task_id": "ta", "hit": 0}])  # 无 hit=true → 零复用
    gdb = tmp_path / "gateway.db"
    _gateway_db(gdb, [])
    rows = [_row(1, "ta", arm="experiment", score=0.8)]
    rep = mv.economics(rows, mv._load_traces(edb), gdb, ledger)
    assert rep["successful_reuse_count"] == 0
    assert rep["amortized_teacher_cost_usd"] is None
    assert "零复用" in rep["amortized_note"]
    assert rep["teacher_total_cost_usd"] == pytest.approx(100 * 0.435e-6 + 10 * 0.87e-6)


def test_trace_loader_old_schema_returns_unsupported(tmp_path):
    # 打回 5.3：旧 schema 库（T4 迁移前，缺 injected_tokens 等列——27b 备份/c-d4 快照
    # 同构）不得裸崩；_load_traces 返回 schema_unsupported 标记，compliance 输出
    # schema_unsupported 且不计违规。
    db = tmp_path / "old-schema.db"
    con = sqlite3.connect(db)
    con.execute(
        "CREATE TABLE request_traces (request_id TEXT, ts TEXT, model TEXT, stream INTEGER,"
        " retrieved_count INTEGER, retrieved_ids TEXT, retrieved_kinds TEXT, hit INTEGER,"
        " finish_reason TEXT, prompt_tokens INTEGER, completion_tokens INTEGER,"
        " latency_ms INTEGER, error TEXT, injected_ids TEXT, task_id TEXT)"
    )
    con.execute("INSERT INTO request_traces (request_id, task_id, hit) VALUES ('r1', 'ta', 1)")
    con.commit()
    con.close()
    traces = mv._load_traces(db)
    assert isinstance(traces, dict) and traces.get("schema_unsupported") is True
    assert "injected_tokens" in traces["missing_columns"]
    # compliance 不 crash、不计违规
    four_arm = []
    for arm in ("x1", "x2", "x3", "x4"):
        four_arm.append(_row(7, "ta", arm=arm, score=0.6))
    rep = mv.treatment_compliance(four_arm, traces)
    assert rep["schema_unsupported"] is True
    assert rep["violations"] == []
    assert rep["violation_n"] == 0
    # transfer / economics 同步降级不炸
    rows = [_row(1, "ta", arm="experiment", score=0.8)]
    tr = mv.transfer_hits(rows, traces)
    assert tr["classified_n"] == 0 and tr["note"]
    eco = mv.economics(rows, traces, tmp_path / "no-gateway.db", tmp_path / "no-ledger.jsonl")
    assert eco["student_inference"]["prompt_tokens"] == 0
    assert eco["successful_reuse_count"] == 0


def test_economics_escalation_null_cost_rows_noted(tmp_path):
    # 真实网关形态：escalation 成功行 cost_micro_usd 全 NULL → 按 0 计并在 note 注明。
    gdb = tmp_path / "gateway.db"
    _gateway_db(gdb, [{"purpose": "escalation", "state": "succeeded", "cost_micro_usd": None}])
    edb = tmp_path / "experience.db"
    _trace_db(edb, [{"task_id": "ta", "hit": 0}])
    rows = [_row(1, "ta", arm="experiment", score=0.8)]
    rep = mv.economics(rows, mv._load_traces(edb), gdb, tmp_path / "no-ledger.jsonl")
    assert rep["escalation"]["runs"] == 1
    assert rep["escalation"]["cost_usd"] == 0.0
    assert "NULL" in rep["escalation"]["note"]


def test_economics_missing_ledger_degrades(tmp_path):
    edb = tmp_path / "experience.db"
    _trace_db(edb, [{"task_id": "ta", "hit": 0}])
    gdb = tmp_path / "gateway.db"
    _gateway_db(gdb, [])
    rows = [_row(1, "ta", arm="experiment", score=0.8)]
    rep = mv.economics(rows, mv._load_traces(edb), gdb, tmp_path / "no-such-usage.jsonl")
    assert rep["teacher_total_cost_usd"] == pytest.approx(0.0)
    assert rep["ledger_note"]  # 说明台账缺失


def test_economics_missing_dbs_degrade(tmp_path):
    rows = [_row(1, "ta", arm="experiment", score=0.8)]
    rep = mv.economics(rows, None, tmp_path / "no-gateway.db", tmp_path / "no-ledger.jsonl")
    assert rep["escalation"]["runs"] == 0
    assert rep["student_inference"]["prompt_tokens"] == 0
    assert rep["successful_reuse_count"] == 0


# ── context_budget（评审§九）───────────────────────────────────────────


def test_context_budget_by_day_ratios_and_percentiles(tmp_path):
    # MemoryTokenRatio = injected_tokens/prompt_tokens 按 ts 日期分组；
    # prompt_tokens 缺失/为 0 跳过计数；ts 缺失归 unknown 仅计数。
    db = tmp_path / "exp.db"
    _trace_db(db, [
        {"task_id": "ta", "injected_tokens": 10, "prompt_tokens": 100,
         "injected_ids": ["c1", "c2"], "ts": "2026-08-19T01:00:00Z"},  # ratio 0.1
        {"task_id": "ta", "injected_tokens": 50, "prompt_tokens": 100,
         "ts": "2026-08-19T02:00:00Z"},                                   # ratio 0.5
        {"task_id": "tb", "injected_tokens": 0, "prompt_tokens": 100,
         "ts": "2026-08-20T00:00:00Z"},                                   # ratio 0.0
        {"task_id": "tb", "injected_tokens": 5, "prompt_tokens": 0,
         "ts": "2026-08-20T00:00:00Z"},                                   # prompt 0 → skipped
        {"task_id": "tb", "injected_tokens": 5, "prompt_tokens": None,
         "ts": "2026-08-20T00:00:00Z"},                                   # prompt 缺失 → skipped
        {"task_id": "ta", "injected_tokens": 5, "prompt_tokens": 100,
         "ts": None},                                                      # ts 缺失 → unknown 日
    ])
    rows = [_row(1, "ta", score=0.8), _row(1, "tb", score=0.4)]
    rep = mv.context_budget(rows, mv._load_traces(db))
    assert rep["n"] == 4
    assert rep["skipped_n"] == 2
    assert rep["unknown_day_n"] == 1
    d19 = rep["by_day"]["2026-08-19"]
    assert d19["n"] == 2
    assert d19["ratio_mean"] == pytest.approx(0.3)
    assert d19["ratio_p50"] == pytest.approx(0.3)    # [0.1, 0.5] 线性插值
    assert d19["ratio_p90"] == pytest.approx(0.46)
    assert d19["injected_count_mean"] == pytest.approx(1.0)  # [2, 0]
    d20 = rep["by_day"]["2026-08-20"]
    assert d20["n"] == 1 and d20["ratio_mean"] == pytest.approx(0.0)
    assert "unknown" not in rep["by_day"]


def test_context_budget_score_buckets(tmp_path):
    # Score=f(MemoryTokenRatio) 四分桶（边界 0/0.1/0.2/0.3，含下不含上；探索性倒 U 猜想）。
    db = tmp_path / "exp.db"
    _trace_db(db, [
        {"task_id": "ta", "injected_tokens": 0, "prompt_tokens": 100},   # 0.0 → [0,0.1)
        {"task_id": "tb", "injected_tokens": 5, "prompt_tokens": 100},   # 0.05 → [0,0.1)
        {"task_id": "tc", "injected_tokens": 15, "prompt_tokens": 100},  # 0.15 → [0.1,0.2)
        {"task_id": "td", "injected_tokens": 25, "prompt_tokens": 100},  # 0.25 → [0.2,0.3)
        {"task_id": "te", "injected_tokens": 35, "prompt_tokens": 100},  # 0.35 → [0.3,inf)
        {"task_id": "tf", "injected_tokens": 30, "prompt_tokens": 100},  # 0.3 → [0.3,inf)（含下）
        {"task_id": "tg", "injected_tokens": 5, "prompt_tokens": 100},   # 无 run 行 → bucket_skipped
    ])
    rows = [
        _row(1, "ta", score=0.8), _row(1, "tb", score=0.6), _row(1, "tc", score=0.9),
        _row(1, "td", score=0.3), _row(1, "te", score=0.7), _row(1, "tf", score=0.2),
    ]
    rep = mv.context_budget(rows, mv._load_traces(db))
    sb = rep["score_buckets"]
    assert sb["boundaries"] == [0.0, 0.1, 0.2, 0.3]
    b = sb["buckets"]
    assert b["[0,0.1)"]["n"] == 2 and b["[0,0.1)"]["mean_score"] == pytest.approx(0.7)
    assert b["[0.1,0.2)"]["n"] == 1 and b["[0.1,0.2)"]["mean_score"] == pytest.approx(0.9)
    assert b["[0.2,0.3)"]["n"] == 1 and b["[0.2,0.3)"]["mean_score"] == pytest.approx(0.3)
    assert b["[0.3,inf)"]["n"] == 2 and b["[0.3,inf)"]["mean_score"] == pytest.approx(0.45)
    assert sb["bucket_skipped_n"] == 1
    assert "倒 U" in sb["note"]


def test_context_budget_old_schema_and_missing_db_degrades(tmp_path):
    # 旧 schema 库（5.3 路径）与库缺失：context_budget 降级不崩。
    old = tmp_path / "old.db"
    con = sqlite3.connect(old)
    con.execute("CREATE TABLE request_traces (request_id TEXT, task_id TEXT, hit INTEGER)")
    con.commit()
    con.close()
    rep = mv.context_budget([], mv._load_traces(old))
    assert rep["schema_unsupported"] is True
    assert rep["n"] == 0
    rep2 = mv.context_budget([], None)
    assert rep2["n"] == 0 and rep2["note"]


# ── analyze() 集成 ─────────────────────────────────────────────────────


def test_analyze_full_report(tmp_path):
    db = tmp_path / "experience.db"
    _trace_db(db, [{"task_id": "ta", "hit": 1}])
    gdb = tmp_path / "gateway.db"
    _gateway_db(gdb, [])
    rows = [_row(1, "ta", arm="experiment", score=0.8)]
    docs = [_transcript_doc(1, "experiment", "ta", 3)]
    _write_run(tmp_path, rows, docs)
    rep = mv.analyze(tmp_path, gateway_db=gdb, experience_db=db, usage_ledger=tmp_path / "u.jsonl")
    assert set(rep) == {
        "run_id", "success_at_k", "migration", "regression", "transfer",
        "functional", "difficulty", "compliance", "economics", "context_budget",
    }
    assert rep["success_at_k"]["total"]["k5"] == pytest.approx(1.0)
    assert rep["migration"]["paired_n"] == 1
    assert rep["compliance"]["n"] == 0
    assert "amortized_teacher_cost_usd" in rep["economics"]
    assert rep["context_budget"]["by_day"]["2026-08-19"]["n"] == 1


def test_analyze_missing_run_jsonl_degrades(tmp_path):
    # pilot-9b-addendum 形态：无 run.jsonl/transcripts → n=0 全降级报告。
    (tmp_path / "pilot.json").write_text("[]")
    rep = mv.analyze(tmp_path, gateway_db=None, experience_db=None, usage_ledger=None)
    assert rep["run_id"] == tmp_path.name
    assert rep["success_at_k"]["total"]["tasks"] == 0
    assert rep["migration"]["paired_n"] == 0
    assert rep["economics"]["student_inference"]["prompt_tokens"] == 0
