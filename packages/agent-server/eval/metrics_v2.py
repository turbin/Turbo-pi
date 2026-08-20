#!/usr/bin/env python3
"""D 阶段 Analysis Addendum v2 离线分析包（T6+T10，评审 §四/十二/十三/二/五/十一/十/十六）。

预注册口径（doc/design/plans/2026-08-19-d-stage-addendum-v2-dev-tasks.md §1.1/§1.5，
本文为准；评审章节引用 doc/design/D阶段实验设计补充评审_指标与条件检查.md）：
  成功口径        score >= 0.5（PASS_THRESHOLD，与 campaign.py / trajectory_metrics.py 同值）。
  触顶口径        termination_reason == "max_turns"（preview.html §8.1 严格口径）；
                  旧行（无该键）fallback requests >= 30 并在输出标注 fallback 行数。
  D1 / D7         D1 = 结果中最小 day，D7 = 最大 day（与 campaign_metrics.check_criteria
                  的"final day present"同思路；D7 = 最后日）。D7 实验等效臂 = arm "x2"
                  （四臂日，campaign_cross：X2 = 当日库+注入开 = 原实验臂口径），
                  无 x2 行时回退 "experiment"；D1 实验臂 = "experiment"，无则回退 "x2"。
  ON / OFF 臂     ON = {experiment, x2}；OFF = {control, x3}（x1/x4 冻结臂不参与差分）。

1. Success@K（评审§四）：K∈{5,10,15,20,30}；成功 = score>=0.5 且 rounds<=K（"第 K 轮前"含
   第 K 轮）；rounds = transcript assistant 回合数（复用 trajectory_metrics.parse_rounds）；
   缺 transcript 或缺 score 的任务行计 unknown 并计数；比率分母 = 有 score 的行数。
   输出按日/臂分组。

2. 失败迁移矩阵（评审§十二）+ RecoveryConversionRate：kind=="repeat" 任务（kind 缺失按
   repeat 容错，campaign_cross 同款）按 task_id 配 D1→D7 四象限迁移计数：
     EfficientSuccess = 成功∧¬触顶 / BoundarySuccess = 成功∧触顶 /
     EarlyFailure     = 失败∧¬触顶 / ExhaustedFailure = 失败∧触顶。
   RecoveryConversion = P(D7∈{Efficient,Boundary}Success | D1=ExhaustedFailure)——
   评审原文为 EfficientSuccess，任务书扩展含 Boundary，输出分列 efficient_only 与
   efficient_or_boundary 两口径。

3. RegressionRate（评审§十三）：δ=0.1 预注册（DELTA，严格小于）；
   P(score_D7 < score_D1 − δ)，D1→D7 逐任务配对（实验等效臂）；同报 improved/unchanged/
   regressed 计数（|diff|<=δ 为 unchanged）。
   MemoryInducedRegressionRate（评审§二/十三）= 同日 ON/OFF 配对
   P(score_ON < score_OFF − δ)：双臂日 experiment vs control；四臂日 x2 vs x3。

4. UsefulHitRate / FalseHitRate（评审§二，任务级近似口径）：
   hit=true 任务（experience.db request_traces 中 hit=1 的 task_id 集合）按 (日, 任务)
   的 ON/OFF 差分分类：score_ON >= score_OFF − δ → useful；score_ON < score_OFF − δ →
   false（负迁移）。配对缺失（该日缺 ON 或缺 OFF 行）按同日臂均值近似并标注
   approximated（无同日均值时用全期臂均值；仍无则 unclassified）。分母 = 分类实例数。

5. Functional vs Judge 分层（评审§五）：grading.breakdown 按键前缀分组——
   "automated." 项均值 = FunctionalScore（HardPass = 全部 automated 子项 == 1.0，
   无 automated 项的行不参与 functional 统计）；"llm_judge." 项均值 = JudgeScore。
   FunctionalSuccessRate = HardPass 占比；Judged↔Functional 背离清单 =
   JudgeScore >= 0.5 ∧ ¬HardPass 的任务。

6. 难度分层（评审§十一）：按 D1 实验臂 baseline score 三档——easy >= 0.6 /
   medium 0.3 <= s < 0.6 / hard < 0.3（仅用实验前信息）；另按 task_id 含
   dsl/workflow/multi 关键词辅层（小写包含匹配）。分层报 MemoryGain = 实验臂
   D7 − D1 均分差（该层内同时有 D1/D7 行的任务）。

7. TreatmentCompliance（评审§十）：四臂日（arm∈{x1,x2,x3,x4}）X3/X4 行的
   request_traces（experience.db，task_id join——request_traces 无 arm 列，粗粒度
   join 为任务书口径）须 injected_tokens==0 且 injected_ids==[]。离线判定（task 级）：
   该任务存在 >=1 条零注入痕迹 → ok（OFF 臂未注入的证据；非零痕迹属 X1/X2 ON 臂，
   预期存在）；全部痕迹非零 → 违规（OFF 臂全程注入或痕迹落错库，两者均为接线问题）；
   无任何痕迹 → unverifiable（计数，不判违规）。compliance_rate = ok/(ok+violation)；
   无四臂数据输出 n=0、compliance_rate=None（不 fail）。X1/X4 冻结实例
   （--frozen-base-url）与模型指纹（AGENT_EVAL_EXPECTED_OMLX_MODEL）为运行时
   接线/preflight 校验项，离线库无可复核字段，输出 notes 注明不在此断言。
   **旧 schema 库（T4 迁移前，request_traces 缺 injected_tokens 等列——27b 备份 /
   c-d4 快照同构）**：_load_traces 先 PRAGMA table_info 探测必需列，缺列时返回
   schema_unsupported 标记，各消费节降级 n=0 且 compliance 输出 schema_unsupported
   （不计违规不 crash，2026-08-19 pi-test 复核 5.3 修复）。

8. economics（T10，评审§十六）：teacher usage 台账
   var/eval/evolution-usage.jsonl（env EVOLUTION_USAGE_LEDGER 覆盖；离线进化管线的
   python/ 各 llm_client.py OpenAICompatClient 每次成功调用追写一行
   {ts, model, prompt_tokens, completion_tokens, caller}）。摊销：
     AmortizedTeacherCost = Σ(teacher tokens)×单价 / SuccessfulReuseCount
     SuccessfulReuseCount = request_traces 中 hit=true 且任务 score>=0.5 的计数
       （任务 score = run.jsonl 该 task_id 最新日行，实验等效臂优先——近似口径，输出注明）
     单价表（预注册常量，2026-07-30，doc/design/plans/2026-07-30-eval-benchmark-pivot-plan.md
       "$0.435/$0.87"；litellm model_prices_and_context_window_backup.json 同值，
       来源 https://api-docs.deepseek.com/quick_start/pricing）：
       deepseek-v4-pro input $0.435/M tokens、output $0.87/M tokens。
     TotalSystemCost = StudentInference（request_traces prompt+completion tokens；
       9B 本地 omlx 推理成本计 0，仅计量）+ Escalation（gateway model_runs
       purpose=escalation 且 state=succeeded 的 cost_micro_usd 合计；网关无定价数据时
       记为 0，注明）+ AmortizedTeacher + Infra（0 占位注明）。
     零复用分母时 amortized=None 并注明；台账缺失时 teacher 成本记 0 并注明。

9. context_budget（评审§九 Context Budget，2026-08-19 主会话 review 补项）：
   9B 对长 context 中的无关信息比 27B 更敏感——注入 Memory 的副作用是
   ContextLength↑、Attention 被稀释，Score=f(MemoryTokenRatio) 可能非单调
   （评审§九倒 U 猜想：存在最优注入量）。
   MemoryTokenRatio = injected_tokens / prompt_tokens（每请求，request_traces
   T4 已采列）；InjectedMemoryCount = injected_ids 长度。按 ts 日期分组
   （request_traces 无 day 列，ts 日期为自然日近似，非逻辑实验日）报
   {mean, p50, p90, n}（p50/p90 = trajectory_metrics._percentile 线性插值）；
   分母 prompt_tokens 缺失/为 0 的请求跳过并计数（loader 层 NULL/缺失归一为 0）；
   ts 无法解析的请求归 unknown 仅计数。旧 schema 库（5.3 的
   schema_unsupported 路径）同样降级 n=0 不崩。
   Score=f(MemoryTokenRatio) 四分桶对照（预注册边界 0/0.1/0.2/0.3+，含下不含上；
   探索性报表，非单调假设不做断言）：桶均分 = 桶内请求任务 score
   （_latest_task_score，最新日实验等效臂）均值；无 run 行的请求计
   bucket_skipped_n。

CLI：
    ./.venv/bin/python metrics_v2.py results/<run_id> \
        [--gateway-db PATH] [--experience-db PATH] [--usage-ledger PATH]

输出 JSON：{run_id, success_at_k, migration, regression, transfer, functional,
difficulty, compliance, economics}；比率分母为零记 0.0，均值无样本记 None。
"""

