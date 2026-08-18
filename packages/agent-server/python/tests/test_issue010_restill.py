"""issue-010 存量卡重蒸脚本（restill）冒烟测试。

覆盖点（issue-010 修复项 3，plans §2 F1-3）：
1. 从 active 卡导出定位源 session（evidence.task_id → sessions-dir/campaign-*/*.jsonl），
   优先 trace_span_ref 前缀匹配（同日多臂/多日同名 session 的去歧义键）；
2. 按新模板（含交付物维度）重打分 + 重蒸馏；源轨迹无交付物产出的旧卡
   重蒸时被交付检查自然淘汰（rejected_no_deliverable）；
3. 输出与主管线 cards.json 同构（可直喂 cardsToStaged）+ 逐卡 report；
4. 断点复用 M1 checkpoint 模块：--run-dir 打分落盘，二次运行幂等（零新增
   打分调用、产物逐位一致）。

运行：cd packages/agent-server && python3 -m pytest python/tests/test_issue010_restill.py -q
"""

from __future__ import annotations

import json

from verification_selection.restill import reduce_session, restill_cli

# 有交付的源 session：bash 写文件 → 交付检查通过。
GOOD_SESSION = [
    {"type": "session", "version": 3, "id": "sess-good",
     "metadata": {"task_id": "task_00091_assess_input_trust_model", "arm": "experiment"}},
    {"type": "message", "message": {"role": "system", "content": "office agent"}},
    {"type": "message", "message": {"role": "user", "content":
        "Write a security policy assessment to security_policy_assessment.md."}},
    {"type": "message", "message": {"role": "assistant", "content":
        "bash: cat > security_policy_assessment.md <<EOF\n# Security Policy Assessment\nEOF"}},
    {"type": "message", "message": {"role": "toolResult", "content":
        "# Security Policy Assessment\nEOF\nwritten 30 lines"}},
]

# 无交付的源 session：分析完整但从不写交付文件（issue-010 行为形态）。
NO_DELIVERABLE_SESSION = [
    {"type": "session", "version": 3, "id": "sess-nodeliv",
     "metadata": {"task_id": "task_00091_assess_input_trust_model", "arm": "experiment"}},
    {"type": "message", "message": {"role": "system", "content": "office agent"}},
    {"type": "message", "message": {"role": "user", "content":
        "Write a security policy assessment to security_policy_assessment.md."}},
    {"type": "message", "message": {"role": "assistant", "content":
        "I have completed the analysis; the assessment is ready for review."}},
]


def write_session(tmp_path, day_dir: str, name: str, lines) -> None:
    d = tmp_path / day_dir
    d.mkdir(parents=True, exist_ok=True)
    (d / name).write_text("\n".join(json.dumps(l, ensure_ascii=False) for l in lines) + "\n",
                          encoding="utf-8")


def make_active_cards_export(entries: list[dict]) -> str:
    """构造 active-cards.json 导出（store 行格式：payload 为 JSON 字符串）。"""
    rows = []
    for i, e in enumerate(entries):
        card = {
            "name": e.get("name", f"card-{i}"),
            "trigger": e.get("trigger", "Use when assessing a policy"),
            "procedure": e.get("procedure", "1) read 2) analyze"),
            "boundary": e.get("boundary", "Must not skip evidence"),
            "role": e.get("role", "Method"),
            "evidence": {"task_id": e["task_id"], "trace_span_ref": e.get("trace_span_ref", ""),
                         "verifier_score": 0.8},
        }
        rows.append({
            "id": e.get("id", f"exp-{i}"),
            "type": e.get("type", "ABILITY"),
            "title": card["name"],
            "payload": json.dumps(card, ensure_ascii=False),
            "quality": 0.8,
            "status": "active",
            "content_hash": f"hash-{i}",
        })
    return json.dumps(rows, ensure_ascii=False)


def strip_llm_env(monkeypatch) -> None:
    for key in ("LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL", "TEACHER_MODEL"):
        monkeypatch.delenv(key, raising=False)


