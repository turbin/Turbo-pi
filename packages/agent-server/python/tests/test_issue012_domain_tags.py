"""issue-012 采纳项 5 / F3（T4）回归测试：情景标签（domain/task_pattern）。

覆盖点（plans §4 F3）：
1. CARD_SCHEMA 接受 domain/task_pattern（可选字符串，缺省 ""——存量卡兼容）；
   ExperienceCard 往返保留；
2. EXTRACTION_PROMPT 要求提取 task_pattern（模板回归哨兵）；
3. 蒸馏管线自动打标：TeacherTrajectory.domain → 抽取卡 card.domain（轨迹来源
   元数据透传）；wire 输入缺省时按任务→域注册表回退；
4. 任务→域注册表规则（alfworld / office / 未知→""）；
5. restill 重蒸顺带打标：session 元数据 domain 优先，注册表回退，默认 office。

运行：cd packages/agent-server && python3 -m pytest python/tests/test_issue012_domain_tags.py -q
"""

from __future__ import annotations

import json

from verification_selection.domains import task_domain
from verification_selection.experience import CARD_SCHEMA, ExperienceCard, validate_schema
from verification_selection.pipeline import EXTRACTION_PROMPT, TeacherTrajectory


def make_card_dict(**overrides) -> dict:
    base = {
        "name": "compliance audit",
        "trigger": "Use when auditing a security policy",
        "procedure": "1) read policy 2) cross-check logs 3) write the assessment file",
        "boundary": "Must not present findings without evidence",
        "role": "Method",
        "deliverables": ["1) write security_policy_assessment.md"],
        "evidence": {"task_id": "task-010", "verifier_score": 0.8},
    }
    base.update(overrides)
    return base


# ---------------------------------------------------------------------------
# 1) CARD_SCHEMA：domain/task_pattern 可选字段
# ---------------------------------------------------------------------------

def test_card_schema_accepts_domain_and_task_pattern():
    """domain/task_pattern 是可选字符串：带标签与不带标签均通过校验（存量兼容）。"""
    assert validate_schema(make_card_dict(), CARD_SCHEMA) == []
    assert validate_schema(make_card_dict(domain="office", task_pattern="compliance audit"), CARD_SCHEMA) == []
    errors = validate_schema(make_card_dict(domain=42), CARD_SCHEMA)
    assert any("domain" in e for e in errors)


def test_experience_card_roundtrip_keeps_domain_and_task_pattern():
    card = ExperienceCard.from_dict(make_card_dict(domain="office", task_pattern="compliance audit"), strict=True)
    out = card.to_dict()
    assert out["domain"] == "office"
    assert out["task_pattern"] == "compliance audit"
    # 缺省空串（旧格式卡兼容）。
    legacy = ExperienceCard.from_dict(make_card_dict(), strict=True)
    assert legacy.to_dict()["domain"] == ""
    assert legacy.to_dict()["task_pattern"] == ""


def test_extraction_prompt_asks_for_task_pattern():
    """EXTRACTION_PROMPT 必须要求提取 task_pattern（模板回归哨兵）。"""
    assert "task_pattern" in EXTRACTION_PROMPT


# ---------------------------------------------------------------------------
# 2) 蒸馏自动打标：轨迹来源 domain → 卡
# ---------------------------------------------------------------------------

def test_distilled_card_carries_trajectory_domain(tmp_path, monkeypatch):
    """TeacherTrajectory.domain → 抽取卡 card.domain（合成器元数据透传）。"""
    from verification_selection.pipeline import select_experiences
    from verification_selection.testing import make_scoring_mock, make_teacher_mock
    from verification_selection.verifier import LetterScale, Verifier

    mock = make_scoring_mock(G=5, name="student-mock")
    verifier = Verifier(mock, scale=LetterScale(G=5), K=1)
    traj = TeacherTrajectory(
        task_id="task-91", task="assess the policy",
        trajectory=("Run the tests, verify the fix with a checklist and edge case coverage.\n"
                    "bash: cat > report.md <<EOF\nall green\nEOF"),
        domain="office",
    )
    _, report = select_experiences(
        [traj], verifier=verifier, extractor=make_teacher_mock(), return_report=True,
    )
    assert report.scored[0].card is not None
    assert report.scored[0].card.to_dict()["domain"] == "office"
    assert isinstance(report.scored[0].card.to_dict()["task_pattern"], str)


def test_wire_domain_fallback_to_registry(tmp_path, monkeypatch):
    """CLI wire 输入缺 domain 时按 task_id 注册表回退打标。"""
    for key in ("LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL", "TEACHER_MODEL"):
        monkeypatch.delenv(key, raising=False)

    from verification_selection.pipeline import _cli

    traj_path = tmp_path / "trajectories.json"
    traj_path.write_text(json.dumps([
        {"taskId": "task_00091_security_policy_assessment", "task": "assess the policy",
         "trajectory": ("Run the tests, verify the fix with a checklist and edge case coverage.\n"
                        "bash: cat > report.md <<EOF\nall green\nEOF")},
    ]))
    out = tmp_path / "cards.json"
    assert _cli(["--input", str(traj_path), "--output", str(out)]) == 0
    cards = json.loads(out.read_text())
    assert len(cards) == 1
    assert cards[0]["card"]["domain"] == "office"


# ---------------------------------------------------------------------------
# 3) 任务→域注册表
# ---------------------------------------------------------------------------

def test_task_domain_registry_rules():
    assert task_domain("task_00091_security_policy_assessment_for_llm_assistant_input_trust_model") == "office"
    assert task_domain("task_00002_workspace_onboarding_and_identity_scaffold_skill") == "office"
    # session 级命名带臂前缀（C 库 evidence.task_id 形态）。
    assert task_domain("control-task_00002_workspace_onboarding_and_identity_scaffold_skill") == "office"
    assert task_domain("experiment-task_00091_security_policy_assessment") == "office"
    assert task_domain("alfworld_pick_clean_then_place") == "alfworld"
    assert task_domain("some_other_domain_task") == ""
    assert task_domain("") == ""
