"""Verifier：字母刻度连续评分 + Bradley-Terry 偏好 + PPT 锦标赛 + 两阶段打分。

复现自《LLM-as-a-Verifier》(arXiv:2607.05391)：
- 字母刻度 A-T（G<=20），保证每个分数档是单 token，logprob 期望化才成立（Eq.3.1）；
- 对返回的 top-logprobs 过滤出评分 token 子集后 renormalize，缺失档按 0 处理；
- G（粒度）/ K（重复）/ C（标准分解，默认 C=3：Specification/Output/Errors）三轴可配；
- Bradley-Terry 偏好概率 P(τ_i≻τ_j) = σ(R_i − R_j)（Eq.3.2）；
- Probabilistic Pivot Tournament（Algorithm 1，k=3 起步）做 N 选 1，
  ring pass 让每个候选在 A/B 位各出现一次以消位置偏差；
- 两阶段打分通路（B.6）：大模型产 <reasoning>，小模型在其后产评分分布（打分浅层化），
  reasoning 可缓存进知识库。
"""
from __future__ import annotations

import hashlib
import math
import random
import re
from dataclasses import dataclass, field
from itertools import combinations
from typing import Callable, Protocol

from .llm_client import LLMClient

LETTERS = "ABCDEFGHIJKLMNOPQRST"  # A-T，最多 20 档


class ScoreExtractionError(RuntimeError):
    """评分 token 分布提取失败（响应中没有评分标签或没有任何评分 token）。"""


# ---------------------------------------------------------------------------
# 字母刻度
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class LetterScale:
    """G 档字母刻度：tokens = A..(A+G-1)，φ(token) = 1..G 线性映射。"""

    G: int = 20

    def __post_init__(self) -> None:
        if not 2 <= self.G <= len(LETTERS):
            raise ValueError(f"G 必须在 [2, {len(LETTERS)}]，收到 {self.G}")

    @property
    def tokens(self) -> list[str]:
        return list(LETTERS[: self.G])

    @property
    def token_set(self) -> set[str]:
        return set(self.tokens)

    def phi(self, token: str) -> float:
        return float(self.tokens.index(token) + 1)

    @property
    def phi_min(self) -> float:
        return 1.0

    @property
    def phi_max(self) -> float:
        return float(self.G)

    def normalize(self, raw: float) -> float:
        """把 1..G 的原始期望分线性归一化到 [0,1]。"""
        return (raw - self.phi_min) / (self.phi_max - self.phi_min)

    def mapping_text(self) -> str:
        mid = self.G // 2
        return (f"{self.tokens[0]}=1 (incorrect), {self.tokens[mid]}={mid + 1} (borderline), "
                f"{self.tokens[-1]}={self.G} (correct); 中间档按字母序线性递增")


# ---------------------------------------------------------------------------
# 标准分解（C 轴，默认 C=3）
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Criterion:
    name: str
    description: str


DEFAULT_CRITERIA: tuple[Criterion, ...] = (
    Criterion("Specification",
              "Does the trajectory satisfy all requirements stated in the task?"),
    Criterion("Output",
              "Is the final output/result in the expected form and correct?"),
    Criterion("Errors",
              "Is the trajectory free of failure signals (errors, exceptions, failed tool outputs)?"),
)


# ---------------------------------------------------------------------------
# 连续分数：top-logprobs 子集 renormalize 后取期望
# ---------------------------------------------------------------------------

def expected_from_top_logprobs(top_logprobs: list[dict], scale: LetterScale) -> float:
    """对评分 token 子集 renormalize 后取期望（缺失档按 0 处理，即不参与期望）。

    top_logprobs 不保证覆盖全部 G 个评分 token（分布尾部可能有非评分 token
    挤进 top-N），因此先过滤出评分 token，再对子集归一化求 Σ p·φ(v)。
    返回 1..G 的原始期望分；调用方用 LetterScale.normalize 归一到 [0,1]。
    """
    probs: dict[str, float] = {}
    for entry in top_logprobs:
        tok = str(entry.get("token", "")).strip()
        if tok in scale.token_set:
            p = math.exp(float(entry.get("logprob", -100.0)))
            probs[tok] = max(probs.get(tok, 0.0), p)  # 同 token 重复出现时取大
    if not probs:
        raise ScoreExtractionError("top_logprobs 中没有任何评分 token（A-T 子集为空）")
    total = sum(probs.values())
    return sum(p / total * scale.phi(tok) for tok, p in probs.items())


