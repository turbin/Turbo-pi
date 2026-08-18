"""F2 实战归因奖惩（T3）：request_traces.injected_ids × task_id × run.jsonl 分数 → 卡×结果关联。

纯离线计算（plans §3 F2，dev-tasks T3）：
1. 样本单位 = **任务日**（(day, task_id)）：同任务日多请求共享同一 judge 分数，
   只算一个样本（预注册口径，决策记录 T3-1）；
2. 多卡共注入样本**仅记数不动作**（credit assignment 加权策略列为后续演进）；
3. 奖惩规则（首版保守，常量预注册）：
   - 单卡注入 + 任务日 score >= SUCCESS_SCORE → confidence += CONFIDENCE_INC（封顶 1.0）；
   - 单卡注入失败样本 >= DEMOTION_MIN_FAILURES（3 个不同任务日）→ 降权事件：
     confidence = min(confidence * 0.5, 0.3)（实战降权标记阈值 0.3）；
   - quality 字段不动（降权只走 confidence → 检索排序加权）；
4. 落地：--apply 写 confidence（按规则自动）；active→dormant **不自动**——报告输出
   待降级清单，人工确认后 --demote <ids.json> 执行（置 dormant + 复升排除标记
   rescore_excluded_batches=N，阻断"自评复升→再注入→再失败"循环）；
5. 三种证据源：
   - --store：post-F0 request_traces（injected_ids × task_id × ts，join run.jsonl 分数）；
   - --sessions-dir：session JSONL 的 experience_injection 条目近似（C 回放口径，
     retrieved ⊆ 实际注入，误差显式声明）；
   - --injections：显式注入清单（issue-010 文档化证据回放用）。

CLI:
  eval/.venv/bin/python attribution.py \
    --run-json eval/results/<run_id>/run.jsonl --store <live.db> \
    --report attribution-report.json [--campaign-start-date 2026-08-09] [--apply]
  eval/.venv/bin/python attribution.py --demote <ids.json> --store <live.db>
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path

# ---------------------------------------------------------------------------
# 预注册常量（决策记录 T3-2：口径与取值在此唯一权威）
# ---------------------------------------------------------------------------

# 任务日 score >= 此值 = 成功样本（与主管线晋升阈值对齐）。
SUCCESS_SCORE = 0.5
# 新卡/旧行默认置信度（COALESCE 默认，experiences.confidence 列 DEFAULT）。
CONFIDENCE_DEFAULT = 0.5
# 单卡注入成功样本加分（每次 +0.1，封顶 1.0）。
CONFIDENCE_INC = 0.1
CONFIDENCE_MAX = 1.0
# 降权事件阈值：单卡注入的失败任务日样本 >= 3（样本单位 = 任务日）。
DEMOTION_MIN_FAILURES = 3
# 降权公式：confidence = min(confidence * 0.5, 0.3)——0.3 为"实战降权标记"阈值。
CONFIDENCE_DEMOTED_FACTOR = 0.5
CONFIDENCE_DEMOTED_CAP = 0.3
# 复升排除批数 N：人工降级后跳过 runDormantRescore 自评复评 N 批。
RESCORE_EXCLUDE_BATCHES = 3


# ---------------------------------------------------------------------------
# 数据模型
# ---------------------------------------------------------------------------

@dataclass
class TaskDaySample:
    """一个任务日样本（(day, task_id, arm) 唯一；score 来自 run.jsonl）。"""

    day: int
    task_id: str
    arm: str
    score: float
    card_ids: list
    source: str = ""


@dataclass
class CardStats:
    """单卡归因统计与奖惩结论。"""

    id: str
    type: str = ""
    title: str = ""
    role: str = ""
    injected_task_days: int = 0
    distinct_tasks: int = 0
    successes: int = 0
    failures: int = 0
    multi_injection_samples: int = 0
    confidence_before: float = CONFIDENCE_DEFAULT
    confidence_after: float = CONFIDENCE_DEFAULT
    action: str = "none"        # "reward" | "demote" | "none"
    demote_candidate: bool = False  # 降权事件已触发 → 列入待降级清单（人工确认）

    def to_dict(self) -> dict:
        return {
            "id": self.id, "type": self.type, "title": self.title, "role": self.role,
            "injected_task_days": self.injected_task_days, "distinct_tasks": self.distinct_tasks,
            "successes": self.successes, "failures": self.failures,
            "multi_injection_samples": self.multi_injection_samples,
            "confidence_before": round(self.confidence_before, 4),
            "confidence_after": round(self.confidence_after, 4),
            "action": self.action, "demote_candidate": self.demote_candidate,
        }


# ---------------------------------------------------------------------------
# run.jsonl 读取
# ---------------------------------------------------------------------------

def load_run_scores(run_json_path: str) -> dict[tuple[int, str, str], float]:
    """(day, task_id, arm) -> score。"""
    scores: dict[tuple[int, str, str], float] = {}
    with open(run_json_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            scores[(int(row["day"]), str(row["task_id"]), str(row["arm"]))] = float(row["score"])
    return scores


# ---------------------------------------------------------------------------
# 证据源 1：--store（post-F0 request_traces）
# ---------------------------------------------------------------------------

def _day_from_ts(ts: str, campaign_start: date) -> int:
    """ts 日历日 → campaign day（day1 = campaign_start 当日）。"""
    return (datetime.fromisoformat(ts.replace("Z", "+00:00")).date() - campaign_start).days + 1


def build_samples_from_traces(
    store_path: str, run_json_path: str, campaign_start_date: str,
) -> list[TaskDaySample]:
    """request_traces（injected_ids × task_id × ts）join run.jsonl 分数 → 任务日样本。

    同 (day, task_id) 的多条请求合并为一个样本（card_ids 取并集）——样本单位 =
    任务日（同任务日多请求共享同一 judge 分数）。run.jsonl 无对应行的任务日跳过。
    """
    start = date.fromisoformat(campaign_start_date)
    scores = load_run_scores(run_json_path)
    db = sqlite3.connect(f"file:{store_path}?mode=ro", uri=True)
    try:
        rows = db.execute(
            "SELECT ts, injected_ids, task_id FROM request_traces"
            " WHERE task_id IS NOT NULL AND task_id != ''"
        ).fetchall()
    finally:
        db.close()

    merged: dict[tuple[int, str, str], set[str]] = {}
    sources: dict[tuple[int, str, str], str] = {}
    for ts, injected_raw, task_id in rows:
        if not injected_raw:
            continue
        try:
            injected = json.loads(injected_raw)
        except json.JSONDecodeError:
            continue
        if not isinstance(injected, list) or not injected:
            continue
        day = _day_from_ts(ts, start)
        if (day, task_id, "experiment") not in scores:
            continue  # 无 run.jsonl 分数（非 campaign 请求或日期映射失败）→ 跳过
        key = (day, task_id, "experiment")
        merged.setdefault(key, set()).update(injected)
        sources.setdefault(key, "request_traces")

    return [
        TaskDaySample(day=k[0], task_id=k[1], arm=k[2], score=scores[k],
                      card_ids=sorted(v), source=sources[k])
        for k, v in sorted(merged.items())
    ]


# ---------------------------------------------------------------------------
# 证据源 2：--sessions-dir（experience_injection 条目近似，C 回放口径）
# ---------------------------------------------------------------------------

def _read_session_entries(path: str) -> list[dict]:
    entries: list[dict] = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return entries


def build_samples_from_sessions(
    sessions_dir: str, run_json_path: str, campaign_start_date: str,
) -> list[TaskDaySample]:
    """session JSONL 的 experience_injection 条目 → 任务日样本（近似口径）。

    C 期 request_traces 因 F-1 不可用，以注入条目近似：experiment 臂
    experience_injection.retrieved ≈ 实际注入集（误差：不含 top-5 截断与
    evidence 池过滤——retrieved ⊇ injected）；control 臂 disabled 条目排除。
    """
    start = date.fromisoformat(campaign_start_date)
    scores = load_run_scores(run_json_path)
    merged: dict[tuple[int, str, str], set[str]] = {}
    sources: dict[tuple[int, str, str], str] = {}

    for path in sorted(Path(sessions_dir).rglob("*.jsonl")):
        meta: dict = {}
        ts = ""
        for entry in _read_session_entries(str(path)):
            if entry.get("type") == "session":
                meta = entry.get("metadata") or {}
                ts = str(entry.get("timestamp") or "")
            elif entry.get("type") == "custom" and entry.get("customType") == "experience_injection":
                data = entry.get("data") or {}
                if data.get("disabled"):
                    continue  # control 臂：注入关闭
                retrieved = data.get("retrieved") or []
                if not isinstance(retrieved, list) or not retrieved:
                    continue
                task_id = str(meta.get("task_id") or meta.get("taskId") or "")
                if not task_id:
                    continue
                day = int(meta["day"]) if str(meta.get("day", "")).isdigit() else (
                    _day_from_ts(ts, start) if ts else 0)
                if day <= 0 or (day, task_id, "experiment") not in scores:
                    continue
                key = (day, task_id, "experiment")
                merged.setdefault(key, set()).update(str(i) for i in retrieved)
                sources.setdefault(key, str(path))

    return [
        TaskDaySample(day=k[0], task_id=k[1], arm=k[2], score=scores[k],
                      card_ids=sorted(v), source=sources[k])
        for k, v in sorted(merged.items())
    ]


# ---------------------------------------------------------------------------
# 证据源 3：--injections（显式清单，issue-010 文档化证据回放）
# ---------------------------------------------------------------------------

def build_samples_from_manifest(manifest_path: str, run_json_path: str) -> tuple[list[TaskDaySample], int]:
    """显式注入清单 → 任务日样本。清单行：{day, task_id, arm, card_ids, evidence?}。

    返回 (samples, 跳过数)——run.jsonl 无对应 (day, task_id, arm) 的行跳过并计数。
    """
    scores = load_run_scores(run_json_path)
    samples: list[TaskDaySample] = []
    skipped = 0
    with open(manifest_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            key = (int(row["day"]), str(row["task_id"]), str(row["arm"]))
            if key not in scores:
                skipped += 1
                continue
            samples.append(TaskDaySample(
                day=key[0], task_id=key[1], arm=key[2], score=scores[key],
                card_ids=[str(i) for i in row.get("card_ids", [])],
                source=row.get("evidence", "manifest"),
            ))
    return samples, skipped


# ---------------------------------------------------------------------------
# 奖惩规则
# ---------------------------------------------------------------------------

def compute_attribution(
    samples: list[TaskDaySample],
    cards_meta: dict[str, dict] | None = None,
    confidence: dict[str, float] | None = None,
) -> dict[str, CardStats]:
    """卡×结果关联 + 奖惩规则（纯函数，确定性）。

    样本去重合并（同 (day, task_id, arm) 的 card_ids 取并集）→ 单卡样本驱动
    奖惩、多卡样本仅记数。规则：
      reward：单卡成功样本每次 +CONFIDENCE_INC（封顶 CONFIDENCE_MAX）；
      demote：单卡失败样本 >= DEMOTION_MIN_FAILURES → confidence = min(c*0.5, 0.3)
              （先加分后降权；降权事件同时置 demote_candidate）。
    """
    meta = cards_meta or {}
    conf = confidence or {}

    # 1) 按任务日去重合并（同 (day, task_id, arm) 的 card_ids 取并集）。
    merged: dict[tuple[int, str, str], set[str]] = {}
    score_of: dict[tuple[int, str, str], float] = {}
    for s in samples:
        merged.setdefault((s.day, s.task_id, s.arm), set()).update(s.card_ids)
        score_of[(s.day, s.task_id, s.arm)] = s.score

    # 2) 逐卡统计（n = 该任务日注入卡数：>1 为多卡共注入样本）。
    card_samples: dict[str, list[tuple[str, float, int]]] = {}
    for (day, task_id, arm), ids in merged.items():
        for cid in ids:
            card_samples.setdefault(cid, []).append((task_id, score_of[(day, task_id, arm)], len(ids)))

    stats: dict[str, CardStats] = {}
    for cid, entries in card_samples.items():
        m = meta.get(cid, {})
        st = CardStats(
            id=cid, type=str(m.get("type", "")), title=str(m.get("title", "")),
            role=str(((m.get("payload") or {}).get("role")) if isinstance(m.get("payload"), dict) else ""),
        )
        st.injected_task_days = len(entries)
        st.distinct_tasks = len({t for t, _s, _n in entries})
        st.multi_injection_samples = sum(1 for _t, _s, n in entries if n > 1)
        st.confidence_before = conf.get(cid, CONFIDENCE_DEFAULT)
        c = st.confidence_before
        for _t, score, n in entries:
            if n > 1:
                continue  # 多卡共注入：仅记数不动作（credit assignment 后续演进）
            if score >= SUCCESS_SCORE:
                st.successes += 1
            else:
                st.failures += 1
        # 先加分（每次成功 +0.1，封顶 1.0）。
        c = min(CONFIDENCE_MAX, c + st.successes * CONFIDENCE_INC)
        # 后降权：失败样本 >= 阈值 → 收敛到实战降权标记带。
        if st.failures >= DEMOTION_MIN_FAILURES:
            c = min(c * CONFIDENCE_DEMOTED_FACTOR, CONFIDENCE_DEMOTED_CAP)
            st.action = "demote"
            st.demote_candidate = True
        elif st.successes > 0:
            st.action = "reward"
        st.confidence_after = c
        stats[cid] = st
    return stats


# ---------------------------------------------------------------------------
# 落地：写 confidence / 人工确认降级
# ---------------------------------------------------------------------------

def apply_confidence(store_path: str, stats: dict[str, CardStats]) -> int:
    """--apply：按规则把 confidence_after 写入 experiences.confidence（返回更新行数）。"""
    db = sqlite3.connect(store_path)
    try:
        n = 0
        for cid, st in stats.items():
            if abs(st.confidence_after - st.confidence_before) < 1e-9:
                continue
            cur = db.execute("UPDATE experiences SET confidence=? WHERE id=?", (st.confidence_after, cid))
            n += cur.rowcount
        db.commit()
        return n
    finally:
        db.close()


def demote_cards(store_path: str, ids: list[str], batches: int = RESCORE_EXCLUDE_BATCHES) -> int:
    """--demote（人工确认通道）：active→dormant + rescore_excluded_batches=N。

    只处理 status='active' 的行；未知 id / 已 dormant 忽略。返回降级行数。
    """
    db = sqlite3.connect(store_path)
    try:
        cur = db.execute(
            "UPDATE experiences SET status='dormant', rescore_excluded_batches=? WHERE id IN (SELECT value FROM json_each(?)) AND status='active'",
            (batches, json.dumps(ids)),
        )
        db.commit()
        return cur.rowcount
    finally:
        db.close()


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _load_cards_meta(store_path: str) -> tuple[dict[str, dict], dict[str, float]]:
    """(id -> {type,title,payload}), (id -> confidence)。"""
    db = sqlite3.connect(f"file:{store_path}?mode=ro", uri=True)
    try:
        rows = db.execute("SELECT id, type, title, payload, COALESCE(confidence, 0.5) FROM experiences").fetchall()
    finally:
        db.close()
    meta: dict[str, dict] = {}
    conf: dict[str, float] = {}
    for cid, ctype, title, payload, confidence in rows:
        try:
            payload_dict = json.loads(payload) if isinstance(payload, str) else {}
        except json.JSONDecodeError:
            payload_dict = {}
        meta[cid] = {"type": ctype, "title": title, "payload": payload_dict}
        conf[cid] = float(confidence)
    return meta, conf


def _write_report(report_path: str, stats: dict[str, CardStats], samples: list[TaskDaySample],
                  skipped: int, evidence: str) -> None:
    demote_candidates = [cid for cid, st in sorted(stats.items()) if st.demote_candidate]
    report = {
        "evidence_source": evidence,
        "sample_count": len(samples),
        "manifest_skipped": skipped,
        "card_count": len(stats),
        "demote_candidates": demote_candidates,
        "cards": {cid: st.to_dict() for cid, st in sorted(stats.items())},
    }
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)


def run_attribution_cli(
    run_json: str,
    store: str | None = None,
    sessions_dir: str | None = None,
    injections: str | None = None,
    report: str | None = None,
    campaign_start_date: str = "2026-08-09",
    apply: bool = False,
) -> int:
    """主入口：证据源 → 样本 → 规则 → 报告（--apply 写 confidence）。"""
    if store:
        samples = build_samples_from_traces(store, run_json, campaign_start_date)
        evidence = f"request_traces({store})"
        meta, conf = _load_cards_meta(store)
        skipped = 0
    elif sessions_dir:
        samples = build_samples_from_sessions(sessions_dir, run_json, campaign_start_date)
        evidence = f"session experience_injection({sessions_dir})"
        meta, conf = {}, {}
        skipped = 0
    elif injections:
        samples, skipped = build_samples_from_manifest(injections, run_json)
        evidence = f"manifest({injections})"
        meta, conf = {}, {}
    else:
        sys.exit("必须指定一个证据源：--store / --sessions-dir / --injections")

    stats = compute_attribution(samples, cards_meta=meta, confidence=conf)
    if report:
        _write_report(report, stats, samples, skipped, evidence)
        print(f"attribution: {len(samples)} task-day samples, {len(stats)} cards, "
              f"{sum(1 for s in stats.values() if s.action == 'demote')} demoted, "
              f"{sum(1 for s in stats.values() if s.action == 'reward')} rewarded")
    if apply:
        if not store:
            sys.exit("--apply 需要 --store（写 confidence 必须落库）")
        n = apply_confidence(store, stats)
        print(f"apply: {n} confidence values written to {store}")
    return 0


def _cli(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="attribution",
                                     description="F2 实战归因奖惩：卡×结果关联 + confidence 奖惩（纯离线）")
    parser.add_argument("--run-json", required=True, help="run.jsonl（(day, task_id, arm) -> score）")
    parser.add_argument("--store", default=None, help="post-F0 experience.db（request_traces 证据源 / 落库目标）")
    parser.add_argument("--sessions-dir", default=None, help="session JSONL 目录（experience_injection 近似证据源）")
    parser.add_argument("--injections", default=None, help="显式注入清单 jsonl（issue-010 回放证据源）")
    parser.add_argument("--report", default=None, help="归因报告 JSON 输出路径")
    parser.add_argument("--campaign-start-date", default="2026-08-09",
                        help="campaign day1 日历日（ts → day 映射，默认 2026-08-09）")
    parser.add_argument("--apply", action="store_true", help="把 confidence_after 写入 experiences.confidence")
    parser.add_argument("--demote", default=None, help="人工确认降级：ids JSON 数组文件 → active→dormant + 复升排除")
    args = parser.parse_args(argv)

    if args.demote:
        if not args.store:
            sys.exit("--demote 需要 --store")
        ids = json.loads(Path(args.demote).read_text(encoding="utf-8"))
        n = demote_cards(args.store, ids)
        print(f"demote: {n} cards -> dormant (rescore_excluded_batches={RESCORE_EXCLUDE_BATCHES})")
        return 0

    return run_attribution_cli(
        run_json=args.run_json, store=args.store, sessions_dir=args.sessions_dir,
        injections=args.injections, report=args.report,
        campaign_start_date=args.campaign_start_date, apply=args.apply,
    )


if __name__ == "__main__":
    raise SystemExit(_cli())
