"""保守 canonicalization（EvoAgentBench §3.2.3 / §A.4 / §C）。

三段式：TF-IDF blocking 预筛（θ=0.82，仅召回候选，相似度永远不是 merge 判据）
→ 五条操作等价 rubric 的 LLM 裁决（Accept 需一致通过，非一致对保守判 Reject）
→ 兼容性图 + group consistency 检查（不做传递闭包；非全联通/含 Reject 边的
连通分量整体不合并，成员降级为 singleton，宁可缺边不可错边）。
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from itertools import combinations

from .experience import ExperienceCard
from .llm_client import LLMClient

# ---------------------------------------------------------------------------
# TF-IDF blocking（stdlib 实现，余弦相似度预筛）
# ---------------------------------------------------------------------------

_TOKEN_RE = re.compile(r"[a-z0-9_]+|[\u4e00-\u9fff]")


def _tokens(text: str) -> list[str]:
    return _TOKEN_RE.findall(text.lower())


def _tfidf_vectors(texts: list[str]) -> list[dict[str, float]]:
    """sklearn 风格 TF-IDF（idf = ln((1+N)/(1+df)) + 1），L2 归一化。"""
    n = len(texts)
    docs = [_tokens(t) for t in texts]
    df: dict[str, int] = {}
    for d in docs:
        for tok in set(d):
            df[tok] = df.get(tok, 0) + 1
    vecs: list[dict[str, float]] = []
    for d in docs:
        tf: dict[str, int] = {}
        for tok in d:
            tf[tok] = tf.get(tok, 0) + 1
        v = {tok: (cnt / len(d)) * (math.log((1 + n) / (1 + df[tok])) + 1.0)
             for tok, cnt in tf.items()} if d else {}
        norm = math.sqrt(sum(x * x for x in v.values())) or 1.0
        vecs.append({tok: x / norm for tok, x in v.items()})
    return vecs


def _cos(a: dict[str, float], b: dict[str, float]) -> float:
    if len(a) > len(b):
        a, b = b, a
    return sum(v * b.get(k, 0.0) for k, v in a.items())


def tfidf_blocking(cards: list[ExperienceCard], theta: float = 0.82
                   ) -> list[tuple[int, int, float]]:
    """TF-IDF 余弦 ≥ θ 的候选对（仅召回预筛，不构成 merge 依据）。返回 (i, j, sim)。"""
    vecs = _tfidf_vectors([c.blocking_text() for c in cards])
    pairs: list[tuple[int, int, float]] = []
    for i in range(len(cards)):
        for j in range(i + 1, len(cards)):
            sim = _cos(vecs[i], vecs[j])
            if sim >= theta:
                pairs.append((i, j, sim))
    return pairs


# ---------------------------------------------------------------------------
# LLM 裁决：五条操作等价 rubric
# ---------------------------------------------------------------------------

ACCEPT_LABELS = ("Same_Tactic", "Same_Strategy", "Same_Diagnostic")
REJECT_LABELS = ("Related_Only", "Different", "Conflict", "Invalid")
ALL_LABELS = ACCEPT_LABELS + REJECT_LABELS

RUBRIC_PROMPT = """You are adjudicating whether two experience cards describe the SAME operational tactic (operational equivalence, NOT semantic similarity).

Merge is allowed only if ALL five conditions hold:
1. Same role (Method / Guard / Workflow must match).
2. Compatible triggers (applicability conditions do not contradict).
3. Equivalent procedures — same mechanism, not merely same topic.
4. Same success mechanism or correction target.
5. Compatible boundaries.

Shared topic, lexical overlap, or generic verbs ('search', 'debug', 'validate') are explicitly INSUFFICIENT for merge.

Card A:
{card_a}

Card B:
{card_b}

