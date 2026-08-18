"""端到端经验筛选管线。

select_experiences(teacher_trajectories) -> library：
大模型轨迹 → 小模型 verifier 打分（PPT / 对参照轨迹的 Bradley-Terry 偏好）
→ 高分经验结构化（五元组 + JSON Schema 校验）→ 保守 canonicalize → 入 SQLite 库（FTS5）。
"""
from __future__ import annotations

import random
from dataclasses import dataclass, field

from .canonicalize import CanonResult, canonicalize
from .checkpoint import ScoreJournal, input_hash, prompt_fingerprint
from .deliverables import DELIVERY_CAP_QUALITY, DELIVERY_CAP_VERSION, has_deliverable
from .experience import ExperienceCard, SchemaError, parse_card_json
from .library import ExperienceLibrary
from .llm_client import LLMClient
from .verifier import PAIRWISE_TEMPLATE, TournamentResult, Verifier

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
- "deliverables": the concrete outputs the task must produce when this card is
  applied — files, artifacts, or end state (e.g. "1) write report.md with the
  findings", "2) update state.json"); a non-empty list of strings
- "boundary": a narrow non-transfer condition starting with "Must not"
- "role": one of "Method" | "Guard" | "Workflow"

Self-check (all must hold): grounded in a concrete trajectory span; actionable
operation rather than topic label or generic advice; boundary narrow enough to
prevent spurious transfer; the final procedure step produces the deliverables
(the task is not complete until the deliverables exist).

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
    accepted: bool           # quality >= score_threshold 且未被交付检查拦截
    card: ExperienceCard | None = None
    deliverable_capped: bool = False  # issue-010 交付检查：轨迹无交付物产出 → 封顶拦截


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


def _prompt_fingerprint(verifier: Verifier) -> str:
    """打分 prompt 指纹：模板/参照轨迹/标准分解/G/K/交付检查版本任一变化即缓存失效。

    交付检查版本（DELIVERY_CAP_VERSION）纳入指纹：封顶语义属于打分产物的一部分，
    检测器变化时既有打分缓存（ScoreJournal）必须全部失效重打。
    """
    return prompt_fingerprint(
        PAIRWISE_TEMPLATE, REFERENCE_TRAJECTORY,
        [c.description for c in verifier.criteria],
        verifier.scale.G, verifier.K,
        extra=DELIVERY_CAP_VERSION,
    )


def _apply_deliverable_cap(quality: float, traj: TeacherTrajectory) -> tuple[float, bool]:
    """交付检查（issue-010）：轨迹无交付物产出 → quality 封顶 <0.5（物理拦截）。

    返回 (封顶后 quality, 是否被封顶)。封顶值 DELIVERY_CAP_QUALITY 严格低于
    主管线默认晋升阈值 0.5；被拦截轨迹的 accepted 恒为 False（不受
    score_threshold 下调影响），报告原因指向交付检查而非质量分。
    """
    if has_deliverable(traj.trajectory):
        return quality, False
    return min(quality, DELIVERY_CAP_QUALITY), True


def score_trajectories(
    teacher_trajectories: list[TeacherTrajectory],
    *,
    verifier: Verifier,
    score_threshold: float = 0.5,
    k: int = 3,
    rng: random.Random | None = None,
) -> tuple[list[ScoredTrajectory], dict[str, TournamentResult]]:
    """纯打分（无断点）：按任务组 PPT / vs_reference，返回 (scored, tournaments)。"""
    return score_trajectories_with_checkpoint(
        teacher_trajectories, verifier=verifier, run_dir=None,
        score_threshold=score_threshold, k=k, rng=rng,
    )


