"""issue-002 余留回归测试：离线管线打分阶段断点（最小断点）。

覆盖点（统一修改方案 §5 管线断点，2026-08-14 立项）：
1. 打分中间产物按 run 目录持久化（增量 append + fsync），带输入哈希
   （轨迹内容 + 打分 prompt 指纹），防脏复用；
2. 模拟打分阶段中途崩溃 → resume 后仅重跑未完成打分（哈希匹配跳过）；
3. resume 产物与全新跑一致（确定性 mock 下逐位一致）。

运行：cd packages/agent-server && python3 -m pytest python/tests/test_issue002_pipeline_resume.py -q
"""

from __future__ import annotations

import json

import pytest

from verification_selection.llm_client import MockLLM
from verification_selection.pipeline import (
    ScoredTrajectory,
    TeacherTrajectory,
    score_trajectories,
    score_trajectories_with_checkpoint,
)
from verification_selection.testing import make_scoring_mock
from verification_selection.verifier import LetterScale, Verifier

SCORE_CALLS_PER_PAIR = 3  # C=3 × K=1


def make_verifier() -> tuple[Verifier, MockLLM]:
    """确定性 mock verifier（G=5, K=1 → 每对 3 次 LLM 调用），返回 (verifier, mock)。"""
    mock = make_scoring_mock(G=5, name="student-mock")
    verifier = Verifier(mock, scale=LetterScale(G=5), K=1)
    return verifier, mock


def make_trajs() -> list[TeacherTrajectory]:
    """三组轨迹：task-a（双轨迹 PPT）+ task-b/task-c（单轨迹 vs_reference）。"""
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


class CrashOnTask:
    """在指定 task 的打分调用上抛异常的 verifier 包装（模拟中途崩溃）。"""

    def __init__(self, inner: Verifier, crash_task: str) -> None:
        self.inner = inner
        self.crash_task = crash_task

    def __getattr__(self, name: str):
        # 指纹计算读 verifier.criteria / scale / K，委托给内层。
        return getattr(self.inner, name)

    def score_pair(self, task: str, traj_a: str, traj_b: str, reasoning=None):
        if task == self.crash_task:
            raise RuntimeError(f"simulated crash while scoring {task}")
        return self.inner.score_pair(task, traj_a, traj_b, reasoning)

    def select_best(self, task: str, candidates: list[str], *, k: int = 3, rng=None):
        if task == self.crash_task:
            raise RuntimeError(f"simulated crash while scoring {task}")
        return self.inner.select_best(task, candidates, k=k, rng=rng)


def test_scoring_artifacts_persist_per_run_dir(tmp_path):
    """打分产物按 run 目录落盘；同输入再次打分零 LLM 调用（幂等跳过）。"""
    rundir = tmp_path / "run"
    trajs = make_trajs()

    verifier, mock = make_verifier()
    scored1, _ = score_trajectories_with_checkpoint(trajs, verifier=verifier, run_dir=str(rundir))
    calls_after_first = len(mock.calls)
    assert calls_after_first > 0

    # 产物落盘：每任务组一条。
    journal = rundir / "scores.jsonl"
    assert journal.exists()
    entries = [json.loads(line) for line in journal.read_text().splitlines()]
    assert {e["key"] for e in entries} == {"task-a", "task-b", "task-c"}

    # resume（同 run 目录）：全部哈希匹配 → 零新增 LLM 调用，结果一致。
    verifier2, mock2 = make_verifier()
    scored2, _ = score_trajectories_with_checkpoint(trajs, verifier=verifier2, run_dir=str(rundir))
    assert len(mock2.calls) == 0
    assert scored_signature(scored1) == scored_signature(scored2)


def test_resume_after_mid_scoring_crash_reruns_only_unfinished(tmp_path):
    """打分阶段中途崩溃：已完成组落盘；resume 只补未完成组，产物与全新跑一致。"""
    rundir = tmp_path / "run"
    trajs = make_trajs()

    # 参考：全新跑（无崩溃）的完整打分结果。
    verifier, _ = make_verifier()
    fresh, _ = score_trajectories_with_checkpoint(trajs, verifier=verifier, run_dir=str(tmp_path / "fresh"))

    # 崩溃跑：task-b 打分时抛异常——task-a 已完成并落盘，task-b/c 未完成。
    verifier, mock = make_verifier()
    with pytest.raises(RuntimeError, match="verify the fix"):
        score_trajectories_with_checkpoint(
            trajs, verifier=CrashOnTask(verifier, "verify the fix"), run_dir=str(rundir)
        )
    entries = [json.loads(line) for line in (rundir / "scores.jsonl").read_text().splitlines()]
    assert {e["key"] for e in entries} == {"task-a"}

    # resume：仅重跑未完成组（task-b + task-c = 6 次调用），task-a 跳过。
    verifier2, mock2 = make_verifier()
    resumed, _ = score_trajectories_with_checkpoint(trajs, verifier=verifier2, run_dir=str(rundir))
    assert len(mock2.calls) == 2 * SCORE_CALLS_PER_PAIR
    assert scored_signature(resumed) == scored_signature(fresh)
    # 全部组已落盘（增量补齐）。
    entries = [json.loads(line) for line in (rundir / "scores.jsonl").read_text().splitlines()]
    assert {e["key"] for e in entries} == {"task-a", "task-b", "task-c"}


