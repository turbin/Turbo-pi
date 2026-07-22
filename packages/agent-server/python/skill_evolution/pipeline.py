"""五 agent 进化 pipeline：Analyzer / Retriever / Allocator / Proposer / Evolver。

- Analyzer / Proposer / Evolver：LLM 调用 + 结构化输出解析（经 llm_client 抽象层）。
- Retriever / Allocator：按简报 §7.2 默认规则化（tag 匹配 + 词袋余弦 / 停滞扩产效缩），
  保留 LLM 模式开关以便后续接回。
"""
from __future__ import annotations

import random
from dataclasses import dataclass, field
from typing import Any

from . import prompts
from .llm_client import LLMClient
from .parsing import llm_json
from .skillfile import cosine_sim, replace_section, tokenize
from .store import SkillStore


# ---------------------------------------------------------------------------
# 数据类
# ---------------------------------------------------------------------------


@dataclass
class Analysis:
    tag: str
    analysis: str
    failure_class: str  # "skill_fixable" | "capability_limit"
    target_skill: str = ""
    target_component: str = ""  # slow loop 专用
    concept: str = ""


@dataclass
class Inspiration:
    node_id: int
    tag: str
    utility: float
    delta_u: float
    cross_branch: bool
    snippet: str = ""

    def to_dict(self) -> dict:
        return {
            "node_id": self.node_id,
            "tag": self.tag,
            "utility": self.utility,
            "delta_u": self.delta_u,
            "cross_branch": self.cross_branch,
            "snippet": self.snippet,
        }


@dataclass
class Proposal:
    target_section: str
    change: str
    rationale: str
    replacement: str

    def to_dict(self) -> dict:
        return {
            "target_section": self.target_section,
            "change": self.change,
            "rationale": self.rationale,
            "replacement": self.replacement,
        }


@dataclass
class EvolveResult:
    new_text: str
    changed: bool
    empty_edit: bool  # hash 未变 → 标记空编辑
    notes: str = ""
    fallback: bool = False  # 是否走了确定性 splice 兜底


# ---------------------------------------------------------------------------
# Analyzer (ψ)
# ---------------------------------------------------------------------------


class Analyzer:
    """诊断最差失败样本；必须区分『skill 可解决失败 vs 基座能力上限』。"""

    def __init__(self, llm: LLMClient) -> None:
        self.llm = llm

    def analyze(self, failure: dict, psi_text: str) -> Analysis:
        data = llm_json(self.llm, prompts.analyzer_prompt(failure, psi_text))
        return Analysis(
            tag=str(data.get("tag", ""))[:80],
            analysis=str(data.get("analysis", "")),
            failure_class=(
                "capability_limit"
                if data.get("failure_class") == "capability_limit"
                else "skill_fixable"
            ),
            target_skill=str(data.get("target_skill", "SKILL.md")),
            concept=str(data.get("concept", "")),
        )

    def analyze_meta(
        self, meta_trace: dict, meta_state: dict[str, str], rr_component: str
    ) -> Analysis:
        """Constrained Analyzer：点名最受牵连的单个组件；无效/null → round-robin 兜底。

        slow loop 永不中止、不退化成 fast loop。
        """
        data = llm_json(self.llm, prompts.analyzer_meta_prompt(meta_trace, meta_state))
        target = data.get("target_component")
        if target not in prompts.META_COMPONENTS:
            target = rr_component  # round-robin 兜底
        return Analysis(
            tag=str(data.get("tag", "meta_stall"))[:80],
            analysis=str(data.get("analysis", "")),
            failure_class="skill_fixable",
            target_component=target,
        )


# ---------------------------------------------------------------------------
# Retriever (σ)：tag FTS 召回 + 词袋余弦重排（简报 §7.2 简化）
# ---------------------------------------------------------------------------


def _branch_root(branch_path: str) -> tuple[str, ...]:
    return tuple(branch_path.split(".")[:2])