import argparse
import json
import sqlite3
import sys
from pathlib import Path

from campaign_metrics import load_results
from trajectory_metrics import _is_capped, _load_transcripts, _percentile, parse_rounds

PASS_THRESHOLD = 0.5  # 成功口径，与 campaign.py 同值
DELTA = 0.1  # 回归/负迁移阈值（预注册，评审§二/十三）
SUCCESS_AT_K = [5, 10, 15, 20, 30]  # 预注册（评审§四）
ON_ARMS = {"experiment", "x2"}
OFF_ARMS = {"control", "x3"}
FOUR_ARMS = {"x1", "x2", "x3", "x4"}
TIER_EASY = 0.6  # 难度分层边界（评审§十一）：easy >= 0.6
TIER_MEDIUM = 0.3  # medium 0.3 <= s < 0.6；hard < 0.3
DIFFICULTY_KEYWORDS = ("dsl", "workflow", "multi")
TEACHER_MODEL_NAME = "deepseek-v4-pro"  # 预注册教师模型名（任务书 §1.3 同款）
# deepseek-v4-pro 公示价（2026-07-30 预注册，$/token；$0.435/M in / $0.87/M out）
TEACHER_INPUT_PRICE_PER_TOKEN = 0.435e-6
TEACHER_OUTPUT_PRICE_PER_TOKEN = 0.87e-6
QUADRANTS = ("EfficientSuccess", "BoundarySuccess", "EarlyFailure", "ExhaustedFailure")


# ── 通用工具 ───────────────────────────────────────────────────────────


def _experiment_rows(rows: list[dict], day: int, prefer_x2: bool = False) -> list[dict]:
    """某日实验等效臂行：D1（首日）优先 experiment，缺则回退 x2；D7（末日）优先
    x2（四臂日 X2 = 原实验臂口径，campaign_cross），缺则回退 experiment——
    与任务书 §1.1 预注册一致（2026-08-19 pi-test 复核 5.1 修复：同日双臂共存时按日取）。"""
    day_rows = [r for r in rows if r.get("day") == day]
    if prefer_x2:
        exp = [r for r in day_rows if r.get("arm") == "x2"]
        if not exp:
            exp = [r for r in day_rows if r.get("arm") == "experiment"]
    else:
        exp = [r for r in day_rows if r.get("arm") == "experiment"]
        if not exp:
            exp = [r for r in day_rows if r.get("arm") == "x2"]
    return exp


def _quadrant(row: dict) -> str:
    """四象限（评审§十二）：成功=score>=0.5；触顶=termination_reason=="max_turns"，
    旧行 fallback requests>=30（preview.html §8.1）；score 缺失按 0（保守为失败）。"""
    score = row.get("score", 0.0)
    capped, _ = _is_capped(row)
    success = score >= PASS_THRESHOLD
    if success and not capped:
        return "EfficientSuccess"
    if success and capped:
        return "BoundarySuccess"
    if not success and not capped:
        return "EarlyFailure"
    return "ExhaustedFailure"


# request_traces 读取必需列（T4 迁移后 schema；旧库缺列 → schema_unsupported 标记）
REQUIRED_TRACE_COLUMNS = (
    "request_id", "task_id", "hit", "injected_tokens", "injected_ids",
    "prompt_tokens", "completion_tokens", "ts",
)
# Score=f(MemoryTokenRatio) 四分桶边界（预注册，评审§九；含下不含上）
RATIO_BUCKET_BOUNDARIES = (0.0, 0.1, 0.2, 0.3)
SCORE_BUCKET_NOTE = (
    "探索性报表（评审§九）：9B 对长 context 中无关信息更敏感，"
    "Score=f(MemoryTokenRatio) 可能非单调（倒 U 猜想，存在最优注入量）；"
    "桶边界含下不含上，不做方向性断言。"
)


