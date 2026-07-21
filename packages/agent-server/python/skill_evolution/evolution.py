"""双时间尺度进化主循环：fast loop（每轮进化 task skill）+ slow loop（每 H=2 轮重写 meta-skill）
+ frontier selection（score = η1·U + η2·P̂ + η3·N）。

对齐简报 §4.2 Algorithm 1、§4.3 Algorithm 2、§4.1 式 4 与 §4.4 超参数默认值。
简化（按简报 §7.2）：K_m=1、Evolver 串行执行（论文为并行）、P̂ 取节点直接 child 的 ΔU 均值。
"""
from __future__ import annotations

import os
import random
import shutil
from dataclasses import dataclass, field
from typing import Any, Callable

from . import prompts
from .llm_client import LLMClient
from .pipeline import Allocator, Analyzer, Evolver, Proposer, Retriever
from .store import SkillStore

# eval_fn(skill_text, samples) -> [{"sample": dict, "score": float, "output": str, "trace": str}]
EvalFn = Callable[[str, list[dict]], list[dict]]


@dataclass
class EvolutionConfig:
    """超参数默认值照抄简报 §4.4 附录 D。"""

    eta1: float = 1.0
    eta2: float = 0.5
    eta3: float = 0.25
    k_frontier: int = 3
    k_max: int = 3
    H: int = 2  # meta-update horizon：每 2 轮 fast 迭代触发一次 slow loop
    alloc_eps: float = 0.01
    p_cross: float = 0.2
    l_same: int = 3
    l_cross: int = 2
    overfetch: int = 3
    max_iterations: int = 5
    early_stop: int = 5  # frontier 连续 5 轮无改进即停
    seed: int = 0


@dataclass
class IterationReport:
    iteration: int
    status: str  # ok | all_passed | capability_limit | early_stopped
    parent_id: int = 0
    tag: str = ""
    failure_class: str = ""
    k: int = 0
    children: list[dict] = field(default_factory=list)
    inspirations: list[int] = field(default_factory=list)
    slow_loop: dict | None = None
    frontier: list[dict] = field(default_factory=list)
    notes: str = ""


