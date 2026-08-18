"""F3/T4 补充回归：蒸馏 domain 不信任 LLM 自报（决策 T4-2）。

"domain 由轨迹来源自动打标（管线写入，不信任 LLM）"——抽取 LLM 即使产出
冲突的 domain 字段，管线也必须用 TeacherTrajectory.domain 覆盖。

主回归（test_issue012_domain_tags.py）的蒸馏用例中 mock teacher 输出的
domain 恰好也是 "office"，与 traj.domain 一致——**覆盖逻辑未被判别**。
本文件用产出冲突 domain 的自定义 extractor 锁定覆盖语义。

运行：cd packages/agent-server && uv run pytest python/tests/test_issue012_llm_domain_override.py -q
"""

from __future__ import annotations

import json
import re

from verification_selection.llm_client import MockLLM, messages_text
from verification_selection.pipeline import TeacherTrajectory, select_experiences
from verification_selection.testing import make_scoring_mock
from verification_selection.verifier import LetterScale, Verifier

DELIVERABLE_TRAJ = (
    "Run the tests, verify the fix with a checklist and edge case coverage.\n"
    "bash: cat > report.md <<EOF\nall green\nEOF"
)


def make_conflicting_domain_teacher(name: str = "lying-teacher") -> MockLLM:
    """抽取 mock：产出完整卡 JSON，但 domain 字段自报 "wenshu"（与轨迹来源冲突）。"""
    mock = MockLLM(name=name)
    single_traj_re = re.compile(r"Trajectory:\n<<<\n(.*?)\n>>>", re.S)

    def extract_pred(messages, **kw):
        return "mining reusable operational experience" in messages_text(messages)

    def extract_handler(messages, **kw):
        card = {
            "name": "compliance audit card",
            "trigger": "Use when auditing a security policy",
            "procedure": "1) read policy 2) cross-check logs 3) write the assessment file",
            "boundary": "Must not present findings without evidence",
            "role": "Method",
            "deliverables": ["1) write security_policy_assessment.md"],
            "domain": "wenshu",  # LLM 自报：与轨迹来源冲突
            "task_pattern": "compliance audit",
            "evidence": {},
        }
        return json.dumps(card, ensure_ascii=False)

    mock.add_rule(extract_pred, extract_handler)
    return mock


def test_llm_self_reported_domain_is_overridden_by_trajectory_domain():
    """冲突自报被覆盖：card.domain 必须来自轨迹来源（traj.domain），非 LLM 输出。"""
    mock = make_scoring_mock(G=5, name="student-mock")
    verifier = Verifier(mock, scale=LetterScale(G=5), K=1)
    traj = TeacherTrajectory(
        task_id="task_00091_x", task="assess the policy",
        trajectory=DELIVERABLE_TRAJ,
        domain="office",  # 轨迹来源（合成器元数据/注册表）
    )
    _, report = select_experiences(
        [traj], verifier=verifier, extractor=make_conflicting_domain_teacher(), return_report=True,
    )
    assert report.scored[0].card is not None
    card = report.scored[0].card
    assert card.domain == "office"  # 覆盖 LLM 自报的 "wenshu"
    # 其余 LLM 内容字段（task_pattern）保留。
    assert card.task_pattern == "compliance audit"


def test_llm_self_reported_domain_would_otherwise_leak():
    """判别性：若管线信任 LLM 自报（不覆盖），本测试的期望值即被破坏。"""
    mock = make_scoring_mock(G=5, name="student-mock")
    verifier = Verifier(mock, scale=LetterScale(G=5), K=1)
    traj = TeacherTrajectory(task_id="task_00091_x", task="assess the policy",
                             trajectory=DELIVERABLE_TRAJ, domain="office")
    _, report = select_experiences(
        [traj], verifier=verifier, extractor=make_conflicting_domain_teacher(), return_report=True,
    )
    assert report.scored[0].card is not None
    assert report.scored[0].card.to_dict()["domain"] != "wenshu"