def _load_traces(experience_db: Path | None) -> list[dict] | dict | None:
    """experience.db request_traces → list[dict]；库缺失返回 None（各节降级 n=0）。
    旧 schema 库（缺 REQUIRED_TRACE_COLUMNS 任一列，T4 迁移前——27b 备份/c-d4 快照
    同构）返回 {"schema_unsupported": True, "missing_columns": [...]} 标记，
    各消费节降级 n=0 不 crash（pi-test 复核 5.3 修复）；库存在但缺 request_traces
    表 fail loud。"""
    if experience_db is None or not experience_db.exists():
        return None
    con = sqlite3.connect(f"file:{experience_db}?mode=ro", uri=True)
    try:
        has_table = con.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='request_traces'"
        ).fetchall()
        if not has_table:
            raise ValueError(f"experience database {experience_db} has no request_traces table")
        cols = {row[1] for row in con.execute("PRAGMA table_info(request_traces)")}
        missing = [c for c in REQUIRED_TRACE_COLUMNS if c not in cols]
        if missing:
            return {"schema_unsupported": True, "missing_columns": missing}
        raw = con.execute(
            "SELECT request_id, task_id, hit, injected_tokens, injected_ids,"
            " prompt_tokens, completion_tokens, ts FROM request_traces"
        ).fetchall()
    finally:
        con.close()
    return [
        {
            "request_id": r[0],
            "task_id": r[1],
            "hit": int(r[2] or 0),
            "injected_tokens": int(r[3] or 0),
            "injected_ids": r[4],
            "prompt_tokens": int(r[5] or 0),
            "completion_tokens": int(r[6] or 0),
            "ts": r[7],
        }
        for r in raw
    ]


def _schema_unsupported(traces: dict) -> str:
    return (
        "experience.db 为旧 schema（request_traces 缺列 "
        f"{traces.get('missing_columns')}，T4 迁移前——27b 备份/c-d4 快照同构）："
        "该节降级 n=0，不计违规（pi-test 复核 5.3）。"
    )


def _ids_empty(raw) -> bool:
    """injected_ids 列：SQLite TEXT（JSON 数组串）或已解析 list 两种形态都认。"""
    if isinstance(raw, list):
        return len(raw) == 0
    if isinstance(raw, str):
        try:
            return len(json.loads(raw)) == 0
        except json.JSONDecodeError:
            return True
    return not raw


def _mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def _latest_task_score(rows: list[dict], task_id: str) -> float | None:
    """任务最新日实验等效臂行的 score（近似口径：SuccessfulReuse 的任务分）。"""
    cands = [r for r in rows if r.get("task_id") == task_id and "score" in r and r["score"] is not None]
    if not cands:
        return None
    prio = {"experiment": 0, "x2": 0, "x1": 1, "x4": 2, "control": 2, "x3": 2}
    cands.sort(key=lambda r: (-int(r.get("day", 0)), prio.get(r.get("arm"), 3)))
    return float(cands[0]["score"])


# ── 1. Success@K ───────────────────────────────────────────────────────


def _success_group(rows: list[dict], docs_by_key: dict) -> dict:
    scored = [r for r in rows if "score" in r and r["score"] is not None]
    success_n = 0
    success_by_k = {k: 0 for k in SUCCESS_AT_K}
    unknown_n = len(rows) - len(scored)  # 缺 score → unknown
    for r in scored:
        doc = docs_by_key.get((r.get("day"), r.get("arm"), r.get("task_id")))
        if doc is None:
            unknown_n += 1  # 缺 transcript → unknown
            continue
        rounds = len(parse_rounds(doc.get("transcript") or []))
        if r["score"] >= PASS_THRESHOLD:
            success_n += 1
            for k in SUCCESS_AT_K:
                if rounds <= k:  # "第 K 轮前"含第 K 轮（评审§四）
                    success_by_k[k] += 1
    n = len(scored)
    return {
        "tasks": len(rows),
        "scored_n": n,
        "success_n": success_n,
        "unknown_n": unknown_n,
        **{f"k{k}": success_by_k[k] / n if n else 0.0 for k in SUCCESS_AT_K},
    }


def success_at_k(rows: list[dict], run_dir: Path) -> dict:
    """评审§四：P(score>=0.5 且 rounds<=K)，按日/臂分组；transcripts 缺失目录 fail loud。"""
    docs = _load_transcripts(run_dir, None)
    docs_by_key = {(d.get("day"), d.get("arm"), d.get("task_id")): d for d in docs}
    days = sorted({r.get("day") for r in rows})
    arms = sorted({r.get("arm") for r in rows})
    return {
        "ks": list(SUCCESS_AT_K),
        "total": _success_group(rows, docs_by_key),
        "by_day": {str(d): _success_group([r for r in rows if r.get("day") == d], docs_by_key) for d in days},
        "by_arm": {a: _success_group([r for r in rows if r.get("arm") == a], docs_by_key) for a in arms},
    }


# ── 2. 失败迁移矩阵 + RecoveryConversion ──────────────────────────────


def _repeat_rows(rows: list[dict]) -> list[dict]:
    return [r for r in rows if r.get("kind", "repeat") == "repeat"]


