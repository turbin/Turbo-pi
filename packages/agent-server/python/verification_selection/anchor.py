"""Anchor oracle 诊断模式（EvoAgentBench §4.1 Anchor 条件）。

用 curator 标签做确定性 routing，作为自动 routing（FTS 检索）的对照上界。
注意：这是诊断参照物而非可部署方法——标签只用于检索，不进入经验条目文本。
"""
from __future__ import annotations

from .library import ExperienceLibrary, SearchHit


class AnchorOracleRouter:
    """确定性 cluster routing：task_id -> curator 标签（canonical unit id）-> 成员卡。

    labels: {task_id: [unit_id, ...]}，由构建侧（curator）持有。
    """

    def __init__(self, library: ExperienceLibrary, labels: dict[str, list[str]]):
        self.library = library
        self.labels = dict(labels)

    def route(self, task_id: str) -> list[SearchHit]:
        """按标签确定性取卡（不走 FTS），按质量降序。"""
        hits: list[SearchHit] = []
        for unit_id in self.labels.get(task_id, []):
            for row in self.library.cards_of_unit(unit_id):
                card = self.library.get_card(row["card_id"])
                if card is not None:
                    hits.append(SearchHit(row["card_id"], card, 1.0,
                                          float(row["quality"]), "anchor"))
        hits.sort(key=lambda h: -h.quality)
        return hits

    def route_unit_ids(self, task_id: str) -> list[str]:
        return list(self.labels.get(task_id, []))


def compare_routing(library: ExperienceLibrary, anchor: AnchorOracleRouter,
                    eval_tasks: list[dict], top_k: int = 5) -> list[dict]:
    """对照诊断：同一任务上 Anchor(oracle) 与 FTS(自动) 的命中差异。

    eval_tasks: [{"task_id":..., "query":...}]；返回每任务的重叠统计。
    """
    report: list[dict] = []
    for t in eval_tasks:
        anchor_hits = anchor.route(t["task_id"])
        fts_hits = library.search(t.get("query", ""), top_k=top_k)
        a_ids = {h.card_id for h in anchor_hits}
        f_ids = {h.card_id for h in fts_hits}
        report.append({
            "task_id": t["task_id"],
            "anchor_ids": sorted(a_ids),
            "fts_ids": sorted(f_ids),
            "overlap": len(a_ids & f_ids),
            "anchor_recall": (len(a_ids & f_ids) / len(a_ids)) if a_ids else 0.0,
        })
    return report
