"""端到端经验筛选管线。

select_experiences(teacher_trajectories) -> library：
大模型轨迹 → 小模型 verifier 打分（PPT / 对参照轨迹的 Bradley-Terry 偏好）
→ 高分经验结构化（五元组 + JSON Schema 校验）→ 保守 canonicalize → 入 SQLite 库（FTS5）。
"""
from __future__ import annotations

import random
from dataclasses import dataclass, field

from .canonicalize import CanonResult, canonicalize
from .experience import ExperienceCard, SchemaError, parse_card_json
from .library import ExperienceLibrary
from .llm_client import LLMClient
from .verifier import TournamentResult, Verifier

# 单轨迹任务的对照参照：无策略、无验证的最小尝试（质量低于任何合格轨迹）
REFERENCE_TRAJECTORY = (
    "A minimal unstructured attempt: the agent guesses an answer directly in one step, "
    "with no plan, no retrieval and no validation phase; nothing is re-examined."
)

EXTRACTION_PROMPT = """You are mining reusable operational experience from a successful agent trajectory.

Task:
<<<
{task}
>>>

Trajectory:
<<<
{trajectory}
>>>

Verifier quality score: {quality:.3f} (continuous, 0-1).

Extract ONE experience card as a JSON object with exactly these fields:
- "name": short title
- "trigger": applicability condition starting with "Use when"
- "procedure": numbered actionable steps, e.g. "1) ... 2) ..."
- "boundary": a narrow non-transfer condition starting with "Must not"
- "role": one of "Method" | "Guard" | "Workflow"

Self-check (all must hold): grounded in a concrete trajectory span; actionable
operation rather than topic label or generic advice; boundary narrow enough to
prevent spurious transfer.

Reply with the JSON object only."""


@dataclass
class TeacherTrajectory:
    """大模型（teacher）轨迹。curator_label 仅用于 Anchor oracle routing，不进卡片文本。"""

    task_id: str
    task: str
    trajectory: str
    curator_label: str | None = None
    meta: dict = field(default_factory=dict)


@dataclass
class ScoredTrajectory:
    traj: TeacherTrajectory
    quality: float           # ∈ [0,1]：PPT 归一化 win mass 或对参照轨迹的偏好概率
    method: str              # "ppt" | "vs_reference"
    accepted: bool           # quality >= score_threshold
    card: ExperienceCard | None = None


@dataclass
class PipelineReport:
    """管线中间结果（供审计 / demo 打印）。"""

    scored: list[ScoredTrajectory]
    tournaments: dict[str, TournamentResult]   # task_id -> PPT 结果（多轨迹任务）
    canon: CanonResult | None
    skipped: list[tuple[str, str]]             # (task_id, 原因)
    library_stats: dict


def _extract_card(extractor: LLMClient, traj: TeacherTrajectory,
                  quality: float, backbone: str) -> ExperienceCard:
    """让大模型把高分轨迹结构化为五元组，evidence 由管线注入（不信任 LLM 自报）。"""
    prompt = EXTRACTION_PROMPT.format(task=traj.task, trajectory=traj.trajectory,
                                      quality=quality)
    # LLM 只产内容字段，evidence 由管线注入，故先非严格解析、注入后再严格校验
    card = parse_card_json(extractor.chat([{"role": "user", "content": prompt}]),
                           strict=False)
    card.evidence = {
        "task_id": traj.task_id,
        "backbone": backbone,
        "trace_span_ref": traj.trajectory[:120],
        "verifier_score": round(quality, 6),
        "target_ref": traj.curator_label or "",
    }
    card.validate_strict()
    return card


