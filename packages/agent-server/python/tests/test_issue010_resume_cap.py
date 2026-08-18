"""issue-010 补充回归：交付封顶与 M1 断点（resume 路径）的一致性（决策 T2-3/T2-6）。

主回归文件（test_issue010_deliverable_check.py）只测新鲜打分路径的封顶。
本文件补三个空洞：

1. **resume 路径封顶**：journal 命中复用缓存时，交付检查必须同样执行——
   "换一个 resume 时不重查交付、只按 qf >= threshold 放行的错实现"会放过
   无交付轨迹（下调阈值即入闸），现有测试（阈值用例只走新鲜路径）抓不到；
2. **M1→M2 缓存失效**：DELIVERY_CAP_VERSION 纳入打分指纹（T2-6）——旧格式
   （extra=""，M1 时代）journal 条目必须 hash 不匹配被重打，防止旧语义产物
   被复用；
3. **PPT 组 resume 按条封顶**：与新鲜路径逐位一致。

运行：cd packages/agent-server && uv run pytest python/tests/test_issue010_resume_cap.py -q
"""

from __future__ import annotations

import hashlib
import json

from verification_selection.checkpoint import input_hash, prompt_fingerprint
from verification_selection.deliverables import DELIVERY_CAP_QUALITY
from verification_selection.pipeline import (
    PAIRWISE_TEMPLATE,
    REFERENCE_TRAJECTORY,
    TeacherTrajectory,
    score_trajectories_with_checkpoint,
)
from verification_selection.testing import make_scoring_mock
from verification_selection.verifier import LetterScale, Verifier

# 高质但无交付的轨迹（task_00091 D3 形态：分析完整、从不写文件）。
NO_DELIVERABLE_TRAJ = (
    "The agent read the policy files, cross-checked the compliance checklist "
    "against the incident log, identified the gaps, and presented the full "
    "assessment inline in the chat without writing any file."
)
DELIVERABLE_TRAJ = (
    "The agent read the policy files, cross-checked the compliance checklist "
    "against the incident log, identified the gaps, and wrote the assessment.\n"
    "bash: cat > security_policy_assessment.md <<EOF\n# Security Policy Assessment\nEOF"
)


def make_verifier() -> tuple[Verifier, object]:
    mock = make_scoring_mock(G=5, name="student-mock")
    return Verifier(mock, scale=LetterScale(G=5), K=1), mock


def traj(task_id: str, text: str) -> TeacherTrajectory:
    return TeacherTrajectory(task_id=task_id, task="assess the security policy", trajectory=text)


def test_resume_path_reapplies_deliverable_cap(tmp_path):
    """resume 命中缓存时交付检查必须同样执行：下调阈值也不能让缓存无交付轨迹入闸。

    T3 混合组处理：无交付轨迹在组构造期即被拦截（零打分，直接封顶条目）——
    journal 存封顶值，resume 复用后仍必须保持 accepted=False（"resume 不重查
    交付"的错实现此处 accepted=True 而红）。
    """
    rundir = tmp_path / "run"
    t = traj("task-91", NO_DELIVERABLE_TRAJ)

    verifier, mock = make_verifier()
    scored1, _ = score_trajectories_with_checkpoint([t], verifier=verifier, run_dir=str(rundir))
    assert len(mock.calls) == 0  # 全组无交付：零打分（比打分后封顶更早拦截）
    assert scored1[0].deliverable_capped and not scored1[0].accepted
    assert scored1[0].quality == DELIVERY_CAP_QUALITY

    # resume + 下调阈值：哈希命中（零 LLM 调用），但封顶必须重放——
    # accepted 仍为 False（"resume 不重查交付"的错实现此处 accepted=True 而红）。
    verifier2, mock2 = make_verifier()
    scored2, _ = score_trajectories_with_checkpoint(
        [t], verifier=verifier2, run_dir=str(rundir), score_threshold=0.2,
    )
    assert len(mock2.calls) == 0
    assert scored2[0].deliverable_capped
    assert not scored2[0].accepted
    assert scored2[0].quality == DELIVERY_CAP_QUALITY


