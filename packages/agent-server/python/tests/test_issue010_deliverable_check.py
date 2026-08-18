"""issue-010 回归测试：交付物维度（F1 批次，T2 任务）。

覆盖点（issue-010 修复项 1/2/4，plans §2 F1）：
1. CARD_SCHEMA required 增加 deliverables：缺字段 / 空数组 / 非字符串项均拒绝；
2. EXTRACTION_PROMPT 含交付物提取要求（模板回归哨兵）；
3. 打分侧交付检查（物理拦截）：无交付物产出的轨迹 quality 封顶 <0.5 且
   accepted=False——即使下调 score_threshold 也无法放行；PPT 组按条封顶；
4. 豁免路径：dormant 重打分（--rescore，EVIDENCE 通道）不受交付检查影响。

运行：cd packages/agent-server && python3 -m pytest python/tests/test_issue010_deliverable_check.py -q
"""

from __future__ import annotations

import json

import pytest

from verification_selection.deliverables import DELIVERY_CAP_QUALITY, has_deliverable
from verification_selection.experience import (
    CARD_SCHEMA,
    ExperienceCard,
    SchemaError,
    validate_schema,
)
from verification_selection.pipeline import (
    EXTRACTION_PROMPT,
    TeacherTrajectory,
    score_trajectories,
)
from verification_selection.testing import make_scoring_mock
from verification_selection.verifier import LetterScale, Verifier


# ---------------------------------------------------------------------------
# 1) CARD_SCHEMA：deliverables 必填 + 内容约束
# ---------------------------------------------------------------------------

def make_card_dict(**overrides) -> dict:
    base = {
        "name": "assess with evidence appendix",
        "trigger": "Use when auditing a security policy",
        "procedure": "1) read policy 2) cross-check logs 3) write the assessment file",
        "boundary": "Must not present findings without evidence",
        "role": "Method",
        "deliverables": ["1) write security_policy_assessment.md", "2) include the evidence appendix"],
        "evidence": {"task_id": "task-010", "verifier_score": 0.8},
    }
    base.update(overrides)
    return base


def test_card_schema_requires_deliverables():
    """required 含 deliverables：缺失即校验失败（issue-010 修复项 1）。"""
    assert validate_schema(make_card_dict(), CARD_SCHEMA) == []
    errors = validate_schema({k: v for k, v in make_card_dict().items() if k != "deliverables"}, CARD_SCHEMA)
    assert any("deliverables" in e for e in errors)


def test_card_schema_rejects_empty_deliverables():
    """minItems=1：空清单即拒绝——空清单与缺失同义（无交付物维度）。"""
    errors = validate_schema(make_card_dict(deliverables=[]), CARD_SCHEMA)
    assert any("deliverables" in e for e in errors)


def test_card_schema_rejects_blank_or_non_string_deliverable_items():
    """items 约束：每个交付物必须是非空字符串。"""
    assert any("deliverables" in e for e in validate_schema(make_card_dict(deliverables=["ok", ""]), CARD_SCHEMA))
    assert any("deliverables" in e for e in validate_schema(make_card_dict(deliverables=["ok", 42]), CARD_SCHEMA))


def test_experience_card_strict_validation_requires_deliverables():
    """ExperienceCard 严格校验路径：from_dict(strict=True)/validate_strict 拒绝缺 deliverables 卡。"""
    data = {k: v for k, v in make_card_dict().items() if k != "deliverables"}
    with pytest.raises(SchemaError, match="deliverables"):
        ExperienceCard.from_dict(data, strict=True)
    # 非严格解析（LLM 先产出内容字段）容忍缺失，validate_strict 兜底拒绝。
    card = ExperienceCard.from_dict(data, strict=False)
    assert card.deliverables == []
    with pytest.raises(SchemaError, match="deliverables"):
        card.validate_strict()
    # to_dict 往返保留 deliverables。
    good = ExperienceCard.from_dict(make_card_dict(), strict=True)
    assert good.to_dict()["deliverables"] == make_card_dict()["deliverables"]


def test_extraction_prompt_asks_for_deliverables():
    """EXTRACTION_PROMPT 必须要求显式提取交付物清单（模板回归哨兵）。"""
    assert "deliverables" in EXTRACTION_PROMPT


# ---------------------------------------------------------------------------
# 2) 打分侧交付检查：无交付物产出 → quality 封顶 <0.5（物理拦截）
# ---------------------------------------------------------------------------

# 高质但"分析完整无交付"的轨迹（task_00091 D3 行为形态：读文件、交叉核对、
# 内联呈现评估，从不写 security_policy_assessment.md）。
NO_DELIVERABLE_TRAJ = (
    "The agent read the policy files, cross-checked the compliance checklist "
    "against the incident log, identified the gaps, and presented the full "
    "assessment inline in the chat without writing any file."
)
# 同一任务、同一分析强度，但完成交付（写目标文件）。
DELIVERABLE_TRAJ = (
    "The agent read the policy files, cross-checked the compliance checklist "
    "against the incident log, identified the gaps, and wrote the assessment.\n"
    "bash: cat > security_policy_assessment.md <<EOF\n"
    "# Security Policy Assessment\n"
    "## Evidence Appendix\n"
    "EOF"
)

HIGH_SCORE_TRAJ = "Run the tests, verify the fix with a checklist and edge case coverage."


def make_verifier() -> tuple[Verifier, object]:
    mock = make_scoring_mock(G=5, name="student-mock")
    return Verifier(mock, scale=LetterScale(G=5), K=1), mock