class EvolutionRunner:
    """进化调度器：restore → 评估 → 诊断 → 检索/分配 → 提案/落实 → commit → frontier 同步。"""

    def __init__(
        self,
        store: SkillStore,
        teacher_llm: LLMClient,
        eval_fn: EvalFn,
        config: EvolutionConfig | None = None,
        workdir: str | None = None,
    ) -> None:
        self.store = store
        self.llm = teacher_llm
        self.eval_fn = eval_fn
        self.cfg = config or EvolutionConfig()
        rng = random.Random(self.cfg.seed)
        self.analyzer = Analyzer(teacher_llm)
        self.retriever = Retriever(
            store,
            p_cross=self.cfg.p_cross,
            l_same=self.cfg.l_same,
            l_cross=self.cfg.l_cross,
            overfetch=self.cfg.overfetch,
            rng=rng,
        )
        self.allocator = Allocator(k_max=self.cfg.k_max, eps=self.cfg.alloc_eps)
        self.proposer = Proposer(teacher_llm)
        self.evolver = Evolver(teacher_llm)
        self.workdir = workdir or os.path.join(store.root, "worktree")
        self.meta_state: dict[str, str] = {}
        self._rr_index = 0  # slow loop round-robin 兜底指针
        self._child_log: list[dict] = []  # 全部 child 的 ΔU 日志（Allocator/slow loop 窗口用）
        self._best_frontier_score: float | None = None
        self._no_improve_rounds = 0

    # ------------------------------------------------------------------
    # 初始化
    # ------------------------------------------------------------------

    def seed(self, skill_text: str, meta_state: dict[str, str], val_samples: list[dict]) -> int:
        """创建 root 节点（初始 skill + 初始 meta），utility 在 val 上评估。"""
        self.meta_state = dict(meta_state)
        utility = self._utility(skill_text, val_samples)
        nid = self.store.add_node(
            parent_id=None,
            skill_text=skill_text,
            utility=utility,
            delta_u=0.0,
            tag="root",
            branch_path="0",
            meta_state=self.meta_state,
            iteration=0,
            status="archive",
        )
        return nid

    # ------------------------------------------------------------------
    # frontier selection：score = η1·U + η2·P̂ + η3·N（式 4）
    # ------------------------------------------------------------------

    def frontier_table(self) -> list[dict]:
        table = []
        for node in self.store.archive():
            p_hat = self.store.mean_child_delta(node["id"])
            novelty = 1.0 / (1.0 + node["times_selected"])
            score = (
                self.cfg.eta1 * node["utility"]
                + self.cfg.eta2 * p_hat
                + self.cfg.eta3 * novelty
            )
            table.append(
                {
                    "id": node["id"],
                    "utility": node["utility"],
                    "p_hat": round(p_hat, 6),
                    "novelty": round(novelty, 6),
                    "times_selected": node["times_selected"],
                    "score": round(score, 6),
                    "tag": node["tag"],
                }
            )
        table.sort(key=lambda r: (-r["score"], r["id"]))
        return table

    def select_parent(self) -> dict:
        """从 frontier（archive top-K_F）中选下一 parent，并累计 times_selected。"""
        table = self.frontier_table()[: self.cfg.k_frontier]
        if not table:
            raise RuntimeError("archive 为空，无法选择 parent")
        chosen = table[0]
        self.store.bump_times_selected(chosen["id"])
        node = self.store.get_node(chosen["id"])
        assert node is not None
        return node

    # ------------------------------------------------------------------
    # restore：把 DAG 快照恢复到磁盘（工作树只是临时载体）
    # ------------------------------------------------------------------

    def restore_to_disk(self, node: dict) -> str:
        if os.path.isdir(self.workdir):
            shutil.rmtree(self.workdir)
        os.makedirs(os.path.join(self.workdir, "meta"), exist_ok=True)
        with open(os.path.join(self.workdir, "SKILL.md"), "w", encoding="utf-8") as f:
            f.write(node["skill_text"])
        meta = node.get("meta_state") or self.meta_state
        for comp, text in meta.items():
            with open(os.path.join(self.workdir, "meta", f"{comp}.md"), "w", encoding="utf-8") as f:
                f.write(text)
        return self.workdir

    # ------------------------------------------------------------------
    # fast loop（Algorithm 1）
    # ------------------------------------------------------------------

    def run_iteration(self, t: int, train_batch: list[dict], val_batch: list[dict]) -> IterationReport:
        parent = self.select_parent()
        self.restore_to_disk(parent)
        report = IterationReport(iteration=t, status="ok", parent_id=parent["id"])

        # 1. 在 train batch 上收集失败
        results = self.eval_fn(parent["skill_text"], train_batch)
        failures = [r for r in results if float(r.get("score", 0.0)) < 1.0]
        if not failures:
            report.status = "all_passed"
            report.notes = "train batch 无失败样本"
            return report

        # 2. worst-case 诊断目标（高信号选择）
        worst = min(failures, key=lambda r: (float(r.get("score", 0.0)), str(r.get("sample", {}).get("id", ""))))
        failure = {**worst.get("sample", {}), "score": worst.get("score"), "output": worst.get("output", "")}

        # 3. Analyzer 诊断（区分 skill 可解决 vs 基座能力上限）
        analysis = self.analyzer.analyze(failure, self.meta_state.get("psi", ""))
        report.tag = analysis.tag
        report.failure_class = analysis.failure_class
        if analysis.failure_class == "capability_limit":
            # 基座能力上限：改写 skill 无意义，本轮跳过编辑（防止无谓改写）
            report.status = "capability_limit"
            report.notes = analysis.analysis
            return report

        # 4. Retriever / Allocator
        inspirations = self.retriever.retrieve(
            analysis.tag, parent["branch_path"], exclude_ids={parent["id"]}
        )
        report.inspirations = [i.node_id for i in inspirations]
        recent_dus = [c["delta_u"] for c in self._child_log[-3:]]
        k = self.allocator.allocate(recent_dus, analysis)
        report.k = k

        # 5. K 个 child：Proposer（含 diversity hint）→ Evolver → val 评估
        children: list[dict] = []
        for ki in range(1, k + 1):
            proposal = self.proposer.propose(
                failure, analysis, inspirations, parent["skill_text"],
                self.meta_state.get("pi", ""), diversity_k=ki,
            )
            evo = self.evolver.evolve(parent["skill_text"], proposal, self.meta_state.get("epsilon", ""))
            child_utility = self._utility(evo.new_text, val_batch)
            delta_u = child_utility - parent["utility"]
            children.append(
                {
                    "text": evo.new_text,
                    "utility": child_utility,
                    "delta_u": delta_u,
                    "tag": analysis.tag,
                    "change": proposal.change,
                    "empty_edit": evo.empty_edit,
                    "fallback": evo.fallback,
                    "inspirations": [i.node_id for i in inspirations],
                }
            )
            self._child_log.append(
                {"iteration": t, "tag": analysis.tag, "analysis": analysis.analysis, "delta_u": delta_u}
            )

        # 6. slow loop：t mod H == 0 时先刷新 meta-skill（child 携带刷新后的 meta）
        if t % self.cfg.H == 0:
            report.slow_loop = self.slow_loop(t, parent)

        # 7. commit children：ΔU>0 入 archive，否则 dormant（保留 provenance）
        for child in children:
            nid = self._commit_child(parent, child, t)
            child["node_id"] = nid
            child["status"] = "archive" if child["delta_u"] > 0 else "dormant"
        report.children = children

        # 8. frontier 同步 + early stopping 记账
        report.frontier = self.frontier_table()[: self.cfg.k_frontier]
        self._track_early_stop(report)
        return report

    def _commit_child(self, parent: dict, child: dict, t: int) -> int:
        seq = len(self.store.children_of(parent["id"])) + 1
        branch = f"{parent['branch_path']}.{seq}"
        status = "archive" if child["delta_u"] > 0 else "dormant"
        nid = self.store.add_node(
            parent_id=parent["id"],
            skill_text=child["text"],
            utility=child["utility"],
            delta_u=child["delta_u"],
            tag=child["tag"],
            branch_path=branch,
            meta_state=self.meta_state,  # 携带（可能已刷新的）meta 快照
            iteration=t,
            status=status,
        )
        self.store.add_edge(parent["id"], nid, "lineage")
        for insp_id in dict.fromkeys(child.get("inspirations", [])):
            self.store.add_edge(insp_id, nid, "inspiration")
        return nid

    def _track_early_stop(self, report: IterationReport) -> None:
        best = report.frontier[0]["score"] if report.frontier else None
        if best is not None and (self._best_frontier_score is None or best > self._best_frontier_score):
            self._best_frontier_score = best
            self._no_improve_rounds = 0
        else:
            self._no_improve_rounds += 1
        if self._no_improve_rounds >= self.cfg.early_stop:
            report.status = "early_stopped"

    # ------------------------------------------------------------------
    # slow loop（Algorithm 2，每 H 轮）：同一 pipeline 重写五个 meta SKILL.md
    # ------------------------------------------------------------------

    def slow_loop(self, t: int, parent: dict) -> dict:
        window = self._child_log[-self.cfg.H :]
        p_hat = sum(c["delta_u"] for c in window) / len(window) if window else 0.0
        meta_trace = prompts.build_meta_failure_trace(window, p_hat, t)

        # Constrained Analyzer + round-robin 兜底（slow loop 永不中止）
        rr = prompts.META_COMPONENTS[self._rr_index % len(prompts.META_COMPONENTS)]
        self._rr_index += 1
        meta_analysis = self.analyzer.analyze_meta(meta_trace, self.meta_state, rr)

        # whole-m rewrite：Proposer 串行逐组件、Evolver 落实（论文为并行，此处串行简化）
        new_meta: dict[str, str] = dict(self.meta_state)
        edits: dict[str, dict] = {}
        for comp in prompts.META_COMPONENTS:
            proposal = self.proposer.propose_meta(
                meta_trace, meta_analysis, comp, new_meta[comp], self.meta_state.get("pi", "")
            )
            evo = self.evolver.evolve(new_meta[comp], proposal, self.meta_state.get("epsilon", ""))
            new_meta[comp] = evo.new_text
            edits[comp] = {"change": proposal.change, "empty_edit": evo.empty_edit}

        snap_id = self.store.add_meta_snapshot(t, meta_analysis.tag, p_hat, new_meta)
        self.meta_state = new_meta
        return {
            "snapshot_id": snap_id,
            "p_hat": round(p_hat, 6),
            "tag": meta_analysis.tag,
            "target_component": meta_analysis.target_component,
            "rr_fallback_component": rr,
            "edits": edits,
        }

    # ------------------------------------------------------------------
    # 主循环
    # ------------------------------------------------------------------

    def run(
        self, train_samples: list[dict], val_samples: list[dict], n_iterations: int | None = None
    ) -> list[IterationReport]:
        n = n_iterations or self.cfg.max_iterations
        history: list[IterationReport] = []
        for t in range(1, n + 1):
            report = self.run_iteration(t, train_samples, val_samples)
            history.append(report)
            if report.status in ("all_passed", "early_stopped"):
                break
        return history

    # ------------------------------------------------------------------
    def _utility(self, skill_text: str, samples: list[dict]) -> float:
        if not samples:
            return 0.0
        results = self.eval_fn(skill_text, samples)
        return sum(float(r.get("score", 0.0)) for r in results) / len(results)