def score_trajectories_with_checkpoint(
    teacher_trajectories: list[TeacherTrajectory],
    *,
    verifier: Verifier,
    run_dir: str | None = None,
    score_threshold: float = 0.5,
    k: int = 3,
    rng: random.Random | None = None,
) -> tuple[list[ScoredTrajectory], dict[str, TournamentResult]]:
    """打分 + 断点（最小断点，2026-08-14 立项）：每任务组打分后立即落盘。

    run_dir 给定时读既有 journal：输入哈希（轨迹内容 + prompt 指纹）匹配的
    组直接复用（--resume 跳过已完成打分），不匹配/缺失的组重打并增量追加
    ——中途崩溃不丢已完成部分。run_dir 为 None 时零 IO，与纯打分一致。

    PPT 组在 resume 时不再重跑锦标赛，tournaments 只含本轮实际重打的组；
    mock 打分对输入确定性，resume 产物与全新跑一致。
    """
    rng = rng or random.Random(0)
    fp = _prompt_fingerprint(verifier)
    journal = ScoreJournal(run_dir, "scores.jsonl")
    cache = journal.load()

    groups: dict[str, list[TeacherTrajectory]] = {}
    for t in teacher_trajectories:
        groups.setdefault(t.task_id, []).append(t)

    scored: list[ScoredTrajectory] = []
    tournaments: dict[str, TournamentResult] = {}
    for task_id, trajs in groups.items():
        texts = [t.trajectory for t in trajs]
        h = input_hash(fp, trajs[0].task, *texts)
        cached = cache.get(task_id)
        if (cached is not None and cached.get("input_hash") == h
                and len(cached.get("qualities", [])) == len(trajs)):
            # --resume：输入哈希匹配的已完成打分直接复用（零 LLM 调用）。
            # 交付检查在复用路径同样执行（封顶幂等；检测器版本变化已由
            # 指纹 invalidate 全部旧缓存）。
            method = str(cached.get("method") or "vs_reference")
            for t, q in zip(trajs, cached["qualities"]):
                qf, capped = _apply_deliverable_cap(float(q), t)
                scored.append(ScoredTrajectory(t, qf, method, (not capped) and qf >= score_threshold,
                                               deliverable_capped=capped))
            continue
        # PPT 混合组交互（m2 test review finding ①，T3 处理）：无交付轨迹不参与
        # 锦标赛——它们在封顶后不可能产卡，参与只会以"verifier 高分"抢占归一化
        # 质量、拖低有交付伙伴（issue-010 教训：自评高分 ≠ 行为效用）。有交付
        # 轨迹相互竞争；全组无交付则零打分全部封顶（比打分后封顶更早拦截）。
        deliverable = [t for t in trajs if has_deliverable(t.trajectory)]
        if len(deliverable) > 1:
            res = verifier.select_best(trajs[0].task, [t.trajectory for t in deliverable], k=k, rng=rng)
            tournaments[task_id] = res
            qualities = list(res.normalized)
            method = "ppt"
        elif len(deliverable) == 1:
            t = deliverable[0]
            ps = verifier.score_pair(t.task, t.trajectory, REFERENCE_TRAJECTORY)
            qualities = [ps.preference]
            method = "vs_reference"
        else:
            qualities = []
            method = "capped"  # 全组无交付：零打分，全部封顶
        # 按原组顺序回填：有交付轨迹用其打分，无交付轨迹直接封顶（幂等）。
        quality_by_id = {id(t): q for t, q in zip(deliverable, qualities)}
        group_qualities = [quality_by_id.get(id(t), DELIVERY_CAP_QUALITY) for t in trajs]
        for t, q in zip(trajs, group_qualities):
            qf, capped = _apply_deliverable_cap(q, t)
            scored.append(ScoredTrajectory(t, qf, method, (not capped) and qf >= score_threshold,
                                           deliverable_capped=capped))
        journal.append(task_id, {"task_id": task_id, "input_hash": h,
                                 "method": method, "qualities": group_qualities})
    return scored, tournaments


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
    prescored: tuple[list[ScoredTrajectory], dict[str, TournamentResult]] | None = None,
):
    """大模型轨迹 → 经验知识库。

    - 同 task_id 多轨迹：PPT 锦标赛，质量 = 归一化 win mass；
    - 单轨迹任务：对 REFERENCE_TRAJECTORY 的 Bradley-Terry 偏好概率；
    - quality >= score_threshold 的轨迹才被结构化为经验卡；
    - 全部卡片过保守 canonicalize 后入库（FTS5）。
    judges 缺省时复用 extractor 做 3 次投票（单模型×3 采样的简化方案）。
    prescored 由 CLI 断点路径（score_trajectories_with_checkpoint）提供时跳过打分。
    """
    lib = library or ExperienceLibrary(":memory:")
    judge_list = judges or [extractor, extractor, extractor]
    rng = rng or random.Random(0)

    # 1) 按任务分组打分（prescored 提供时跳过——CLI 已在断点路径打过）
    if prescored is not None:
        scored, tournaments = prescored
    else:
        scored, tournaments = score_trajectories(
            teacher_trajectories, verifier=verifier, k=k, rng=rng,
            score_threshold=score_threshold,
        )

    # 2) 高分轨迹结构化（交付检查拦截的轨迹给明确原因，不抽卡）
    skipped: list[tuple[str, str]] = []
    kept: list[ScoredTrajectory] = []
    for st in scored:
        if st.deliverable_capped:
            skipped.append((st.traj.task_id,
                            f"轨迹无交付物产出，质量封顶 {DELIVERY_CAP_QUALITY}（issue-010 交付检查）"))
            continue
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
#   python -m verification_selection.pipeline --input trajectories.json --output cards.json --run-dir var/offline/runs/<ts>
#   python -m verification_selection.pipeline --rescore --input candidates.json --output scores.json [--run-dir <dir>]
#
# --run-dir（最小断点，2026-08-14）：打分结果按 run 目录增量落盘（scores.jsonl /
# rescore_scores.jsonl，带输入哈希 = 轨迹内容 + 打分 prompt 指纹）；再次以同一
# run-dir 运行（resume）时输入哈希匹配的已完成打分直接跳过，只补未完成部分。
# 中途崩溃不丢已完成部分（逐条 fsync）。
#
# input:  [{ "taskId": str, "task": str, "text": str, ... }]（agent-server 会话轨迹）
# output: [{ "taskId": str, "quality": float, "card": {五元组} }]
# 配置 LLM_BASE_URL + LLM_MODEL/TEACHER_MODEL 时走真实 OpenAI 兼容端点，
# 否则回退到确定性 MockLLM（离线联调用，不证明真实增益）。
#
# --rescore（SPEC §5.2/§6 Stage 3 的 dormant 候选重打分）：
# input:  [{ "task": str, "text": str, "content_hash": str }]（dormant EVIDENCE 载荷文本）
# output: [{ "content_hash": str, "quality": float }]（quality ∈ [0,1]，与主管线
#          vs_reference 口径一致：对 REFERENCE_TRAJECTORY 的 Bradley-Terry 偏好概率）
# ---------------------------------------------------------------------------