def test_has_deliverable_markers():
    """交付物产出检测：写文件操作/交付声明为真；纯分析为假。"""
    assert not has_deliverable(NO_DELIVERABLE_TRAJ)
    assert has_deliverable(DELIVERABLE_TRAJ)
    # 仅读文件（bash: cat ...）不算交付物产出。
    assert not has_deliverable("bash: cat ./policy/input_trust_policy_v2.yaml")
    # 显式交付声明（"written it to <file>"）算交付证据。
    assert has_deliverable("The assessment is complete; I've written it to `security_policy_assessment.md`.")


def test_no_deliverable_trajectory_is_capped_below_threshold():
    """封顶哨兵：无交付轨迹即使 verifier 打高分也被封顶 <0.5 且 accepted=False。"""
    verifier, _ = make_verifier()
    scored, _ = score_trajectories(
        [
            TeacherTrajectory(task_id="task-91", task="assess the security policy",
                              trajectory=HIGH_SCORE_TRAJ + "\n" + NO_DELIVERABLE_TRAJ),
        ],
        verifier=verifier,
    )
    assert len(scored) == 1
    st = scored[0]
    assert st.quality == DELIVERY_CAP_QUALITY
    assert not st.accepted
    assert st.deliverable_capped


def test_cap_is_independent_of_score_threshold():
    """物理拦截：下调 score_threshold 也不能让无交付轨迹入闸。"""
    verifier, _ = make_verifier()
    scored, _ = score_trajectories(
        [TeacherTrajectory(task_id="task-91", task="assess the security policy",
                           trajectory=HIGH_SCORE_TRAJ + "\n" + NO_DELIVERABLE_TRAJ)],
        verifier=verifier,
        score_threshold=0.2,
    )
    assert not scored[0].accepted
    assert scored[0].deliverable_capped


def test_deliverable_trajectory_keeps_verifier_quality():
    """有交付的轨迹不受封顶影响：quality 保持 verifier 原始分。"""
    verifier, _ = make_verifier()
    scored, _ = score_trajectories(
        [TeacherTrajectory(task_id="task-91", task="assess the security policy",
                           trajectory=HIGH_SCORE_TRAJ + "\n" + DELIVERABLE_TRAJ)],
        verifier=verifier,
    )
    st = scored[0]
    assert st.accepted
    assert not st.deliverable_capped
    assert st.quality >= 0.5


def test_ppt_group_caps_per_trajectory_not_per_group():
    """PPT 组内按轨迹封顶：同任务组中无交付轨迹封顶、有交付轨迹不受影响。"""
    verifier, _ = make_verifier()
    scored, _ = score_trajectories(
        [
            TeacherTrajectory(task_id="task-a", task="handle the backoff request",
                              trajectory="First check the checklist, then apply backoff with jitter and retry."),
            TeacherTrajectory(task_id="task-a", task="handle the backoff request",
                              trajectory="Apply backoff with jitter, then bash: cat > report.md <<EOF\ndone\nEOF"),
        ],
        verifier=verifier,
    )
    assert len(scored) == 2
    by_traj = {s.traj.trajectory: s for s in scored}
    no_del = by_traj["First check the checklist, then apply backoff with jitter and retry."]
    with_del = by_traj["Apply backoff with jitter, then bash: cat > report.md <<EOF\ndone\nEOF"]
    assert no_del.deliverable_capped and not no_del.accepted and no_del.quality == DELIVERY_CAP_QUALITY
    assert not with_del.deliverable_capped


def test_select_experiences_reports_deliverable_cap_reason():
    """select_experiences 对封顶轨迹给明确的跳过原因（交付检查），不抽卡。"""
    from verification_selection.pipeline import select_experiences
    from verification_selection.testing import make_teacher_mock

    verifier, _ = make_verifier()
    _, report = select_experiences(
        [TeacherTrajectory(task_id="task-91", task="assess the security policy",
                           trajectory=HIGH_SCORE_TRAJ + "\n" + NO_DELIVERABLE_TRAJ)],
        verifier=verifier,
        extractor=make_teacher_mock(),
        return_report=True,
    )
    assert report.scored[0].card is None
    assert any("交付" in reason or "deliverable" in reason.lower() for _, reason in report.skipped)


# ---------------------------------------------------------------------------
# 3) 豁免路径：EVIDENCE（dormant 重打分 --rescore）不受交付检查影响
# ---------------------------------------------------------------------------

def test_rescore_evidences_is_exempt_from_deliverable_cap(tmp_path, monkeypatch):
    """dormant EVIDENCE 重打分（--rescore）无交付物概念：无交付文本不封顶。"""
    for key in ("LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL", "TEACHER_MODEL"):
        monkeypatch.delenv(key, raising=False)

    from verification_selection.pipeline import _rescore_cli

    cand_path = tmp_path / "candidates.json"
    cand_path.write_text(json.dumps([
        {"task": "assess the security policy",
         "text": HIGH_SCORE_TRAJ + "\n" + NO_DELIVERABLE_TRAJ,
         "content_hash": "hash-evidence-010"},
    ]))
    out = tmp_path / "scores.json"
    assert _rescore_cli(str(cand_path), str(out)) == 0
    scores = json.loads(out.read_text())
    assert len(scores) == 1
    # EVIDENCE 通道不打交付检查：质量保持 verifier 原始偏好，不被封顶到 0.49。
    assert scores[0]["quality"] >= 0.5