def extract_tag_distribution(logprobs: list[dict], tag: str) -> list[dict]:
    """在 per-token logprobs 中定位 ``<tag>`` 之后第一个非空 token，返回其 top_logprobs。

    logprobs 可能来自两种来源：
    - ``chat_with_logprobs`` 返回的原生 per-token list（列表中每个元素有 token 字段）；
    - 测试/回退通路包装的 ``{"content": [...], "prompt_logprobs": ...}`` dict。
    这里同时支持两种入参形式。
    """
    # 兼容包装层：logprobs = {"content": per_token_list, "prompt_logprobs": ...}
    if isinstance(logprobs, dict):
        logprobs = logprobs.get("content", []) or []
    text = "".join(str(e.get("token", "")) for e in logprobs)
    marker = f"<{tag}>"
    idx = text.find(marker)
    if idx < 0:
        raise ScoreExtractionError(f"响应中未找到 <{tag}> 标签")
    end = idx + len(marker)
    offset = 0
    for entry in logprobs:
        token = str(entry.get("token", ""))
        start = offset
        offset += len(token)
        if start >= end and token.strip():
            return entry.get("top_logprobs") or []
    raise ScoreExtractionError(f"<{tag}> 之后没有可用的评分 token")


def bradley_terry(ra: float, rb: float) -> float:
    """Eq.3.2：P(τ_a ≻ τ_b) = σ(R_a − R_b)，温度隐含为 1，R 已归一化到 [0,1]。"""
    d = max(-30.0, min(30.0, ra - rb))  # 数值保护
    return 1.0 / (1.0 + math.exp(-d))


# ---------------------------------------------------------------------------
# Pairwise 评分 prompt（照论文 §5 模板改造为字母刻度）
# ---------------------------------------------------------------------------

PAIRWISE_TEMPLATE = """You are an expert {domain} reviewer. You will see a task description and two trajectories.

Evaluation Criteria: {criterion}

Task:
<<<
{task}
>>>

Trajectory A:
<<<
{traj_a}
>>>

Trajectory B:
<<<
{traj_b}
>>>
{reasoning_block}
Carefully analyze each trajectory, then provide your final scores as single letters:
<score_A> LETTER </score_A>
<score_B> LETTER </score_B>

Rating Rules: Rate correctness on a {G}-level letter scale based on the evaluation criteria.
Letter mapping: {mapping}.
Reply with exactly one letter inside each tag."""

_REASONING_BLOCK = """
A senior reviewer prepared the following comparative analysis:
<reasoning>
{reasoning}
</reasoning>
Base your scores on this analysis.
"""


@dataclass
class PairScore:
    """一次 pairwise 比较的结果：两侧连续分（[0,1]）+ 偏好概率 + 分标准明细。"""

    ra: float
    rb: float
    preference: float  # P(a ≻ b)
    per_criterion: dict[str, tuple[float, float]] = field(default_factory=dict)
    calls: int = 0  # 实际 verifier 调用次数（C×K）