def _rescore_cli(input_path: str, output_path: str, run_dir: str | None = None) -> int:
    """对 dormant ETL 候选逐条重打分：候选文本 vs REFERENCE_TRAJECTORY 的偏好概率。

    复用主管线单轨迹任务的打分通路（Verifier.score_pair + vs_reference 口径），
    不引入新的打分框架；空候选数组输出 [] 并以 0 退出。
    run_dir 给定时按候选（content_hash）落盘 + resume 跳过（rescore_scores.jsonl）。
    """
    import json
    import os

    from .verifier import LetterScale

    with open(input_path, encoding="utf-8") as f:
        raw = json.load(f)

    candidates = [
        {
            "task": str(item.get("task") or ""),
            "text": str(item.get("text") or ""),
            "content_hash": str(item.get("content_hash") or ""),
        }
        for item in raw
    ]
    candidates = [c for c in candidates if c["text"].strip()]

    scores: list[dict] = []
    if candidates:
        if os.environ.get("LLM_BASE_URL") and (os.environ.get("LLM_MODEL") or os.environ.get("TEACHER_MODEL")):
            from .llm_client import OpenAICompatClient

            student = OpenAICompatClient()  # 打分只需 student；配置走环境变量
        else:
            from .testing import make_scoring_mock

            student = make_scoring_mock()
        verifier = Verifier(student, scale=LetterScale(20), K=2)
        fp = _prompt_fingerprint(verifier)
        journal = ScoreJournal(run_dir, "rescore_scores.jsonl")
        cache = journal.load()
        for c in candidates:
            key = c["content_hash"]
            h = input_hash(fp, c["task"], c["text"])
            cached = cache.get(key)
            if cached is not None and cached.get("input_hash") == h:
                # --resume：输入哈希匹配的已打分候选直接复用。
                scores.append({"content_hash": key, "quality": float(cached["quality"])})
                continue
            ps = verifier.score_pair(c["task"], c["text"], REFERENCE_TRAJECTORY)
            quality = round(ps.preference, 6)
            scores.append({"content_hash": key, "quality": quality})
            journal.append(key, {"content_hash": key, "input_hash": h, "quality": quality})

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(scores, f, ensure_ascii=False, indent=2)
    return 0


def _cli(argv: list[str] | None = None) -> int:
    import argparse
    import json
    import os
    import random

    from .llm_client import OpenAICompatClient
    from .verifier import LetterScale

    parser = argparse.ArgumentParser(prog="verification_selection.pipeline")
    parser.add_argument("--input", required=True, help="trajectories.json 路径（--rescore 时为 candidates.json）")
    parser.add_argument("--output", required=True, help="cards.json 输出路径（--rescore 时为 scores.json）")
    parser.add_argument("--score-threshold", type=float, default=0.5)
    parser.add_argument("--rescore", action="store_true",
                        help="dormant 候选重打分模式：输入 [{task, text, content_hash}]，输出 [{content_hash, quality}]")
    parser.add_argument("--run-dir", default=None,
                        help="打分断点目录：scores.jsonl 增量落盘；resume 时输入哈希匹配的已完成打分直接跳过")
    args = parser.parse_args(argv)

    if args.rescore:
        return _rescore_cli(args.input, args.output, run_dir=args.run_dir)

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
        student = OpenAICompatClient()  # 打分只需 student；配置走环境变量
        teacher = OpenAICompatClient.teacher_from_env()
        judges = None  # 缺省复用 extractor 三次投票
    else:
        from .testing import make_judge_mock, make_scoring_mock, make_teacher_mock

        student = make_scoring_mock()
        teacher = make_teacher_mock()
        judges = [make_judge_mock(f"judge-{i}") for i in range(3)]

    verifier = Verifier(student, scale=LetterScale(20), K=2)
    # 断点路径（--run-dir）：打分带增量落盘 + resume 跳过；否则纯打分。
    prescored = None
    if args.run_dir:
        scored, tournaments = score_trajectories_with_checkpoint(
            trajs, verifier=verifier, run_dir=args.run_dir,
            score_threshold=args.score_threshold, rng=random.Random(0),
        )
        prescored = (scored, tournaments)
    library, report = select_experiences(
        trajs,
        verifier=verifier,
        extractor=teacher,
        judges=judges,
        score_threshold=args.score_threshold,
        rng=random.Random(0),
        return_report=True,
        prescored=prescored,
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