class Retriever:
    """从 evolution DAG 检索 inspiration 节点（同 branch 优先，跨 branch 概率 p_cross）。"""

    def __init__(
        self,
        store: SkillStore,
        p_cross: float = 0.2,
        l_same: int = 3,
        l_cross: int = 2,
        overfetch: int = 3,
        rng: random.Random | None = None,
    ) -> None:
        self.store = store
        self.p_cross = p_cross
        self.l_same = l_same
        self.l_cross = l_cross
        self.overfetch = overfetch
        self.rng = rng or random.Random(0)

    def retrieve(self, tag: str, branch_path: str, exclude_ids: set[int] | None = None) -> list[Inspiration]:
        exclude = exclude_ids or set()
        # 1) FTS 超取 3×L；FTS 无命中时全表兜底
        limit = self.overfetch * (self.l_same + self.l_cross)
        candidates = [n for n in self.store.fts_search(tag, limit=limit * 2) if n["id"] not in exclude]
        if not candidates:
            candidates = [n for n in self.store.all_nodes(limit=100) if n["id"] not in exclude]
        # 2) 词袋余弦打分（tag + skill 开头 300 字）
        q_toks = tokenize(tag)
        root = _branch_root(branch_path)

        def score(node: dict) -> float:
            text = f"{node['tag']} {node['skill_text'][:300]}"
            return cosine_sim(q_toks, tokenize(text))

        ranked = sorted(candidates, key=lambda n: (score(n), n["utility"]), reverse=True)
        same = [n for n in ranked if _branch_root(n["branch_path"]) == root]
        cross = [n for n in ranked if _branch_root(n["branch_path"]) != root]

        picked: list[Inspiration] = [
            self._to_insp(n, cross_branch=False) for n in same[: self.l_same]
        ]
        if cross and self.rng.random() < self.p_cross:  # 跨 branch 检索概率
            picked.extend(self._to_insp(n, cross_branch=True) for n in cross[: self.l_cross])
        return picked

    @staticmethod
    def _to_insp(node: dict, cross_branch: bool) -> Inspiration:
        return Inspiration(
            node_id=node["id"],
            tag=node["tag"],
            utility=node["utility"],
            delta_u=node["delta_u"],
            cross_branch=cross_branch,
            snippet=node["skill_text"][:200],
        )


# ---------------------------------------------------------------------------
# Allocator (α)：规则化（停滞扩、产效缩）；LLM 模式可选
# ---------------------------------------------------------------------------


class Allocator:
    """决定本轮 child 预算 K∈[1, K_max]。默认规则化（简报 §7.2 允许）。"""

    def __init__(
        self,
        k_max: int = 3,
        eps: float = 0.01,
        mid: float = 0.05,
        use_llm: bool = False,
        llm: LLMClient | None = None,
    ) -> None:
        self.k_max = k_max
        self.eps = eps
        self.mid = mid
        self.use_llm = use_llm
        self.llm = llm

    def allocate(self, recent_delta_us: list[float], analysis: Analysis | None = None) -> int:
        if self.use_llm and self.llm is not None:
            data = llm_json(
                self.llm,
                prompts.allocator_prompt(recent_delta_us, (analysis.__dict__ if analysis else {}), self.k_max),
            )
            return max(1, min(self.k_max, int(data.get("K", 1))))
        recent = [float(x) for x in recent_delta_us[-3:]]
        if not recent:
            return 2  # 初始 K=2（附录 D 默认值）
        mean = sum(recent) / len(recent)
        if mean <= self.eps:
            return self.k_max  # 停滞 → 扩
        if mean < self.mid:
            return 2
        return 1  # 产效 → 缩


# ---------------------------------------------------------------------------
# Proposer (π)
# ---------------------------------------------------------------------------


class Proposer:
    """由 (f, a, I) 产出编辑 δ；K>1 时注入 diversity hint。"""

    def __init__(self, llm: LLMClient) -> None:
        self.llm = llm

    def propose(
        self,
        failure: dict,
        analysis: Analysis,
        inspirations: list[Inspiration],
        skill_text: str,
        pi_text: str,
        diversity_k: int = 1,
    ) -> Proposal:
        data = llm_json(
            self.llm,
            prompts.proposer_prompt(
                failure,
                analysis.__dict__,
                [i.to_dict() for i in inspirations],
                skill_text,
                pi_text,
                diversity_k=diversity_k,
            ),
        )
        return self._parse(data)

    def propose_meta(
        self,
        meta_trace: dict,
        analysis: Analysis,
        target_component: str,
        meta_file_text: str,
        pi_text: str,
    ) -> Proposal:
        data = llm_json(
            self.llm,
            prompts.proposer_meta_prompt(
                meta_trace, analysis.__dict__, target_component, meta_file_text, pi_text
            ),
        )
        return self._parse(data)

    @staticmethod
    def _parse(data: dict) -> Proposal:
        return Proposal(
            target_section=str(data.get("target_section", "")).lstrip("#").strip(),
            change=str(data.get("change", "")),
            rationale=str(data.get("rationale", "")),
            replacement=str(data.get("replacement", "")),
        )


# ---------------------------------------------------------------------------
# Evolver (ε)：LLM 落实编辑 + hash 校验 + 确定性 splice 兜底
# ---------------------------------------------------------------------------


