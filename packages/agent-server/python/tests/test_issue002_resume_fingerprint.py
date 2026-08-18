"""issue-002 余留补充回归：断点输入哈希的防脏复用边界（决策记录 T1-2）。

主回归文件（test_issue002_pipeline_resume.py）覆盖：产物落盘、崩溃→resume
只补未完成组、轨迹内容变化→该组重打、半截行重打、CLI 端到端幂等。
本文件补三个覆盖空洞：

1. prompt 指纹变化（G 从 5 改 8）→ 全部缓存失效，整库重打（指纹 = 模板 +
   参照轨迹 + 标准分解 + G + K，任一变化即全量失效）；
2. score_threshold **不参与**哈希（T1-2：质量与阈值正交）→ 同 run 目录换阈值
   resume 零 LLM 调用，accepted 按新阈值重算；
3. --resume 指向不存在的 run_dir → 当全新目录全量重打，不报错（决策边界 4）。

运行：cd packages/agent-server && uv run pytest python/tests/test_issue002_resume_fingerprint.py -q
"""

from __future__ import annotations

import json

from verification_selection.pipeline import (
    ScoredTrajectory,
    TeacherTrajectory,
    score_trajectories,
    score_trajectories_with_checkpoint,
)
from verification_selection.testing import make_scoring_mock
from verification_selection.verifier import LetterScale, Verifier


def make_verifier(G: int = 5) -> tuple[Verifier, object]:
    mock = make_scoring_mock(G=G, name="student-mock")
    return Verifier(mock, scale=LetterScale(G=G), K=1), mock


def make_trajs() -> list[TeacherTrajectory]:
    return [
        TeacherTrajectory(task_id="task-a", task="handle the backoff request",
                          trajectory="First check the checklist, then apply backoff with jitter and retry."),
        TeacherTrajectory(task_id="task-a", task="handle the backoff request",
                          trajectory="Guess the answer directly and skip the checklist; the run ended in error."),
        TeacherTrajectory(task_id="task-b", task="verify the fix",
                          trajectory="Run the tests, verify the fix with a checklist and edge case coverage."),
        TeacherTrajectory(task_id="task-c", task="deploy the service",
                          trajectory="Apply backoff with jitter, then rerun to confirm the deployment."),
    ]


def scored_signature(scored: list[ScoredTrajectory]) -> list[tuple[str, float, str, bool]]:
    return [(s.traj.task_id, round(s.quality, 6), s.method, s.accepted) for s in scored]


def test_prompt_fingerprint_change_invalidates_all_groups(tmp_path):
    """打分 prompt 指纹变化（G 5→8）→ 同 run 目录 resume 全量重打（缓存失效）。"""
    rundir = tmp_path / "run"
    trajs = make_trajs()

    # 第一次跑：G=5。
    verifier5, mock5 = make_verifier(G=5)
    score_trajectories_with_checkpoint(trajs, verifier=verifier5, run_dir=str(rundir))
    calls_g5 = len(mock5.calls)
    assert calls_g5 > 0

    # 同目录换 G=8 的 verifier resume：指纹不匹配 → 全部组重打，零跳过。
    verifier8, mock8 = make_verifier(G=8)
    scored8, _ = score_trajectories_with_checkpoint(trajs, verifier=verifier8, run_dir=str(rundir))
    assert len(mock8.calls) == calls_g5  # 全量重打（与首次跑调用数一致）

    # 与全新跑（无缓存）逐位一致。
    verifier8_fresh, _ = make_verifier(G=8)
    fresh8, _ = score_trajectories(trajs, verifier=verifier8_fresh)
    assert scored_signature(scored8) == scored_signature(fresh8)

    # journal 仍是 3 条（追加覆盖，不翻倍）。
    entries = [json.loads(line) for line in (rundir / "scores.jsonl").read_text().splitlines()]
    assert {e["key"] for e in entries} == {"task-a", "task-b", "task-c"}


def test_score_threshold_not_part_of_hash(tmp_path):
    """score_threshold 不参与哈希（T1-2）：换阈值 resume 零 LLM 调用，accepted 重算。"""
    rundir = tmp_path / "run"
    trajs = make_trajs()

    verifier, mock = make_verifier(G=5)
    scored_lo, _ = score_trajectories_with_checkpoint(trajs, verifier=verifier, run_dir=str(rundir),
                                                      score_threshold=0.5)
    assert len(mock.calls) > 0
    # 0.5 阈值下至少有一条 accepted（task-b 0.672 / task-c 0.622 均过闸）。
    assert any(s.accepted for s in scored_lo)

    # 同 run 目录、同 verifier、阈值 0.99：哈希仍匹配 → 零调用；accepted 全 False。
    verifier2, mock2 = make_verifier(G=5)
    scored_hi, _ = score_trajectories_with_checkpoint(trajs, verifier=verifier2, run_dir=str(rundir),
                                                      score_threshold=0.99)
    assert len(mock2.calls) == 0
    # 质量复用（与 0.5 阈值跑完全一致），闸门按新阈值重算。
    assert [round(s.quality, 6) for s in scored_hi] == [round(s.quality, 6) for s in scored_lo]
    assert all(not s.accepted for s in scored_hi)


def test_resume_nonexistent_run_dir_is_full_fresh_run(tmp_path):
    """--resume 指向不存在的 run_dir：mkdir 后当全新目录全量重打，不报错（决策边界 4）。"""
    nonexistent = tmp_path / "no" / "such" / "run"
    trajs = make_trajs()

    verifier, mock = make_verifier(G=5)
    scored, _ = score_trajectories_with_checkpoint(trajs, verifier=verifier, run_dir=str(nonexistent))
    assert len(mock.calls) > 0
    assert (nonexistent / "scores.jsonl").exists()
    entries = [json.loads(line) for line in (nonexistent / "scores.jsonl").read_text().splitlines()]
    assert {e["key"] for e in entries} == {"task-a", "task-b", "task-c"}
    assert scored_signature(scored) == scored_signature(
        score_trajectories(trajs, verifier=make_verifier(G=5)[0])[0]
    )