def migration(rows: list[dict]) -> dict:
    """评审§十二：kind==repeat 任务 D1→D7 四象限迁移 + RecoveryConversion 双口径。"""
    rep_rows = _repeat_rows(rows)
    days = sorted({r.get("day") for r in rep_rows})
    if not days:
        return {
            "paired_n": 0,
            "unpaired_n": 0,
            "matrix": {f"D1_{q}": {f"D7_{q2}": 0 for q2 in QUADRANTS} for q in QUADRANTS},
            "fallback_n": 0,
            "recovery_conversion": {
                "d1_exhausted_n": 0,
                "efficient_only": 0.0,
                "efficient_only_n": 0,
                "efficient_or_boundary": 0.0,
                "efficient_or_boundary_n": 0,
            },
        }
    d1, d7 = days[0], days[-1]
    d1_rows = {r.get("task_id"): r for r in _experiment_rows(rep_rows, d1)}
    d7_rows = {r.get("task_id"): r for r in _experiment_rows(rep_rows, d7, prefer_x2=True)}
    paired_ids = sorted(set(d1_rows) & set(d7_rows))
    matrix = {f"D1_{q}": {f"D7_{q2}": 0 for q2 in QUADRANTS} for q in QUADRANTS}
    fallback_n = 0
    d1_exhausted: list[str] = []
    d7_converted: list[str] = []
    d7_converted_or_boundary: list[str] = []
    for tid in paired_ids:
        q1, q7 = _quadrant(d1_rows[tid]), _quadrant(d7_rows[tid])
        matrix[f"D1_{q1}"][f"D7_{q7}"] += 1
        _, fb1 = _is_capped(d1_rows[tid])
        _, fb7 = _is_capped(d7_rows[tid])
        fallback_n += 1 if (fb1 or fb7) else 0
        if q1 == "ExhaustedFailure":
            d1_exhausted.append(tid)
            if q7 == "EfficientSuccess":
                d7_converted.append(tid)
            if q7 in ("EfficientSuccess", "BoundarySuccess"):
                d7_converted_or_boundary.append(tid)
    n_ef = len(d1_exhausted)
    return {
        "paired_n": len(paired_ids),
        "unpaired_n": len(set(d1_rows) ^ set(d7_rows)),
        "d1_day": d1,
        "d7_day": d7,
        "fallback_n": fallback_n,
        "matrix": matrix,
        "recovery_conversion": {
            "d1_exhausted_n": n_ef,
            "efficient_only": len(d7_converted) / n_ef if n_ef else 0.0,
            "efficient_only_n": len(d7_converted),
            "efficient_or_boundary": len(d7_converted_or_boundary) / n_ef if n_ef else 0.0,
            "efficient_or_boundary_n": len(d7_converted_or_boundary),
        },
    }


# ── 3. RegressionRate / MemoryInducedRegressionRate ───────────────────


def regression(rows: list[dict]) -> dict:
    """评审§十三：D1→D7 回归率 + 评审§二/十三 同日 ON/OFF 负迁移率，δ=0.1。"""
    rep_rows = _repeat_rows(rows)
    days = sorted({r.get("day") for r in rep_rows})
    d1d7: dict = {"delta": DELTA, "paired_n": 0, "regressed_n": 0, "improved_n": 0,
                  "unchanged_n": 0, "regression_rate": 0.0}
    if days:
        d1_rows = {r.get("task_id"): r for r in _experiment_rows(rep_rows, days[0])}
        d7_rows = {r.get("task_id"): r for r in _experiment_rows(rep_rows, days[-1], prefer_x2=True)}
        pairs = [(d1_rows[t], d7_rows[t]) for t in sorted(set(d1_rows) & set(d7_rows))]
        d1d7["paired_n"] = len(pairs)
        for r1, r7 in pairs:
            diff = round(float(r7.get("score", 0.0)) - float(r1.get("score", 0.0)), 9)
            if diff < -DELTA:
                d1d7["regressed_n"] += 1
            elif diff > DELTA:
                d1d7["improved_n"] += 1
            else:
                d1d7["unchanged_n"] += 1
        n = d1d7["paired_n"]
        d1d7["regression_rate"] = d1d7["regressed_n"] / n if n else 0.0

    def _on_off(day_rows: list[dict]) -> tuple[dict[str, float], dict[str, float]]:
        on = {r.get("task_id"): float(r.get("score", 0.0)) for r in day_rows if r.get("arm") in ON_ARMS}
        off = {r.get("task_id"): float(r.get("score", 0.0)) for r in day_rows if r.get("arm") in OFF_ARMS}
        return on, off

    by_day: dict[str, dict] = {}
    total: dict = {"delta": DELTA, "paired_n": 0, "regressed_n": 0, "regression_rate": 0.0}
    for d in days:
        on, off = _on_off([r for r in rep_rows if r.get("day") == d])
        paired = sorted(set(on) & set(off))
        regressed = sum(1 for t in paired if round(on[t] - off[t], 9) < -DELTA)
        by_day[str(d)] = {
            "paired_n": len(paired),
            "regressed_n": regressed,
            "regression_rate": regressed / len(paired) if paired else 0.0,
        }
        total["paired_n"] += len(paired)
        total["regressed_n"] += regressed
    total["regression_rate"] = total["regressed_n"] / total["paired_n"] if total["paired_n"] else 0.0
    total["by_day"] = by_day
    return {"d1_d7": d1d7, "memory_induced": total}


# ── 4. UsefulHitRate / FalseHitRate ────────────────────────────────────


def transfer_hits(rows: list[dict], traces: list[dict] | dict | None) -> dict:
    """评审§二：hit=true 任务 ON/OFF 差分分类（任务级近似）；配对缺失按臂均值近似。"""
    if isinstance(traces, dict) and traces.get("schema_unsupported"):
        return {
            "note": _schema_unsupported(traces),
            "hit_true_n": 0, "classified_n": 0, "paired_n": 0, "approximated_n": 0,
            "unclassified_n": 0, "useful_n": 0, "false_n": 0,
            "useful_hit_rate": 0.0, "false_hit_rate": 0.0, "by_task": [],
        }
    if traces is None:
        return {
            "note": "experience.db 缺失/不可用：hit 集合未知，转移命中率降级为 0（n=0）。",
            "hit_true_n": 0, "classified_n": 0, "paired_n": 0, "approximated_n": 0,
            "unclassified_n": 0, "useful_n": 0, "false_n": 0,
            "useful_hit_rate": 0.0, "false_hit_rate": 0.0, "by_task": [],
        }
    hit_tasks = {t["task_id"] for t in traces if t["hit"]}
    days = sorted({r.get("day") for r in rows})
    # 全期臂均值（同日无该臂行时回退）
    on_all = _mean([float(r.get("score", 0.0)) for r in rows if r.get("arm") in ON_ARMS])
    off_all = _mean([float(r.get("score", 0.0)) for r in rows if r.get("arm") in OFF_ARMS])
    classified: list[dict] = []
    for d in days:
        day_rows = [r for r in rows if r.get("day") == d]
        on = {r.get("task_id"): float(r.get("score", 0.0)) for r in day_rows if r.get("arm") in ON_ARMS}
        off = {r.get("task_id"): float(r.get("score", 0.0)) for r in day_rows if r.get("arm") in OFF_ARMS}
        on_day = list(on.values())
        off_day = list(off.values())
        on_mean = _mean(on_day) if on_day else on_all
        off_mean = _mean(off_day) if off_day else off_all
        for task in sorted(hit_tasks):
            if task in on and task in off:
                on_s, off_s, approx = on[task], off[task], "none"
            elif task in on:
                on_s, off_s, approx = on[task], off_mean, "off"
            elif task in off:
                on_s, off_s, approx = on_mean, off[task], "on"
            else:
                continue
            classified.append({
                "task_id": task,
                "day": d,
                "on_score": on_s,
                "off_score": off_s,
                "approx": approx,
                "useful": round(on_s - off_s, 9) >= -DELTA,
            })
    useful = [c for c in classified if c["useful"]]
    false = [c for c in classified if not c["useful"]]
    n = len(classified)
    return {
        "hit_true_n": len(hit_tasks),
        "classified_n": n,
        "paired_n": sum(1 for c in classified if c["approx"] == "none"),
        "approximated_n": sum(1 for c in classified if c["approx"] != "none"),
        "unclassified_n": len(hit_tasks) - len({c["task_id"] for c in classified}),
        "useful_n": len(useful),
        "false_n": len(false),
        "useful_hit_rate": len(useful) / n if n else 0.0,
        "false_hit_rate": len(false) / n if n else 0.0,
        "by_task": classified,
    }