def test_resume_path_does_not_overcap_deliverable_trajectories(tmp_path):
    """resume 不误伤有交付轨迹：阈值下调后缓存的有交付轨迹正常入闸。"""
    rundir = tmp_path / "run"
    t = traj("task-92", DELIVERABLE_TRAJ)

    verifier, _ = make_verifier()
    score_trajectories_with_checkpoint([t], verifier=verifier, run_dir=str(rundir), score_threshold=0.9)

    verifier2, mock2 = make_verifier()
    scored2, _ = score_trajectories_with_checkpoint(
        [t], verifier=verifier2, run_dir=str(rundir), score_threshold=0.2,
    )
    assert len(mock2.calls) == 0
    st = scored2[0]
    assert not st.deliverable_capped
    assert st.accepted
    assert st.quality >= 0.5


def test_ppt_group_resume_caps_per_trajectory_identically(tmp_path):
    """PPT 组 resume：无交付/有交付两条轨迹的封顶与新鲜路径逐位一致。"""
    rundir = tmp_path / "run"
    trajs = [traj("task-a", NO_DELIVERABLE_TRAJ), traj("task-a", DELIVERABLE_TRAJ)]

    verifier, _ = make_verifier()
    fresh, _ = score_trajectories_with_checkpoint(trajs, verifier=verifier, run_dir=str(tmp_path / "fresh"))

    verifier2, mock2 = make_verifier()
    resumed, _ = score_trajectories_with_checkpoint(trajs, verifier=verifier2, run_dir=str(rundir))
    assert len(mock2.calls) > 0  # 首跑
    verifier3, mock3 = make_verifier()
    resumed2, _ = score_trajectories_with_checkpoint(trajs, verifier=verifier3, run_dir=str(rundir))
    assert len(mock3.calls) == 0  # resume 零调用

    sig = lambda scored: [(s.traj.trajectory, round(s.quality, 6), s.accepted, s.deliverable_capped) for s in scored]
    assert sig(resumed) == sig(fresh)
    assert sig(resumed2) == sig(fresh)


def test_m1_era_journal_without_cap_version_is_invalidated(tmp_path):
    """T2-6：M1 时代（extra=""）journal 条目 hash 不匹配 → 重写，旧语义产物不复用。"""
    rundir = tmp_path / "run"
    t = traj("task-93", NO_DELIVERABLE_TRAJ)

    # 模拟 M1 时代落盘的 journal：指纹不含 DELIVERY_CAP_VERSION（extra=""），
    # 且存的是"未封顶"的原始质量（旧语义产物）。
    verifier, mock = make_verifier()
    fp_old = prompt_fingerprint(
        PAIRWISE_TEMPLATE, REFERENCE_TRAJECTORY,
        [c.description for c in verifier.criteria], verifier.scale.G, verifier.K,
        extra="",
    )
    h_old = input_hash(fp_old, t.task, t.trajectory)
    rundir.mkdir(parents=True, exist_ok=True)
    with (rundir / "scores.jsonl").open("w", encoding="utf-8") as f:
        f.write(json.dumps({"key": "task-93", "input_hash": h_old, "method": "vs_reference",
                            "qualities": [0.85]}) + "\n")

    # 当前管线（指纹含 extra=DELIVERY_CAP_VERSION）：hash 不匹配 → 旧条目必须
    # 被新语义产物覆盖（无交付组零打分，直接封顶条目）；旧 0.85 绝不复用。
    verifier2, mock2 = make_verifier()
    scored, _ = score_trajectories_with_checkpoint([t], verifier=verifier2, run_dir=str(rundir))
    assert len(mock2.calls) == 0  # 无交付组：拦截发生在打分之前
    assert scored[0].deliverable_capped  # 新语义生效
    assert scored[0].quality == DELIVERY_CAP_QUALITY
    # journal 更新为新指纹条目（旧条目被 last-write-wins 覆盖）。
    entries = [json.loads(line) for line in (rundir / "scores.jsonl").read_text().splitlines()]
    assert entries[-1]["input_hash"] != h_old
    assert entries[-1]["qualities"] == [DELIVERY_CAP_QUALITY]