class Verifier:
    """连续评分 verifier。

    参数三轴：scale（G 粒度）、K（每标准重复次数）、criteria（标准分解，默认 C=3）。
    每次 pairwise 调用同时产出 A/B 两个分数；总调用数 = C×K。
    """

    def __init__(self, client: LLMClient, *, scale: LetterScale | None = None,
                 K: int = 4, criteria: tuple[Criterion, ...] | list[Criterion] = DEFAULT_CRITERIA,
                 domain: str = "coding agent", top_logprobs: int = 20):
        if K < 1:
            raise ValueError("K 必须 >= 1")
        if not criteria:
            raise ValueError("criteria 不能为空（C >= 1）")
        self.client = client
        self.scale = scale or LetterScale(20)
        self.K = K
        self.criteria = tuple(criteria)
        self.domain = domain
        self.top_logprobs = top_logprobs

    # -- prompt -------------------------------------------------------------
    def build_messages(self, task: str, traj_a: str, traj_b: str,
                       criterion: Criterion, reasoning: str | None = None) -> list[dict]:
        block = _REASONING_BLOCK.format(reasoning=reasoning) if reasoning else ""
        prompt = PAIRWISE_TEMPLATE.format(
            domain=self.domain, criterion=f"{criterion.name}: {criterion.description}",
            task=task, traj_a=traj_a, traj_b=traj_b, reasoning_block=block,
            G=self.scale.G, mapping=self.scale.mapping_text())
        return [{"role": "user", "content": prompt}]

    # -- 单次评估 -----------------------------------------------------------
    def _score_once(self, task: str, traj_a: str, traj_b: str,
                    criterion: Criterion, reasoning: str | None) -> tuple[float, float]:
        # 打分是机械任务：关 thinking + 封顶 max_tokens。v4-flash 是 reasoning
        # 模型，不限制时会生成长 CoT，top_logprobs=20 逐 token 跟随使响应达
        # 数 MB（单次 30-90s、7MB 实测），134 轨迹 × C×K 调用会超出管线超时。
        # 输出只需 <score_A>X</score_A><score_B>Y</score_B> 约 20 token。
        text, logprobs = self.client.chat_with_logprobs(
            self.build_messages(task, traj_a, traj_b, criterion, reasoning),
            top_logprobs=self.top_logprobs,
            max_tokens=512,
            thinking={"type": "disabled"})
        # 双通路兼容：有 logprobs 走期望化；无 logprobs（如 MLX 后端）回退文本解析
        use_text_fallback = False
        if isinstance(logprobs, dict):
            # skill_evolution 客户端返回 {"content": ..., "prompt_logprobs": ...} dict
            content_tokens = logprobs.get("content")
            if content_tokens:
                try:
                    raw_a = expected_from_top_logprobs(extract_tag_distribution(logprobs, "score_A"), self.scale)
                    raw_b = expected_from_top_logprobs(extract_tag_distribution(logprobs, "score_B"), self.scale)
                except ScoreExtractionError:
                    use_text_fallback = True
            else:
                use_text_fallback = True
        elif isinstance(logprobs, list):
            # verification_selection 客户端返回原生 per-token list（可能空）
            if logprobs:
                try:
                    raw_a = expected_from_top_logprobs(extract_tag_distribution(logprobs, "score_A"), self.scale)
                    raw_b = expected_from_top_logprobs(extract_tag_distribution(logprobs, "score_B"), self.scale)
                except ScoreExtractionError:
                    # logprobs 存在但不可用的后端（如 DeepSeek：<score_A> 被拆成
                    # < / score / _A 多 token，答案位置 top_logprobs 可能不含字母
                    # token）回退文本解析；文本也无标签时由下层抛 ScoreExtractionError，
                    # 不静默给默认分。
                    use_text_fallback = True
            else:
                use_text_fallback = True
        else:
            use_text_fallback = True
        if use_text_fallback:
            raw_a, raw_b = self._extract_scores_from_text(text)
        return self.scale.normalize(raw_a), self.scale.normalize(raw_b)

    def _extract_scores_from_text(self, text: str) -> tuple[float, float]:
        """Fallback: regex-extract <score_N> LETTER </score_N> from plain text output
        when logprobs are unavailable. Parses the first letter token inside each tag
        and maps it to the letter scale position."""
        import re
        score_a_letter = None
        score_b_letter = None
        m = re.search(r"<score_A>\s*([A-Z])\s*</score_A>", text)
        if m:
            score_a_letter = m.group(1)
        m = re.search(r"<score_B>\s*([A-Z])\s*</score_B>", text)
        if m:
            score_b_letter = m.group(1)
        if score_a_letter is None or score_b_letter is None:
            raise ScoreExtractionError(f"logprobs 不可用且文本中未找到 <score_A>/<score_B> 标签: {text[:200]}")
        return (float(self.scale.tokens.index(score_a_letter) + 1),
                float(self.scale.tokens.index(score_b_letter) + 1))

    # -- C×K 聚合 -----------------------------------------------------------
    def score_pair(self, task: str, traj_a: str, traj_b: str,
                   reasoning: str | dict[str, str] | None = None) -> PairScore:
        """对一对轨迹做 C 标准 × K 重复的连续评分。

        reasoning：None=单阶段；str=全部标准共用一段；dict=按标准名各用各的（两阶段通路）。
        """
        per_criterion: dict[str, tuple[float, float]] = {}
        sum_a = sum_b = 0.0
        calls = 0
        for crit in self.criteria:
            r = reasoning.get(crit.name) if isinstance(reasoning, dict) else reasoning
            ka: list[float] = []
            kb: list[float] = []
            for _ in range(self.K):
                a, b = self._score_once(task, traj_a, traj_b, crit, r)
                ka.append(a)
                kb.append(b)
                calls += 1
            per_criterion[crit.name] = (sum(ka) / self.K, sum(kb) / self.K)
            sum_a += per_criterion[crit.name][0]
            sum_b += per_criterion[crit.name][1]
        c = len(self.criteria)
        ra, rb = sum_a / c, sum_b / c
        return PairScore(ra=ra, rb=rb, preference=bradley_terry(ra, rb),
                         per_criterion=per_criterion, calls=calls)

    # -- N 选 1：PPT ---------------------------------------------------------
    def select_best(self, task: str, candidates: list[str], *, k: int = 3,
                    rng: random.Random | None = None) -> "TournamentResult":
        """用 PPT 在 N 条候选轨迹中选最优（k=3 起步）。"""
        def compare(i: int, j: int) -> float:
            return self.score_pair(task, candidates[i], candidates[j]).preference

        return probabilistic_pivot_tournament(len(candidates), compare, k=k, rng=rng)