def test_changed_trajectory_content_invalidates_cache(tmp_path):
    """输入哈希防脏复用：轨迹内容变化后该组必须重打。"""
    rundir = tmp_path / "run"
    trajs = make_trajs()
    verifier, _ = make_verifier()
    score_trajectories_with_checkpoint(trajs, verifier=verifier, run_dir=str(rundir))

    # task-b 轨迹内容变化（新 session 补录）→ 哈希不匹配 → 重打；其余跳过。
    changed = [t if t.task_id != "task-b" else TeacherTrajectory(
        task_id="task-b", task=t.task, trajectory="A completely different trajectory with backoff and retry."
    ) for t in trajs]
    verifier2, mock2 = make_verifier()
    rescored, _ = score_trajectories_with_checkpoint(changed, verifier=verifier2, run_dir=str(rundir))
    assert len(mock2.calls) == SCORE_CALLS_PER_PAIR  # 只有 task-b
    b = next(s for s in rescored if s.traj.task_id == "task-b")
    assert b.traj.trajectory.startswith("A completely different")


def test_malformed_journal_line_is_ignored_and_rescored(tmp_path):
    """损坏（半截）journal 行按未完成处理：resume 重打该组。"""
    rundir = tmp_path / "run"
    trajs = make_trajs()
    verifier, _ = make_verifier()
    # 崩溃跑：task-b 打分时崩溃 → journal 只有 task-a（task-b/c 从未落盘）。
    with pytest.raises(RuntimeError, match="verify the fix"):
        score_trajectories_with_checkpoint(
            trajs, verifier=CrashOnTask(verifier, "verify the fix"), run_dir=str(rundir)
        )
    # 崩溃现场：task-b 打分完成后 append 中断，留下半截行（无有效条目）。
    with (rundir / "scores.jsonl").open("a", encoding="utf-8") as f:
        f.write('{"key": "task-b", "input_hash": "torn')

    verifier2, mock2 = make_verifier()
    rescored, _ = score_trajectories_with_checkpoint(trajs, verifier=verifier2, run_dir=str(rundir))
    # task-a 跳过；task-b（条目损坏）+ task-c 重打。
    assert len(mock2.calls) == 2 * SCORE_CALLS_PER_PAIR
    assert [s.traj.task_id for s in rescored] == ["task-a", "task-a", "task-b", "task-c"]


def test_cli_persists_scores_and_resume_produces_identical_cards(tmp_path, monkeypatch):
    """CLI 端到端：--run-dir 落盘；同目录二次运行（resume）cards 产物逐位一致。"""
    for key in ("LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL", "TEACHER_MODEL"):
        monkeypatch.delenv(key, raising=False)

    from verification_selection.pipeline import _cli

    traj_path = tmp_path / "trajectories.json"
    traj_path.write_text(json.dumps([
        {"taskId": t.task_id, "task": t.task, "trajectory": t.trajectory} for t in make_trajs()
    ]))
    rundir = tmp_path / "run"

    cards1 = tmp_path / "cards1.json"
    assert _cli(["--input", str(traj_path), "--output", str(cards1), "--run-dir", str(rundir)]) == 0
    assert (rundir / "scores.jsonl").exists()

    cards2 = tmp_path / "cards2.json"
    assert _cli(["--input", str(traj_path), "--output", str(cards2), "--run-dir", str(rundir)]) == 0
    assert cards1.read_text() == cards2.read_text()
    # resume 幂等：journal 不因二次运行翻倍。
    lines = (rundir / "scores.jsonl").read_text().splitlines()
    assert len(lines) == 3


def test_rescore_cli_checkpoint(tmp_path, monkeypatch):
    """dormant 重打分同机制：--run-dir 落盘 + resume 跳过（journal 不翻倍）。"""
    for key in ("LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL", "TEACHER_MODEL"):
        monkeypatch.delenv(key, raising=False)

    from verification_selection.pipeline import _rescore_cli

    cand_path = tmp_path / "candidates.json"
    cand_path.write_text(json.dumps([
        {"task": "fix the flaky test", "text": "Run the tests, verify the fix with a checklist and edge case coverage.",
         "content_hash": "hash-good"},
        {"task": "", "text": "Guess the answer directly and skip all checks; the run ended in error.",
         "content_hash": "hash-bad"},
    ]))
    rundir = tmp_path / "run"

    out1 = tmp_path / "scores1.json"
    assert _rescore_cli(str(cand_path), str(out1), run_dir=str(rundir)) == 0
    out2 = tmp_path / "scores2.json"
    assert _rescore_cli(str(cand_path), str(out2), run_dir=str(rundir)) == 0
    assert out1.read_text() == out2.read_text()
    lines = (rundir / "rescore_scores.jsonl").read_text().splitlines()
    assert len(lines) == 2  # 二次运行全部跳过，未追加
    assert {json.loads(l)["key"] for l in lines} == {"hash-good", "hash-bad"}
