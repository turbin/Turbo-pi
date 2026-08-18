"""存量卡重蒸脚本（issue-010 修复项 3，统一修改方案 §2 F1-3）。

背景：C 阶段入库的 ABILITY 卡（Method/Guard，现役 C 库 920 条 active 卡中
83 条）由旧 EXTRACTION_PROMPT 蒸馏，缺 deliverables（交付物清单）维度
（issue-010 根因 1）。修复定案为**重蒸**（否决 LLM 批量补字段：回填无验证
通道，质量不可控）：用新模板（含交付物维度）对每张 ABILITY 卡的源轨迹
重打分 + 重蒸馏。

本脚本对 active 卡导出中的每张 ABILITY 卡：
1. 定位源 session（evidence.task_id → sessions-dir/<campaign-dN>/<task_id>.jsonl；
   同日多臂/多日同名文件用 evidence.trace_span_ref 前缀匹配去歧义）；
2. 按新模板重打分（断点复用 M1 checkpoint 模块：--run-dir 落盘 + resume
   跳过已完成组）+ 重蒸馏；
3. **交付检查**（issue-010）：源轨迹无交付物产出 → quality 封顶 <0.5，
   该旧卡 rejected_no_deliverable——"分析完整但无交付"的旧卡重蒸即自然淘汰；
4. 输出与主管线 cards.json 同构的 staged 输出（可直喂 TS cardsToStaged）
   + 逐卡 report（旧卡 id → 新卡 / 淘汰原因，供审计与库替换）。

范围边界：只重蒸 ABILITY（Method/Guard）卡；EVIDENCE/SOP/SKILL 豁免
（EVIDENCE 无交付物概念、不经本管线）。EVIDENCE 卡不在重蒸范围。

CLI:
  python -m verification_selection.restill \
    --input active-cards.json --sessions-dir eval/sessions-synth \
    --output restilled-cards.json [--report restill-report.json] \
    [--run-dir var/offline/runs/restill-<ts>] [--score-threshold 0.5]

LLM 配置与 pipeline.py 同约定：LLM_BASE_URL + LLM_MODEL/TEACHER_MODEL 时
走真实 OpenAI 兼容端点，否则回退确定性 MockLLM（离线冒烟，不证明真实增益）。
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from .deliverables import DELIVERY_CAP_QUALITY
from .domains import task_domain
from .pipeline import TeacherTrajectory, _extract_card, score_trajectories_with_checkpoint
from .verifier import LetterScale, Verifier


def _session_domain(entries: list[dict], task_id: str) -> str:
    """session 头元数据 domain 优先（合成器透传），缺省按任务→域注册表回退。"""
    for entry in entries:
        if entry.get("type") == "session":
            meta = entry.get("metadata") or {}
            if isinstance(meta.get("domain"), str) and meta["domain"]:
                return meta["domain"]
            break
    return task_domain(task_id)


def reduce_session(entries: list[dict]) -> tuple[str, str]:
    """把 session JSONL 条目列表还原为 (task, trajectory_text)。

    与 TS collectTrajectories/parseSessionFile 同语义：第一条 user 文本为
    task；assistant/toolResult 文本按序拼接为轨迹文本（交付检测的输入）。
    """
    task = ""
    texts: list[str] = []

    def extract_text(content) -> str:
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            return "".join(
                p.get("text", "") for p in content
                if isinstance(p, dict) and p.get("type") == "text" and isinstance(p.get("text"), str)
            )
        return ""

    def record(message: dict) -> None:
        nonlocal task
        role = str(message.get("role", ""))
        if role == "user" and not task:
            task = extract_text(message.get("content"))
            return
        if role in ("assistant", "toolResult"):
            text = extract_text(message.get("content"))
            if text:
                texts.append(text)

    for entry in entries:
        if entry.get("type") == "message":
            record(entry.get("message") or entry)
            continue
        if entry.get("type") == "request":
            body = (entry.get("data") or {}).get("body") or {}
            for message in (body.get("context") or {}).get("messages", []):
                record(message)
    return task, "\n".join(texts)


def _read_session_lines(path: str) -> list[dict]:
    entries: list[dict] = []
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            entries.append(json.loads(line))
        except json.JSONDecodeError:
            continue  # 与 ETL 同纪律：malformed 行跳过
    return entries


def find_source_sessions(sessions_dir: str, task_id: str) -> list[tuple[str, str]]:
    """sessions-dir 下递归查找 <task_id>.jsonl，返回 [(路径, 天目录名)]（按天排序）。"""
    base = Path(sessions_dir)
    if not base.exists():
        return []
    found: list[tuple[str, str]] = []
    for day_dir in sorted(d for d in base.iterdir() if d.is_dir()):
        p = day_dir / f"{task_id}.jsonl"
        if p.exists():
            found.append((str(p), day_dir.name))
    return found


def _pick_source(candidates: list[tuple[str, str]], trace_span_ref: str) -> tuple[str, str] | None:
    """trace_span_ref 前缀匹配优先（轨迹文本以该片段开头）；无匹配取首日文件。"""
    if not candidates:
        return None
    if trace_span_ref:
        for path, day in candidates:
            try:
                task, text = reduce_session(_read_session_lines(path))
            except OSError:
                continue
            if text.startswith(trace_span_ref):
                return path, day
    return candidates[0]


def _parse_payload(payload) -> dict:
    if isinstance(payload, dict):
        return payload
    if isinstance(payload, str):
        try:
            data = json.loads(payload)
            return data if isinstance(data, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


def restill_cli(
    input_path: str,
    sessions_dir: str,
    output_path: str,
    report_path: str | None = None,
    run_dir: str | None = None,
    score_threshold: float = 0.5,
) -> int:
    """重蒸入口：active 卡导出 → staged cards.json + 逐卡 report。"""

    with open(input_path, encoding="utf-8") as f:
        rows = json.load(f)
    if not isinstance(rows, list):
        raise ValueError(f"{input_path}: 期望 JSON 数组（active 卡导出）")

    # 1) 过滤 ABILITY 卡（Method/Guard），解析 payload。
    ability: list[tuple[dict, dict]] = []  # (row, card_dict)
    skipped_not_ability = 0
    for row in rows:
        if row.get("type") != "ABILITY":
            skipped_not_ability += 1
            continue
        card = _parse_payload(row.get("payload"))
        if card.get("role") not in ("Method", "Guard"):
            skipped_not_ability += 1
            continue
        ability.append((row, card))

    # 2) 定位源 session，构造轨迹（去重：同 (task_id, 轨迹文本) 只打一次分）。
    cards: list[dict] = []
    trajs: list[TeacherTrajectory] = []
    seen: set[tuple[str, str]] = set()
    for row, card in ability:
        task_id = str(((card.get("evidence") or {}).get("task_id")) or "")
        span_ref = str(((card.get("evidence") or {}).get("trace_span_ref")) or "")
        rec = {"old_id": str(row.get("id") or ""), "old_quality": row.get("quality"),
               "task_id": task_id, "status": "rejected_missing_session", "source_session": ""}
        if task_id:
            picked = _pick_source(find_source_sessions(sessions_dir, task_id), span_ref)
            if picked:
                path, day = picked
                rec["source_session"] = f"{day}/{task_id}.jsonl"
                task, text = reduce_session(_read_session_lines(path))
                if text:
                    rec["_text"] = text
                    key = (task_id, text)
                    if key not in seen:
                        seen.add(key)
                        # F3 (T4): 重蒸顺带打标——session 元数据 domain 优先，
                        # 注册表回退（C 库默认 office，存量卡不单独回填）。
                        domain = _session_domain(_read_session_lines(path), task_id)
                        trajs.append(TeacherTrajectory(task_id=task_id, task=task,
                                                       trajectory=text, domain=domain))
                    rec["status"] = "pending"
        cards.append(rec)

    # 3) 重打分（断点：--run-dir 落盘 + resume 跳过；交付检查封顶在此生效）。
    if os.environ.get("LLM_BASE_URL") and (os.environ.get("LLM_MODEL") or os.environ.get("TEACHER_MODEL")):
        from .llm_client import OpenAICompatClient

        student = OpenAICompatClient()
        teacher = OpenAICompatClient.teacher_from_env()
    else:
        from .testing import make_scoring_mock, make_teacher_mock

        student = make_scoring_mock()
        teacher = make_teacher_mock()

    verifier = Verifier(student, scale=LetterScale(20), K=2)
    if trajs:
        scored, _ = score_trajectories_with_checkpoint(
            trajs, verifier=verifier, run_dir=run_dir,
            score_threshold=score_threshold,
        )
    else:
        scored = []

    def find_scored(task_id: str, text: str):
        for s in scored:
            if s.traj.task_id == task_id and s.traj.trajectory == text:
                return s
        return None

    # 4) 逐卡裁决：交付检查 / 质量 / 抽取。
    out_cards: list[dict] = []
    for rec in cards:
        if rec.get("status") != "pending":
            continue
        st = find_scored(rec["task_id"], rec.get("_text", ""))
        if st is None:
            rec["status"] = "rejected_missing_session"
        elif st.deliverable_capped:
            rec["status"] = "rejected_no_deliverable"
            rec["detail"] = f"源轨迹无交付物产出（质量封顶 {DELIVERY_CAP_QUALITY}，issue-010 交付检查）"
        elif not st.accepted:
            rec["status"] = "rejected_low_quality"
            rec["detail"] = f"重打分质量 {st.quality:.3f} < 阈值 {score_threshold}"
        else:
            traj = next(t for t in trajs if t.task_id == rec["task_id"] and t.trajectory == rec["_text"])
            try:
                new_card = _extract_card(teacher, traj, st.quality, backbone="restill")
            except Exception as e:  # SchemaError/ValueError：LLM 产出不合新模板
                rec["status"] = "rejected_extract_failed"
                rec["detail"] = str(e)
                continue
            rec["status"] = "restilled"
            rec["new_quality"] = round(st.quality, 6)
            out_cards.append({
                "taskId": st.traj.task_id,
                "quality": round(st.quality, 6),
                "card": new_card.to_dict(),
            })
        rec.pop("_text", None)

    # 5) 输出 staged cards.json（与主管线 CLI 同构）+ report。
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(out_cards, f, ensure_ascii=False, indent=2)
    if report_path:
        summary = {"input_ability": len(ability), "restilled": 0, "rejected_no_deliverable": 0,
                   "rejected_low_quality": 0, "rejected_extract_failed": 0,
                   "rejected_missing_session": 0, "skipped_not_ability": skipped_not_ability}
        for rec in cards:
            status = rec["status"]
            if status in summary:
                summary[status] += 1
        with open(report_path, "w", encoding="utf-8") as f:
            json.dump({"cards": cards, "summary": summary}, f, ensure_ascii=False, indent=2)
    return 0


def _cli(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(prog="verification_selection.restill",
                                     description="存量 ABILITY 卡用新模板（含交付物维度）重蒸")
    parser.add_argument("--input", required=True, help="active 卡导出（store 行格式 JSON 数组）")
    parser.add_argument("--sessions-dir", required=True, help="session 目录（含 campaign-dN/ 子目录）")
    parser.add_argument("--output", required=True, help="重蒸 cards.json 输出（与主管线 cards.json 同构）")
    parser.add_argument("--report", default=None, help="逐卡 report JSON 输出路径")
    parser.add_argument("--run-dir", default=None,
                        help="打分断点目录（复用 ScoreJournal：resume 跳过已完成打分）")
    parser.add_argument("--score-threshold", type=float, default=0.5)
    args = parser.parse_args(argv)
    return restill_cli(
        input_path=args.input, sessions_dir=args.sessions_dir, output_path=args.output,
        report_path=args.report, run_dir=args.run_dir, score_threshold=args.score_threshold,
    )


if __name__ == "__main__":
    raise SystemExit(_cli())