# ── 5. Functional vs Judge 分层 ────────────────────────────────────────


def _functional_group(rows: list[dict]) -> dict:
    func_scores: list[float] = []
    judge_scores: list[float] = []
    hard_pass_n = 0
    divergence_n = 0
    for r in rows:
        grading = r.get("grading")
        breakdown = grading.get("breakdown") if isinstance(grading, dict) else None
        if not isinstance(breakdown, dict):
            continue
        automated = [v for k, v in breakdown.items() if str(k).startswith("automated.")]
        judge = [v for k, v in breakdown.items() if str(k).startswith("llm_judge.")]
        if automated:
            func_scores.append(float(_mean([float(v) for v in automated])))
            hard_pass = all(float(v) == 1.0 for v in automated)
            if hard_pass:
                hard_pass_n += 1  # HardPass 不可能背离
            elif judge and _mean([float(v) for v in judge]) >= 0.5:
                divergence_n += 1
        if judge:
            judge_scores.append(_mean([float(v) for v in judge]))
    fn, jn = len(func_scores), len(judge_scores)
    return {
        "rows": len(rows),
        "functional_n": fn,
        "judge_n": jn,
        "functional_score_mean": _mean(func_scores) if fn else None,
        "judge_score_mean": _mean(judge_scores) if jn else None,
        "functional_success_rate": hard_pass_n / fn if fn else 0.0,
        "hard_pass_n": hard_pass_n,
        "divergence_n": divergence_n,
    }


def functional_judge(rows: list[dict]) -> dict:
    """评审§五：automated.* 均值=FunctionalScore（HardPass=全部==1.0）；
    llm_judge.* 均值=JudgeScore；背离清单 = Judge>=0.5 ∧ ¬HardPass。"""
    total = _functional_group(rows)
    days = sorted({r.get("day") for r in rows})
    arms = sorted({r.get("arm") for r in rows})
    no_breakdown_n = 0
    divergence: list[dict] = []
    for r in rows:
        grading = r.get("grading")
        breakdown = grading.get("breakdown") if isinstance(grading, dict) else None
        if not isinstance(breakdown, dict):
            no_breakdown_n += 1
            continue
        automated = [v for k, v in breakdown.items() if str(k).startswith("automated.")]
        judge = [v for k, v in breakdown.items() if str(k).startswith("llm_judge.")]
        if not automated:
            no_breakdown_n += 1
            continue
        func = _mean([float(v) for v in automated])
        hard_pass = all(float(v) == 1.0 for v in automated)
        if not judge or hard_pass:
            continue
        judge_score = _mean([float(v) for v in judge])
        if judge_score >= 0.5:
            divergence.append({
                "day": r.get("day"),
                "arm": r.get("arm"),
                "task_id": r.get("task_id"),
                "functional_score": func,
                "judge_score": judge_score,
                "hard_pass": False,
            })
    return {
        **total,
        "no_breakdown_n": no_breakdown_n,
        "divergence": divergence,
        "by_day": {str(d): _functional_group([r for r in rows if r.get("day") == d]) for d in days},
        "by_arm": {a: _functional_group([r for r in rows if r.get("arm") == a]) for a in arms},
    }


# ── 6. 难度分层 ────────────────────────────────────────────────────────


def _tier(score: float) -> str:
    if score >= TIER_EASY:
        return "easy"
    if score >= TIER_MEDIUM:
        return "medium"
    return "hard"


def difficulty_layers(rows: list[dict]) -> dict:
    """评审§十一：D1 实验臂三档 + dsl/workflow/multi 关键词辅层；分层 MemoryGain。"""
    days = sorted({r.get("day") for r in rows})
    d1_rows = {r.get("task_id"): r for r in _experiment_rows(rows, days[0])} if days else {}
    d7_rows = {r.get("task_id"): r for r in _experiment_rows(rows, days[-1], prefer_x2=True)} if days else {}

    def _layer_gain(task_ids: list[str]) -> dict:
        paired = [t for t in task_ids if t in d1_rows and t in d7_rows]
        gains = [float(d7_rows[t].get("score", 0.0)) - float(d1_rows[t].get("score", 0.0)) for t in paired]
        d1_mean = _mean([float(d1_rows[t].get("score", 0.0)) for t in paired]) if paired else None
        d7_mean = _mean([float(d7_rows[t].get("score", 0.0)) for t in paired]) if paired else None
        return {
            "n": len(task_ids),
            "paired_n": len(paired),
            "d1_mean": d1_mean,
            "d7_mean": d7_mean,
            "memory_gain": _mean(gains) if gains else None,
        }

    tier_tasks: dict[str, list[str]] = {"easy": [], "medium": [], "hard": []}
    kw_tasks: dict[str, list[str]] = {k: [] for k in DIFFICULTY_KEYWORDS}
    for tid, row in d1_rows.items():
        tier_tasks[_tier(float(row.get("score", 0.0)))].append(tid)
        low = str(tid).lower()
        for kw in DIFFICULTY_KEYWORDS:
            if kw in low:
                kw_tasks[kw].append(tid)
    return {
        "tier_boundaries": {"easy": TIER_EASY, "medium": TIER_MEDIUM},
        "tiers": {tier: _layer_gain(tier_tasks[tier]) for tier in tier_tasks},
        "keywords": {kw: _layer_gain(kw_tasks[kw]) for kw in DIFFICULTY_KEYWORDS},
    }