# ---------------------------------------------------------------------------
# Probabilistic Pivot Tournament（Algorithm 1）
# ---------------------------------------------------------------------------

@dataclass
class TournamentResult:
    """PPT 结果：winner + 每个候选的归一化 win mass（w_i/c_i）+ 全部比较记录。"""

    winner: int
    normalized: list[float]      # w_i / c_i，候选的最终质量分 ∈ [0,1]
    win_mass: list[float]
    counts: list[int]
    pivots: list[int]
    comparisons: int             # pairwise 比较次数
    history: list[tuple[int, int, float]]  # (i, j, P(i≻j))，按执行顺序


def probabilistic_pivot_tournament(
    n: int,
    compare: Callable[[int, int], float],
    *,
    k: int = 3,
    rng: random.Random | None = None,
) -> TournamentResult:
    """PPT：ring pass → top-k pivot → pivot 轮次 → argmax w_i/c_i。

    compare(i, j) 返回 P(τ_i ≻ τ_j)。预算上界 N + k(N−k) + C(k,2) 对。
    ring pass 用随机 Hamiltonian cycle，保证每个候选在 A/B 位各出现一次，
    位置偏差在期望上抵消（pivot 轮次不保证消偏，见 README 简化点）。
    """
    if n <= 0:
        raise ValueError("n 必须 >= 1")
    rng = rng or random.Random(0)
    if n == 1:
        return TournamentResult(0, [1.0], [0.0], [0], [0], 0, [])
    k = max(1, min(k, n))

    w = [0.0] * n
    c = [0] * n
    history: list[tuple[int, int, float]] = []
    done: set[frozenset] = set()

    def run(i: int, j: int) -> None:
        p = compare(i, j)
        w[i] += p
        w[j] += 1.0 - p
        c[i] += 1
        c[j] += 1
        history.append((i, j, p))
        done.add(frozenset((i, j)))

    # 1) ring pass：随机排列的相邻对，恰好 N 对；每候选 A/B 位各一次
    gamma = list(range(n))
    rng.shuffle(gamma)
    for t in range(n):
        run(gamma[t], gamma[(t + 1) % n])

    # 2) top-k pivot 选择（按 ring 阶段的 w/c 排名）
    ranked = sorted(range(n), key=lambda i: (-(w[i] / c[i]) if c[i] else 0.0, i))
    pivots = sorted(ranked[:k])

    # 3) pivot 轮次：{非pivot × pivot} ∪ C(pivot,2)，减去 ring 已比过的对
    e_piv: list[tuple[int, int]] = []
    for i in range(n):
        if i in pivots:
            continue
        for p in pivots:
            if frozenset((i, p)) not in done:
                e_piv.append((i, p))
    for p1, p2 in combinations(pivots, 2):
        if frozenset((p1, p2)) not in done:
            e_piv.append((p1, p2))
    for i, j in e_piv:
        run(i, j)

    normalized = [w[i] / c[i] if c[i] else 0.0 for i in range(n)]
    winner = max(range(n), key=lambda i: (normalized[i], -i))
    return TournamentResult(winner, normalized, w, c, pivots, len(history), history)