class Evolver:
    """把 δ 落实为文件写入并验证（before/after hash 检查，标记空编辑）。"""

    def __init__(self, llm: LLMClient) -> None:
        self.llm = llm

    def evolve(self, current_text: str, proposal: Proposal, epsilon_text: str) -> EvolveResult:
        fallback = False
        notes = ""
        try:
            data = llm_json(self.llm, prompts.evolver_prompt(current_text, proposal.to_dict(), epsilon_text))
            new_text = str(data.get("new_content", ""))
            notes = str(data.get("notes", ""))
            # 一致性校验：replacement 的标志性片段须出现在新文本中，否则走兜底
            marker = proposal.replacement.strip()[:40]
            if not new_text or (marker and marker not in new_text):
                raise ValueError("LLM 输出与提案不一致")
        except Exception:
            # 确定性 splice 兜底（简报 §7.2：保留两层恢复即可）
            new_text = replace_section(current_text, proposal.target_section, proposal.replacement)
            fallback = True
            notes = (notes + " | fallback splice").strip(" |")
        # 规范化比较：消除行尾空白/连续空行差异，避免把纯空白差异误判为有效编辑
        empty = _norm(current_text) == _norm(new_text)
        return EvolveResult(
            new_text=new_text, changed=not empty, empty_edit=empty, notes=notes, fallback=fallback
        )


def _norm(text: str) -> str:
    """折叠连续空行并去除行尾空白（空编辑判定用）。"""
    out: list[str] = []
    for ln in (text or "").strip().splitlines():
        s = ln.rstrip()
        if s == "" and (not out or out[-1] == ""):
            continue
        out.append(s)
    return "\n".join(out).strip()


# ---------------------------------------------------------------------------
# agent-server offline CLI（ vendored into pi 时新增；handoff 原始代码以上为准 ）
#
#   python -m skill_evolution.pipeline --input trajectories.json --output skills.json \
#       [--benchmark benchmark.json] [--workdir DIR]
#
# MetaSkill-Evolve 的进化循环需要训练任务集（SPEC §4.2 step 2：teacher 跑
# no-skill 轨迹的 benchmark）才能评估 skill 效用；仅有会话轨迹无法运行。
# 未提供 --benchmark 时输出空数组并以 0 退出（在 stderr 说明原因）。
#
# benchmark.json: { "initial_skill": str, "samples": [{id, concept, question, solvable?}],
#                   "iterations": int? }
# output skills.json: get_active_skills() 的 {"catalog": [...], "skills": [...]} 扁平化列表，
# 每条 {name, summary, utility, content}。
# ---------------------------------------------------------------------------


def _cli(argv: list[str] | None = None) -> int:
    import argparse
    import json
    import os
    import shutil
    import sys
    import tempfile

    parser = argparse.ArgumentParser(prog="skill_evolution.pipeline")
    parser.add_argument("--input", required=True, help="trajectories.json 路径（当前未消费，保留接口）")
    parser.add_argument("--output", required=True, help="skills.json 输出路径")
    parser.add_argument("--benchmark", default=None, help="训练任务集 JSON；缺省时跳过进化")
    parser.add_argument("--workdir", default=None, help="SkillStore 落盘目录（默认临时目录）")
    args = parser.parse_args(argv)

    if not args.benchmark:
        print(
            "skill_evolution: no --benchmark provided; skipping evolution "
            "(training task set per SPEC §4.2 step 2 is not wired yet)",
            file=sys.stderr,
        )
        with open(args.output, "w", encoding="utf-8") as f:
            json.dump([], f)
        return 0

    from .evolution import EvolutionConfig, EvolutionRunner
    from .llm_client import MockLLM, OpenAICompatClient
    from .prompts import DEFAULT_META_SKILLS
    from .runtime import get_active_skills
    from .store import SkillStore

    with open(args.benchmark, encoding="utf-8") as f:
        bench = json.load(f)
    samples = bench.get("samples") or []
    initial_skill = str(bench.get("initial_skill") or "# Task Skill\n")
    iterations = int(bench.get("iterations") or 3)

    def eval_fn(skill_text: str, batch: list[dict]) -> list[dict]:
        out = []
        for s in batch:
            hit = bool(s.get("solvable", True) and s.get("concept") and s["concept"] in skill_text)
            out.append({"sample": s, "score": 1.0 if hit else 0.0, "output": "ok" if hit else "miss", "trace": ""})
        return out

    if os.environ.get("LLM_BASE_URL") and (os.environ.get("LLM_MODEL") or os.environ.get("TEACHER_MODEL")):
        llm = OpenAICompatClient.teacher_from_env()
    else:
        llm = MockLLM()

    workdir = args.workdir or tempfile.mkdtemp(prefix="skill-evolution-")
    owns_workdir = args.workdir is None  # 仅自动创建的临时目录在结束后清理
    try:
        store = SkillStore(workdir)
        runner = EvolutionRunner(store, llm, eval_fn, EvolutionConfig(max_iterations=iterations, H=2, seed=0))
        val = [s for s in samples if s.get("solvable", True)] or samples
        runner.seed(initial_skill, DEFAULT_META_SKILLS, val)
        for t in range(1, iterations + 1):
            rep = runner.run_iteration(t, samples, val)
            if rep.status == "all_passed":
                break

        payload = get_active_skills(store)
        store.close()
        out = payload["skills"]  # 全文 skill（get_active_skills top_n=1）
        with open(args.output, "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, indent=2)
        return 0
    finally:
        if owns_workdir:
            shutil.rmtree(workdir, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(_cli())