# ── 7. TreatmentCompliance ─────────────────────────────────────────────


def treatment_compliance(rows: list[dict], traces: list[dict] | dict | None) -> dict:
    """评审§十：四臂日 X3/X4 行零注入校验（task_id 粗粒度 join，任务书口径）。
    旧 schema 库（缺列）→ schema_unsupported 标记输出，不计违规不 crash。"""
    if isinstance(traces, dict) and traces.get("schema_unsupported"):
        return {
            "n": 0,
            "checked_tasks": 0,
            "ok_n": 0,
            "violation_n": 0,
            "unverifiable_n": 0,
            "compliance_rate": None,
            "violations": [],
            "schema_unsupported": True,
            "schema_unsupported_note": _schema_unsupported(traces),
            "notes": {
                "join": "request_traces 无 arm 列，按 task_id 粗粒度 join（任务书 §1.1 指标 7 口径）。",
                "frozen_base_offline": "X1/X4 冻结实例（--frozen-base-url）与模型指纹"
                        "（AGENT_EVAL_EXPECTED_OMLX_MODEL）为运行时接线/preflight 校验项，"
                        "离线库无可复核字段——不在本指标内断言（任务书 §1.1 指标 7）。",
            },
        }
    scope = {r.get("task_id") for r in rows if r.get("arm") in FOUR_ARMS and r.get("arm") in ("x3", "x4")}
    if not scope:
        return {
            "n": 0,
            "checked_tasks": 0,
            "ok_n": 0,
            "violation_n": 0,
            "unverifiable_n": 0,
            "compliance_rate": None,
            "violations": [],
            "notes": {
                "join": "request_traces 无 arm 列，按 task_id 粗粒度 join（任务书 §1.1 指标 7 口径）；"
                        "零注入痕迹存在性 = OFF 臂未注入证据；全部痕迹非零 = 违规。",
                "frozen_base_offline": "X1/X4 冻结实例（--frozen-base-url）与模型指纹"
                        "（AGENT_EVAL_EXPECTED_OMLX_MODEL）为运行时接线/preflight 校验项，"
                        "离线库无可复核字段——不在本指标内断言（任务书 §1.1 指标 7）。",
            },
        }
    by_task: dict[str, list[dict]] = {}
    for t in (traces or []):
        by_task.setdefault(t.get("task_id"), []).append(t)
    violations: list[dict] = []
    ok_n = violation_n = unverifiable_n = 0
    for tid in sorted(scope):
        task_traces = by_task.get(tid, [])
        if not task_traces:
            unverifiable_n += 1
            continue
        zero = [t for t in task_traces if t["injected_tokens"] == 0 and _ids_empty(t["injected_ids"])]
        if zero:
            ok_n += 1
        else:
            violation_n += 1
            nonzero = [t for t in task_traces if t["injected_tokens"] != 0 or not _ids_empty(t["injected_ids"])]
            violations.append({
                "task_id": tid,
                "zero_n": len(zero),
                "nonzero_n": len(nonzero),
                "nonzero_sample_request_ids": [t.get("request_id") for t in nonzero[:5]],
            })
    checked = ok_n + violation_n
    return {
        "n": len(scope),
        "checked_tasks": checked,
        "ok_n": ok_n,
        "violation_n": violation_n,
        "unverifiable_n": unverifiable_n,
        "compliance_rate": ok_n / checked if checked else None,
        "violations": violations,
        "notes": {
            "join": "request_traces 无 arm 列，按 task_id 粗粒度 join（任务书 §1.1 指标 7 口径）；"
                    "非零注入痕迹属 X1/X2 ON 臂（预期存在），不判违规。",
            "frozen_base_offline": "X1/X4 冻结实例（--frozen-base-url）与模型指纹"
                    "（AGENT_EVAL_EXPECTED_OMLX_MODEL）为运行时接线/preflight 校验项，"
                    "离线库无可复核字段——不在本指标内断言（任务书 §1.1 指标 7）。",
        },
    }


# ── 9. context_budget（评审§九）──────────────────────────────────────────


def _ids_len(raw) -> int:
    """injected_ids 列长度：SQLite TEXT（JSON 数组串）或已解析 list 两种形态都认。"""
    if isinstance(raw, list):
        return len(raw)
    if isinstance(raw, str):
        try:
            return len(json.loads(raw))
        except json.JSONDecodeError:
            return 0
    return 0


def _day_from_ts(ts) -> str:
    """request_traces 无 day 列：按 ts 日期（ISO 前 10 位，自然日近似）分组；
    无法解析归 "unknown"（仅计数）。"""
    s = str(ts or "")
    if len(s) >= 10 and s[4] == "-" and s[7] == "-":
        return s[:10]
    return "unknown"


def _bucket_ranges() -> list[tuple[str, float, float]]:
    """四分桶区间（预注册边界 0/0.1/0.2/0.3+，含下不含上；标签 %g 紧凑格式）。"""
    bounds = RATIO_BUCKET_BOUNDARIES
    ranges = []
    for i in range(len(bounds) - 1):
        ranges.append((f"[{bounds[i]:g},{bounds[i + 1]:g})", bounds[i], bounds[i + 1]))
    ranges.append((f"[{bounds[-1]:g},inf)", bounds[-1], float("inf")))
    return ranges