Answer with exactly one label on the first line:
Same_Tactic | Same_Strategy | Same_Diagnostic | Related_Only | Different | Conflict | Invalid
Then one short line of rationale."""


@dataclass
class Adjudication:
    """一对卡片的裁决结果：Accept 需全部裁判一致通过；否则保守 Reject。"""

    i: int
    j: int
    accept: bool
    labels: list[str]
    similarity: float = 0.0


_LABEL_RE = re.compile(r"\b(" + "|".join(ALL_LABELS) + r")\b")


def _parse_label(text: str) -> str:
    m = _LABEL_RE.search(text)
    return m.group(1) if m else "Invalid"


def adjudicate_pair(card_a: ExperienceCard, card_b: ExperienceCard,
                    judges: list[LLMClient], *, i: int = -1, j: int = -1,
                    similarity: float = 0.0) -> Adjudication:
    """多裁判独立裁决；任一裁判不给 Accept 标签即保守判 Reject（替代人工复核队列）。"""
    if not judges:
        raise ValueError("judges 不能为空")
    prompt = RUBRIC_PROMPT.format(card_a=card_a.to_json(), card_b=card_b.to_json())
    messages = [{"role": "user", "content": prompt}]
    labels = [_parse_label(judge.chat(messages)) for judge in judges]
    accept = all(lab in ACCEPT_LABELS for lab in labels)
    return Adjudication(i=i, j=j, accept=accept, labels=labels, similarity=similarity)


# ---------------------------------------------------------------------------
# Canonical unit 与 group consistency（不做传递闭包）
# ---------------------------------------------------------------------------

@dataclass
class CanonicalUnit:
    """规范化能力单元（七元组的工程化落地）。"""

    unit_id: str
    role: str
    trigger: str
    procedure: str
    boundary: str
    members: list[str]          # member card id 列表
    support_tasks: list[str]    # 支持任务集 X_u
    evidence: list[dict]        # 聚合证据（跨任务）
    quality: float              # 成员最高 verifier 质量分

    def to_dict(self) -> dict:
        return {
            "unit_id": self.unit_id, "role": self.role, "trigger": self.trigger,
            "procedure": self.procedure, "boundary": self.boundary,
            "members": list(self.members), "support_tasks": list(self.support_tasks),
            "evidence": list(self.evidence), "quality": self.quality,
        }


@dataclass
class CanonResult:
    """canonicalization 结果：units + 卡片→unit 映射 + 全部中间决策（供审计）。"""

    units: list[CanonicalUnit]
    card_to_unit: dict[int, str]            # 卡片下标 -> unit_id
    candidate_pairs: list[tuple[int, int, float]]
    adjudications: list[Adjudication]
    inconsistent_components: list[list[int]]  # 因 group consistency 违规被拆散的分量


class _UnionFind:
    def __init__(self, n: int) -> None:
        self.parent = list(range(n))

    def find(self, x: int) -> int:
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[ra] = rb


def canonicalize(cards: list[ExperienceCard], judges: list[LLMClient], *,
                 theta: float = 0.82, card_ids: list[str] | None = None,
                 qualities: list[float] | None = None) -> CanonResult:
    """blocking → 裁决 → group consistency 的完整保守归并。

    - 只有 TF-IDF ≥ θ 的候选对才进入裁决；
    - 裁决非一致 Accept 的对记为 Reject（保守替代论文的专家复核）；
    - 连通分量内若并非所有内部对都 Accept（含从未成为候选的对），
      或存在内部 Reject 边，则整个分量不合并（不做传递闭包），成员各自成 unit。
    """
    n = len(cards)
    ids = card_ids or [f"card{i}" for i in range(n)]
    quals = qualities or [0.5] * n
    if len(ids) != n or len(quals) != n:
        raise ValueError("card_ids / qualities 长度必须与 cards 一致")

    pairs = tfidf_blocking(cards, theta)
    adjudications: list[Adjudication] = []
    accept_edges: set[frozenset] = set()
    reject_edges: set[frozenset] = set()
    for i, j, sim in pairs:
        adj = adjudicate_pair(cards[i], cards[j], judges, i=i, j=j, similarity=sim)
        adjudications.append(adj)
        (accept_edges if adj.accept else reject_edges).add(frozenset((i, j)))

    # group consistency：accept 边构成兼容性图，逐连通分量检查
    uf = _UnionFind(n)
    for e in accept_edges:
        a, b = tuple(e)
        uf.union(a, b)
    comps: dict[int, list[int]] = {}
    for i in range(n):
        comps.setdefault(uf.find(i), []).append(i)

    units: list[CanonicalUnit] = []
    card_to_unit: dict[int, str] = {}
    inconsistent: list[list[int]] = []

    def emit_unit(members: list[int]) -> None:
        rep = max(members, key=lambda m: quals[m])  # 代表卡 = 质量最高成员
        unit_id = f"U{len(units) + 1:04d}"
        tasks = sorted({str(cards[m].evidence.get("task_id", "")) for m in members} - {""})
        unit = CanonicalUnit(
            unit_id=unit_id,
            role=cards[rep].role,
            trigger=cards[rep].trigger,
            procedure=cards[rep].procedure,
            boundary=cards[rep].boundary,
            members=[ids[m] for m in members],
            support_tasks=tasks,
            evidence=[dict(cards[m].evidence) for m in members],
            quality=max(quals[m] for m in members),
        )
        units.append(unit)
        for m in members:
            card_to_unit[m] = unit_id

    for comp in comps.values():
        comp = sorted(comp)
        if len(comp) == 1:
            emit_unit(comp)
            continue
        internal = [frozenset(p) for p in combinations(comp, 2)]
        fully_compatible = all(p in accept_edges for p in internal)
        has_reject = any(p in reject_edges for p in internal)
        if fully_compatible and not has_reject:
            emit_unit(comp)  # 全部内部对一致 Accept，才允许合并
        else:
            inconsistent.append(comp)  # 非一致分量：保守拆散为 singleton
            for m in comp:
                emit_unit([m])

    return CanonResult(units=units, card_to_unit=card_to_unit,
                       candidate_pairs=pairs, adjudications=adjudications,
                       inconsistent_components=inconsistent)
