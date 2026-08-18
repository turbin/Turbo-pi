"""issue-010 补充回归：全组无交付组的零打分 + resume 一致性（决策 T3-6）。

T3 混合组处理：无交付轨迹不参与锦标赛——全组无交付时整组**零打分**直接
封顶（比打分后封顶更早拦截，省 LLM 调用）。主回归只覆盖单轨迹全封顶与
混合组（1 无交付 + 1 有交付）；本文件补多轨迹全无交付组的：

1. 零 LLM 调用（拦截前移）；无崩溃；全部封顶 0.49；
2. journal 语义：method="capped"、qualities 全 0.49（占位）；
3. resume 幂等：哈希命中、零调用、产物与新鲜逐位一致；
4. 混合组（2 有交付 + 1 无交付）：无交付不参与锦标赛、journal 按原组序
   回填（无交付占位 + 有交付真实分），resume 一致。

运行：cd packages/agent-server && uv run pytest python/tests/test_issue010_allcapped_group.py -q
"""

from __future__ import annotations

import json

from verification_selection.deliverables import DELIVERY_CAP_QUALITY
from verification_selection.pipeline import (
    TeacherTrajectory,
    score_trajectories_with_checkpoint,
)
from verification_selection.testing import make_scoring_mock
from verification_selection.verifier import LetterScale, Verifier

NO = "Run the tests, verify the fix with a checklist and edge case coverage."
DEL = "Run the tests, verify the fix with a checklist and edge case coverage.\nbash: cat > report.md <<EOF\ndone\nEOF"


def make_verifier():
    mock = make_scoring_mock(G=5, name="student-mock")
    return Verifier(mock, scale=LetterScale(G=5), K=1), mock


def test_all_no_deliverable_group_zero_scoring_and_no_crash(tmp_path):
    """全组无交付：零 LLM 调用、无崩溃、全部封顶（拦截前移，决策 T3-6）。"""
    rundir = tmp_path / "run"
    trajs = [
        TeacherTrajectory(task_id="task-x", task="assess the policy", trajectory=NO + " variant A"),
        TeacherTrajectory(task_id="task-x", task="assess the policy", trajectory=NO + " variant B"),
    ]
    verifier, mock = make_verifier()
    scored, tournaments = score_trajectories_with_checkpoint(trajs, verifier=verifier, run_dir=str(rundir))
    assert len(mock.calls) == 0  # 零打分
    assert tournaments == {}
    assert [(s.quality, s.deliverable_capped, s.accepted) for s in scored] == [
        (DELIVERY_CAP_QUALITY, True, False),
        (DELIVERY_CAP_QUALITY, True, False),
    ]

    entries = [json.loads(line) for line in (rundir / "scores.jsonl").read_text().splitlines()]
    assert entries[0]["method"] == "capped"
    assert entries[0]["qualities"] == [DELIVERY_CAP_QUALITY, DELIVERY_CAP_QUALITY]


def test_all_no_deliverable_group_resume_is_idempotent(tmp_path):
    """全组无交付 resume：哈希命中、零调用、产物逐位一致。"""
    rundir = tmp_path / "run"
    trajs = [
        TeacherTrajectory(task_id="task-x", task="assess the policy", trajectory=NO + " A"),
        TeacherTrajectory(task_id="task-x", task="assess the policy", trajectory=NO + " B"),
    ]
    verifier, _ = make_verifier()
    fresh, _ = score_trajectories_with_checkpoint(trajs, verifier=verifier, run_dir=str(rundir))

    verifier2, mock2 = make_verifier()
    resumed, _ = score_trajectories_with_checkpoint(trajs, verifier=verifier2, run_dir=str(rundir))
    assert len(mock2.calls) == 0
    sig = lambda scored: [(s.quality, s.accepted, s.deliverable_capped, s.method) for s in scored]
    assert sig(resumed) == sig(fresh)
    lines = (rundir / "scores.jsonl").read_text().splitlines()
    assert len(lines) == 1  # 不翻倍


def test_mixed_group_two_deliverables_one_not_journal_order_and_resume(tmp_path):
    """混合组（2 有交付 + 1 无交付）：锦标赛只含有交付轨迹；journal 按原组序回填。"""
    rundir = tmp_path / "run"
    # 两条有交付轨迹关键词信号不同（mock 锦标赛可区分：归一化分不相等）。
    del_a = (DEL + " and verify with edge cases and rollback")
    del_b = "bash: cat > report.md <<EOF\ndone\nEOF"  # 有交付标记、无正向关键词
    trajs = [
        TeacherTrajectory(task_id="task-y", task="assess the policy", trajectory=NO),
        TeacherTrajectory(task_id="task-y", task="assess the policy", trajectory=del_a),
        TeacherTrajectory(task_id="task-y", task="assess the policy", trajectory=del_b),
    ]
    verifier, mock = make_verifier()
    scored, tournaments = score_trajectories_with_checkpoint(trajs, verifier=verifier, run_dir=str(rundir))
    assert len(mock.calls) > 0
    assert list(tournaments.keys()) == ["task-y"]  # 锦标赛只含交付轨迹
    by_traj = {s.traj.trajectory: s for s in scored}
    assert by_traj[NO].deliverable_capped and by_traj[NO].quality == DELIVERY_CAP_QUALITY
    assert not by_traj[del_a].deliverable_capped and not by_traj[del_b].deliverable_capped

    # journal 按原组序（无交付占位 + 有交付真实分），且两个有交付分不相等（锦标赛区分）。
    entries = [json.loads(line) for line in (rundir / "scores.jsonl").read_text().splitlines()]
    q = entries[0]["qualities"]
    assert q[0] == DELIVERY_CAP_QUALITY
    assert q[1] != q[2] and q[1] > 0 and q[2] > 0

    # resume 逐位一致。
    verifier2, mock2 = make_verifier()
    resumed, _ = score_trajectories_with_checkpoint(trajs, verifier=verifier2, run_dir=str(rundir))
    assert len(mock2.calls) == 0
    sig = lambda scored: [(s.quality, s.accepted, s.deliverable_capped) for s in scored]
    assert sig(resumed) == sig(scored)