def context_budget(rows: list[dict], traces: list[dict] | dict | None) -> dict:
    """评审§九：MemoryTokenRatio / InjectedMemoryCount 报表 + Score=f(ratio) 桶对照。
    预注册口径见模块 docstring 第 9 节（倒 U 猜想为探索性假设，不做断言）。"""
    empty = {
        "n": 0, "skipped_n": 0, "unknown_day_n": 0, "by_day": {},
        "score_buckets": {
            "boundaries": list(RATIO_BUCKET_BOUNDARIES),
            "buckets": {label: {"n": 0, "mean_score": None} for label, _, _ in _bucket_ranges()},
            "bucket_skipped_n": 0,
            "note": SCORE_BUCKET_NOTE,
        },
    }
    if isinstance(traces, dict) and traces.get("schema_unsupported"):
        return {**empty, "schema_unsupported": True, "note": _schema_unsupported(traces)}
    if traces is None:
        return {**empty, "note": "experience.db 缺失/不可用：context_budget 降级为 0（n=0）。"}
    per_day: dict[str, list[float]] = {}
    injected_per_day: dict[str, list[float]] = {}
    bucket_scores: dict[str, list[float]] = {label: [] for label, _, _ in _bucket_ranges()}
    bucket_labels = [(label, lo, hi) for label, lo, hi in _bucket_ranges()]
    skipped = 0
    unknown_day = 0
    bucket_skipped = 0
    for t in traces:
        prompt = t.get("prompt_tokens", 0) or 0
        if prompt <= 0:
            skipped += 1  # 分母缺失/为 0 → 跳过并计数（loader 层 NULL/缺失归一为 0）
            continue
        ratio = (t.get("injected_tokens", 0) or 0) / prompt
        day = _day_from_ts(t.get("ts"))
        if day == "unknown":
            unknown_day += 1
        else:
            per_day.setdefault(day, []).append(ratio)
            injected_per_day.setdefault(day, []).append(float(_ids_len(t.get("injected_ids"))))
        score = _latest_task_score(rows, t.get("task_id"))
        if score is None:
            bucket_skipped += 1
            continue
        for label, lo, hi in bucket_labels:
            if lo <= ratio < hi:
                bucket_scores[label].append(score)
                break
    by_day = {
        day: {
            "n": len(ratios),
            "ratio_mean": _mean(ratios),
            "ratio_p50": _percentile(sorted(ratios), 50),
            "ratio_p90": _percentile(sorted(ratios), 90),
            "injected_count_mean": _mean(injected_per_day[day]),
        }
        for day, ratios in sorted(per_day.items())
    }
    return {
        "n": sum(len(v) for v in per_day.values()) + unknown_day,
        "skipped_n": skipped,
        "unknown_day_n": unknown_day,
        "by_day": by_day,
        "score_buckets": {
            "boundaries": list(RATIO_BUCKET_BOUNDARIES),
            "buckets": {
                label: {"n": len(scores), "mean_score": _mean(scores) if scores else None}
                for label, scores in bucket_scores.items()
            },
            "bucket_skipped_n": bucket_skipped,
            "note": SCORE_BUCKET_NOTE,
        },
    }


# ── 8. economics（T10）─────────────────────────────────────────────────


def _load_ledger(path: Path | None) -> tuple[list[dict], int]:
    """usage 台账 JSONL → (entries, skipped_lines)；缺失 → ([], 0)。"""
    if path is None or not path.exists():
        return [], 0
    entries: list[dict] = []
    skipped = 0
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        try:
            entries.append(json.loads(line))
        except json.JSONDecodeError:
            skipped += 1
    return entries, skipped