def select_experiences(
    teacher_trajectories: list[TeacherTrajectory],
    *,
    verifier: Verifier,
    extractor: LLMClient,
    library: ExperienceLibrary | None = None,
    judges: list[LLMClient] | None = None,
    score_threshold: float = 0.5,
    theta: float = 0.82,
    k: int = 3,
    backbone: str = "teacher",
    rng: random.Random | None = None,
    return_report: bool = False,
):
    """大模型轨迹 → 经验知识库。

    - 同 task_id 多轨迹：PPT 锦标赛，质量 = 归一化 win mass；
    - 单轨迹任务：对 REFERENCE_TRAJECTORY 的 Bradley-Terry 偏好概率；
    - quality >= score_threshold 的轨迹才被结构化为经验卡；
    - 全部卡片过保守 canonicalize 后入库（FTS5）。
    judges 缺省时复用 extractor 做 3 次投票（单模型×3 采样的简化方案）。
    """
    lib = library or ExperienceLibrary(":memory:")
    judge_list = judges or [extractor, extractor, extractor]
    rng = rng or random.Random(0)

    # 1) 按任务分组打分
    groups: dict[str, list[TeacherTrajectory]] = {}
    for t in teacher_trajectories:
        groups.setdefault(t.task_id, []).append(t)

    scored: list[ScoredTrajectory] = []
    tournaments: dict[str, TournamentResult] = {}
    for task_id, trajs in groups.items():
        if len(trajs) > 1:
            res = verifier.select_best(trajs[0].task, [t.trajectory for t in trajs],
                                       k=k, rng=rng)
            tournaments[task_id] = res
            for t, q in zip(trajs, res.normalized):
                scored.append(ScoredTrajectory(t, q, "ppt", q >= score_threshold))
        else:
            t = trajs[0]
            ps = verifier.score_pair(t.task, t.trajectory, REFERENCE_TRAJECTORY)
            scored.append(ScoredTrajectory(t, ps.preference, "vs_reference",
                                           ps.preference >= score_threshold))

    # 2) 高分轨迹结构化
    skipped: list[tuple[str, str]] = []
    kept: list[ScoredTrajectory] = []
    for st in scored:
        if not st.accepted:
            skipped.append((st.traj.task_id, f"质量分 {st.quality:.3f} < 阈值 {score_threshold}"))
            continue
        try:
            st.card = _extract_card(extractor, st.traj, st.quality, backbone)
            kept.append(st)
        except (SchemaError, ValueError) as e:
            skipped.append((st.traj.task_id, f"经验卡抽取/校验失败: {e}"))

    # 3) 保守 canonicalize + 入库（先入卡取真实 card_id，unit.members 才能正确引用）
    canon: CanonResult | None = None
    if kept:
        cards = [st.card for st in kept]
        qualities = [st.quality for st in kept]
        real_ids = [lib.add_card(st.card, st.quality, task_id=st.traj.task_id)
                    for st in kept]
        canon = canonicalize(cards, judge_list, theta=theta, card_ids=real_ids,
                             qualities=qualities)
        for idx, cid in enumerate(real_ids):
            lib.set_canonical_id(cid, canon.card_to_unit[idx])
        for unit in canon.units:
            lib.add_unit(unit)

    report = PipelineReport(scored=scored, tournaments=tournaments, canon=canon,
                            skipped=skipped, library_stats=lib.stats())
    if return_report:
        return lib, report
    return lib


# ---------------------------------------------------------------------------
# agent-server offline CLI（ vendored into pi 时新增；handoff 原始代码以上为准 ）
#
#   python -m verification_selection.pipeline --input trajectories.json --output cards.json
#
# input:  [{ "taskId": str, "task": str, "text": str, ... }]（agent-server 会话轨迹）
# output: [{ "taskId": str, "quality": float, "card": {五元组} }]
# 配置 LLM_BASE_URL + LLM_MODEL/TEACHER_MODEL 时走真实 OpenAI 兼容端点，
# 否则回退到确定性 MockLLM（离线联调用，不证明真实增益）。
# ---------------------------------------------------------------------------


def _cli(argv: list[str] | None = None) -> int:
    import argparse
    import json
    import os
    import random

    from .llm_client import OpenAICompatClient
    from .verifier import LetterScale

    parser = argparse.ArgumentParser(prog="verification_selection.pipeline")
    parser.add_argument("--input", required=True, help="trajectories.json 路径")
    parser.add_argument("--output", required=True, help="cards.json 输出路径")
    parser.add_argument("--score-threshold", type=float, default=0.5)
    args = parser.parse_args(argv)

    with open(args.input, encoding="utf-8") as f:
        raw = json.load(f)

    trajs: list[TeacherTrajectory] = []
    for i, item in enumerate(raw):
        text = str(item.get("trajectory") or item.get("text") or "")
        if not text.strip():
            continue
        trajs.append(
            TeacherTrajectory(
                task_id=str(item.get("taskId") or item.get("task_id") or f"task-{i}"),
                task=str(item.get("task") or ""),
                trajectory=text,
            )
        )

    if os.environ.get("LLM_BASE_URL") and (os.environ.get("LLM_MODEL") or os.environ.get("TEACHER_MODEL")):
        student = OpenAICompatClient(role="student")
        teacher = OpenAICompatClient(role="teacher")
        judges = None  # 缺省复用 extractor 三次投票
    else:
        from .testing import make_judge_mock, make_scoring_mock, make_teacher_mock

        student = make_scoring_mock()
        teacher = make_teacher_mock()
        judges = [make_judge_mock(f"judge-{i}") for i in range(3)]

    verifier = Verifier(student, scale=LetterScale(20), K=2)
    library, report = select_experiences(
        trajs,
        verifier=verifier,
        extractor=teacher,
        judges=judges,
        score_threshold=args.score_threshold,
        rng=random.Random(0),
        return_report=True,
    )
    out = [
        {
            "taskId": st.traj.task_id,
            "quality": round(st.quality, 6),
            "card": st.card.to_dict(),
        }
        for st in report.scored
        if st.card is not None
    ]
    library.close()
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli())