def test_restill_redistills_with_deliverables_and_rejects_no_deliverable_sources(tmp_path, monkeypatch):
    """核心冒烟：有交付源卡重蒸成功（含 deliverables）；无交付源卡被交付检查淘汰。"""
    strip_llm_env(monkeypatch)

    sessions = tmp_path / "sessions"
    write_session(sessions, "campaign-d1", "experiment-task_00091_assess_input_trust_model.jsonl", GOOD_SESSION)
    write_session(sessions, "campaign-d2", "experiment-task_00091_assess_input_trust_model.jsonl",
                  NO_DELIVERABLE_SESSION)

    export = tmp_path / "active-cards.json"
    export.write_text(make_active_cards_export([
        {"id": "exp-old-good", "task_id": "experiment-task_00091_assess_input_trust_model",
         "trace_span_ref": "bash: cat > security_policy_assessment.md"},
        {"id": "exp-old-nodeliv", "task_id": "experiment-task_00091_assess_input_trust_model",
         "trace_span_ref": "I have completed the analysis"},
    ]), encoding="utf-8")

    out = tmp_path / "restilled-cards.json"
    report = tmp_path / "restill-report.json"
    rundir = tmp_path / "run"
    result = restill_cli(
        input_path=str(export), sessions_dir=str(sessions), output_path=str(out),
        report_path=str(report), run_dir=str(rundir),
    )
    assert result == 0

    cards = json.loads(out.read_text())
    rep = json.loads(report.read_text())
    # 有交付源 → 重蒸成功，新卡含非空 deliverables。
    assert len(cards) == 1
    assert cards[0]["card"]["role"] in ("Method", "Guard", "Workflow")
    assert isinstance(cards[0]["card"]["deliverables"], list) and len(cards[0]["card"]["deliverables"]) > 0
    # 无交付源 → 交付检查自然淘汰（重蒸即旧卡清退通道）。
    by_id = {r["old_id"]: r for r in rep["cards"]}
    assert by_id["exp-old-good"]["status"] == "restilled"
    assert by_id["exp-old-nodeliv"]["status"] == "rejected_no_deliverable"

    # 打分断点：journal 落盘；二次运行幂等（零新增打分调用、产物逐位一致）。
    assert (rundir / "scores.jsonl").exists()
    out2 = tmp_path / "restilled-cards2.json"
    report2 = tmp_path / "restill-report2.json"
    assert restill_cli(
        input_path=str(export), sessions_dir=str(sessions), output_path=str(out2),
        report_path=str(report2), run_dir=str(rundir),
    ) == 0
    assert out.read_text() == out2.read_text()
    assert report.read_text() == report2.read_text()
    lines = (rundir / "scores.jsonl").read_text().splitlines()
    assert len(lines) == 1  # 同一 task_id 双轨迹 = 一个 PPT 组；二次运行未追加


def test_restill_missing_session_is_reported_not_fatal(tmp_path, monkeypatch):
    """源 session 找不到的旧卡 → 记 rejected_missing_session，不中断整个批次。"""
    strip_llm_env(monkeypatch)

    sessions = tmp_path / "sessions"
    export = tmp_path / "active-cards.json"
    export.write_text(make_active_cards_export([
        {"id": "exp-ghost", "task_id": "experiment-task_99999_no_such_session"},
    ]), encoding="utf-8")

    out = tmp_path / "restilled-cards.json"
    report = tmp_path / "restill-report.json"
    assert restill_cli(
        input_path=str(export), sessions_dir=str(sessions), output_path=str(out),
        report_path=str(report),
    ) == 0
    assert json.loads(out.read_text()) == []
    rep = json.loads(report.read_text())
    assert rep["cards"][0]["status"] == "rejected_missing_session"


def test_restill_ignores_non_ability_cards(tmp_path, monkeypatch):
    """重蒸范围 = ABILITY（Method/Guard）卡：EVIDENCE 卡豁免（不在重蒸范围）。"""
    strip_llm_env(monkeypatch)

    sessions = tmp_path / "sessions"
    export = tmp_path / "active-cards.json"
    export.write_text(make_active_cards_export([
        {"id": "exp-evidence-1", "type": "EVIDENCE", "task_id": "whatever"},
    ]), encoding="utf-8")

    out = tmp_path / "restilled-cards.json"
    report = tmp_path / "restill-report.json"
    assert restill_cli(
        input_path=str(export), sessions_dir=str(sessions), output_path=str(out),
        report_path=str(report),
    ) == 0
    assert json.loads(out.read_text()) == []
    rep = json.loads(report.read_text())
    assert rep["summary"]["input_ability"] == 0
    assert rep["summary"]["skipped_not_ability"] == 1


def test_restill_reduces_session_like_collect_trajectories():
    """session 还原与 TS collectTrajectories 同语义：首条 user 为 task，assistant/toolResult 拼接。"""
    task, text = reduce_session(GOOD_SESSION)
    assert task == "Write a security policy assessment to security_policy_assessment.md."
    assert "bash: cat > security_policy_assessment.md" in text
    assert text.count("security_policy_assessment.md") == 1  # assistant 写文件命令一处