def economics(
    rows: list[dict],
    traces: list[dict] | dict | None,
    gateway_db: Path | None,
    usage_ledger: Path | None,
) -> dict:
    """评审§十六：teacher 摊销 + TotalSystemCost 四项报表（预注册常量见模块 docstring）。"""
    schema_note = _schema_unsupported(traces) if isinstance(traces, dict) and traces.get("schema_unsupported") else None
    if isinstance(traces, dict) and traces.get("schema_unsupported"):
        traces = None  # 旧 schema：student 计量/复用降级为 0（不 crash）
    # teacher 台账成本
    entries, skipped = _load_ledger(usage_ledger)
    model_breakdown: dict[str, dict] = {}
    teacher_prompt = teacher_completion = teacher_calls = 0
    for e in entries:
        model = str(e.get("model", ""))
        prompt = int(e.get("prompt_tokens", 0) or 0)
        completion = int(e.get("completion_tokens", 0) or 0)
        bucket = model_breakdown.setdefault(model, {"calls": 0, "prompt_tokens": 0, "completion_tokens": 0})
        bucket["calls"] += 1
        bucket["prompt_tokens"] += prompt
        bucket["completion_tokens"] += completion
        if model == TEACHER_MODEL_NAME:
            teacher_prompt += prompt
            teacher_completion += completion
            teacher_calls += 1
    teacher_cost = teacher_prompt * TEACHER_INPUT_PRICE_PER_TOKEN + teacher_completion * TEACHER_OUTPUT_PRICE_PER_TOKEN

    # SuccessfulReuse：request_traces hit=true 且任务 score>=0.5（近似口径，见 docstring）
    reuse = 0
    reuse_note = (
        "SuccessfulReuseCount = request_traces 中 hit=true 且任务 score>=0.5 的计数；"
        "任务 score 取 run.jsonl 最新日实验等效臂行（近似口径）。"
    )
    if traces is not None:
        for t in traces:
            if t["hit"]:
                score = _latest_task_score(rows, t.get("task_id"))
                if score is not None and score >= PASS_THRESHOLD:
                    reuse += 1
    if schema_note:
        reuse_note += f" {schema_note}"
    if reuse:
        amortized = teacher_cost / reuse
        amortized_note = "AmortizedTeacherCost = Σ(teacher tokens)×单价 / SuccessfulReuseCount"
    else:
        amortized = None
        amortized_note = "零复用分母（SuccessfulReuseCount=0）：摊销成本未定义（None）。"

    # StudentInference：request_traces 全量 token（9B 本地推理，成本计 0 仅计量）
    student_prompt = student_completion = 0
    if traces is not None:
        student_prompt = sum(t["prompt_tokens"] for t in traces)
        student_completion = sum(t["completion_tokens"] for t in traces)
    student_note = "9B 本地 omlx 推理：成本计 0，仅计量 token（request_traces 全量）。"
    if schema_note:
        student_note += f" {schema_note}"

    # Escalation：gateway model_runs（cost_micro_usd；网关无定价数据时为 NULL → 计 0）
    esc_runs = 0
    esc_micro = 0
    esc_note = "gateway model_runs purpose=escalation 且 state=succeeded 的 cost_micro_usd 合计"
    esc_note += "（网关全期范围，非按 run 过滤——run.jsonl 无成本行，为近似口径）。"
    if gateway_db is not None and gateway_db.exists():
        con = sqlite3.connect(f"file:{gateway_db}?mode=ro", uri=True)
        try:
            has_table = con.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='model_runs'"
            ).fetchall()
            if not has_table:
                raise ValueError(f"gateway database {gateway_db} has no model_runs table")
            rows_out = con.execute(
                "SELECT COUNT(*), COALESCE(SUM(cost_micro_usd), 0) FROM model_runs"
                " WHERE purpose='escalation' AND state='succeeded'"
            ).fetchone()
            esc_runs, esc_micro = int(rows_out[0]), int(rows_out[1] or 0)
            null_n = con.execute(
                "SELECT COUNT(*) FROM model_runs WHERE purpose='escalation' AND state='succeeded'"
                " AND cost_micro_usd IS NULL"
            ).fetchone()[0]
            if null_n:
                esc_note += f" 其中 {null_n} 行 cost_micro_usd 为 NULL（网关未填定价数据），按 0 计。"
        finally:
            con.close()
    else:
        esc_note += " gateway 库缺失/未提供，按 0 计。"

    student_cost = 0.0  # 9B 本地推理成本计 0（仅计量 token）
    infra_cost = 0.0  # Infra 占位（评审§十六 MemoryInfrastructure 项，后续实算）
    total = student_cost + esc_micro / 1e6 + (amortized or 0.0) + infra_cost
    return {
        "teacher_total_cost_usd": teacher_cost,
        "teacher_tokens": {"calls": teacher_calls, "prompt": teacher_prompt, "completion": teacher_completion},
        "teacher_model_name": TEACHER_MODEL_NAME,
        "model_breakdown": model_breakdown,
        "ledger_skipped_lines": skipped,
        "ledger_note": ("usage 台账缺失（var/eval/evolution-usage.jsonl 或 --usage-ledger）："
                        "teacher 成本记 0。") if not entries else "usage 台账已加载。",
        "successful_reuse_count": reuse,
        "successful_reuse_note": reuse_note,
        "amortized_teacher_cost_usd": amortized,
        "amortized_note": amortized_note,
        "price_table": {
            "model": TEACHER_MODEL_NAME,
            "input_usd_per_token": TEACHER_INPUT_PRICE_PER_TOKEN,
            "output_usd_per_token": TEACHER_OUTPUT_PRICE_PER_TOKEN,
            "source": "deepseek 公示价 2026-07-30（$0.435/M in / $0.87/M out）；"
                      "doc/design/plans/2026-07-30-eval-benchmark-pivot-plan.md；"
                      "api-docs.deepseek.com/quick_start/pricing",
        },
        "student_inference": {
            "prompt_tokens": student_prompt,
            "completion_tokens": student_completion,
            "cost_usd": student_cost,
            "note": student_note,
        },
        "escalation": {"runs": esc_runs, "cost_micro_usd": esc_micro, "cost_usd": esc_micro / 1e6, "note": esc_note},
        "infra": {"cost_usd": infra_cost, "note": "Infra 占位（评审§十六 MemoryInfrastructure 项）。"},
        "total_system_cost_usd": total,
        "total_note": (
            "TotalSystemCost = StudentInference + Escalation + AmortizedTeacher + Infra"
            "（评审§十六公式；AmortizedTeacher 为每次成功复用摊销，Student/Escalation/Infra 为批次总量"
            "——口径混合是评审公式原样，解释时注意单位）。"
        ),
    }


# ── analyze / CLI ──────────────────────────────────────────────────────


def analyze(
    run_dir: Path,
    gateway_db: Path | None = None,
    experience_db: Path | None = None,
    usage_ledger: Path | None = None,
) -> dict:
    """全量报告。run.jsonl 缺失 → 空行全降级（pilot-9b-addendum 形态不炸批）。"""
    rows = load_results(run_dir / "run.jsonl") if (run_dir / "run.jsonl").exists() else []
    traces = _load_traces(experience_db)
    return {
        "run_id": run_dir.name,
        "success_at_k": success_at_k(rows, run_dir) if rows else _empty_success(),
        "migration": migration(rows),
        "regression": regression(rows),
        "transfer": transfer_hits(rows, traces),
        "functional": functional_judge(rows),
        "difficulty": difficulty_layers(rows),
        "compliance": treatment_compliance(rows, traces),
        "context_budget": context_budget(rows, traces),
        "economics": economics(rows, traces, gateway_db, usage_ledger),
    }


def _empty_success() -> dict:
    return {
        "ks": list(SUCCESS_AT_K),
        "total": {"tasks": 0, "scored_n": 0, "success_n": 0, "unknown_n": 0, **{f"k{k}": 0.0 for k in SUCCESS_AT_K}},
        "by_day": {},
        "by_arm": {},
    }


def main(argv: list[str] | None = None) -> int:
    eval_dir = Path(__file__).resolve().parent
    ap = argparse.ArgumentParser(description="D 阶段 Analysis Addendum v2 离线分析（T6+T10，预注册见模块 docstring）")
    ap.add_argument("run_dir", type=Path, help="results/<run_id> 目录（含 run.jsonl 与 transcripts/）")
    ap.add_argument("--gateway-db", type=Path, default=None,
                    help="gateway SQLite（model_runs escalation 成本）。默认 packages/agent-gateway/var/agent_gateway.db")
    ap.add_argument("--experience-db", type=Path, default=None,
                    help="experience.db（request_traces：hit/注入痕迹/student tokens）。默认 <pkg>/var/eval/experience.db")
    ap.add_argument("--usage-ledger", type=Path, default=None,
                    help="teacher usage 台账 JSONL（T10）。默认 <pkg>/var/eval/evolution-usage.jsonl")
    args = ap.parse_args(argv)
    if args.gateway_db is None:
        args.gateway_db = eval_dir / "../../agent-gateway/var/agent_gateway.db"
    if args.experience_db is None:
        args.experience_db = eval_dir.parent / "var/eval/experience.db"
    if args.usage_ledger is None:
        args.usage_ledger = eval_dir.parent / "var/eval/evolution-usage.jsonl"
    report = analyze(args.run_dir, gateway_db=args.gateway_db,
                     experience_db=args.experience_db, usage_ledger=args.usage_ledger)
    print(json.dumps(report, indent=2, ensure_ascii=False, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