# ---------------------------------------------------------------------------
# 两阶段打分通路（B.6）：大模型产 <reasoning>，小模型在其后产评分分布
# ---------------------------------------------------------------------------

STAGE1_TEMPLATE = """You are a senior {domain} reviewer. You will see a task description and two trajectories.

Evaluation Criteria: {criterion}

Task:
<<<
{task}
>>>

Trajectory A:
<<<
{traj_a}
>>>

Trajectory B:
<<<
{traj_b}
>>>

First, provide your comparative analysis inside <reasoning>...</reasoning>.
Then give discrete integer scores on a 1-10 scale:
<score_A> INT </score_A>
<score_B> INT </score_B>"""


class ReasoningCache(Protocol):
    """reasoning 缓存协议（可挂到知识库的 SQLite 表）。"""

    def get(self, key: str) -> str | None: ...
    def set(self, key: str, value: str, meta: dict | None = None) -> None: ...


class DictReasoningCache:
    """内存版 reasoning 缓存（测试用）。"""

    def __init__(self) -> None:
        self._d: dict[str, str] = {}

    def get(self, key: str) -> str | None:
        return self._d.get(key)

    def set(self, key: str, value: str, meta: dict | None = None) -> None:
        self._d[key] = value

    def __len__(self) -> int:
        return len(self._d)


def reasoning_cache_key(task: str, criterion: str, traj_a: str, traj_b: str) -> str:
    h = hashlib.sha256("\x00".join([task, criterion, traj_a, traj_b]).encode("utf-8"))
    return h.hexdigest()


def extract_reasoning_text(stage1_output: str) -> str:
    """从大模型 stage-1 输出中截取 <reasoning> 内容；缺失时退回全文。"""
    m = re.search(r"<reasoning>(.*?)</reasoning>", stage1_output, re.S)
    return m.group(1).strip() if m else stage1_output.strip()


class TwoStageScorer:
    """两阶段打分器：teacher 产 reasoning（按 任务×标准×轨迹对 缓存），
    student verifier 在 reasoning 之后产连续评分分布（打分浅层化）。"""

    def __init__(self, teacher: LLMClient, verifier: Verifier,
                 cache: ReasoningCache | None = None):
        self.teacher = teacher
        self.verifier = verifier
        self.cache = cache

    def stage1_messages(self, task: str, traj_a: str, traj_b: str,
                        criterion: Criterion) -> list[dict]:
        prompt = STAGE1_TEMPLATE.format(
            domain=self.verifier.domain,
            criterion=f"{criterion.name}: {criterion.description}",
            task=task, traj_a=traj_a, traj_b=traj_b)
        return [{"role": "user", "content": prompt}]

    def score_pair(self, task: str, traj_a: str, traj_b: str) -> PairScore:
        reasoning_map: dict[str, str] = {}
        for crit in self.verifier.criteria:
            key = reasoning_cache_key(task, crit.name, traj_a, traj_b)
            cached = self.cache.get(key) if self.cache is not None else None
            if cached is None:
                out = self.teacher.chat(self.stage1_messages(task, traj_a, traj_b, crit))
                cached = extract_reasoning_text(out)
                if self.cache is not None:
                    self.cache.set(key, cached, {"criterion": crit.name})
            reasoning_map[crit.name] = cached
        return self.verifier.score_pair(task, traj_a, traj_b, reasoning=reasoning_map)
