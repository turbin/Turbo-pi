"""离线测试 / demo 专用工具：脚本化 Mock 构造器。

完全确定性、零网络。用关键词信号模拟"小模型 verifier 的评分分布随轨迹
质量变化"、"大模型产 reasoning / 经验卡"、"裁决裁判给标签"三类行为，
让 demo 与单元测试可以在没有真实 LLM 的情况下跑通全链路。
"""
from __future__ import annotations

import json
import math
import re

from .llm_client import MockLLM, MockResponse, messages_text
from .verifier import LETTERS

# ---------------------------------------------------------------------------
# 关键词质量信号（模拟 verifier 对轨迹好坏的感知）
# ---------------------------------------------------------------------------

_POSITIVE = [r"\bverif\w*", r"\btest\w*", r"\bkmp\b", r"\bz-algorithm\b",
             r"\bbinary search\b", r"\brollback\b", r"\bedge case\w*\b",
             r"\bbackoff\b", r"\bchecklist\b", r"\bjitter\b"]
_NEGATIVE = [r"\berror\w*", r"\bcrash\w*", r"\btimeout\w*", r"\bwrong\b",
             r"\bassum\w*", r"\bskip\w*", r"\bfail\w*", r"\bguess\w*",
             r"\bbrute force\b"]


def keyword_quality_index(text: str, G: int = 20) -> int:
    """按正/负关键词计数把文本映射到 [0, G-1] 的字母下标（确定性）。"""
    t = text.lower()
    pos = sum(1 for p in _POSITIVE if re.search(p, t))
    neg = sum(1 for p in _NEGATIVE if re.search(p, t))
    q = min(0.95, max(0.05, 0.5 + 0.12 * pos - 0.18 * neg))
    return min(G - 1, max(0, round(q * (G - 1))))


def letter_distribution(center: int, G: int, *, spread: tuple[float, float, float] = (0.16, 0.68, 0.12),
                        noise: float = 0.04) -> list[tuple[str, float]]:
    """以 center 为中心的离散分布；附带一个非字母噪声 token（演练 renormalize）。"""
    left_p, center_p, right_p = spread
    items: list[tuple[str, float]] = []
    if center > 0:
        items.append((LETTERS[center - 1], left_p))
    else:
        center_p += left_p
    items.append((LETTERS[center], center_p))
    if center < G - 1:
        items.append((LETTERS[center + 1], right_p))
    else:
        items[-1] = (items[-1][0], items[-1][1] + right_p)
    items.append(("the", noise))  # 非评分 token，占住一部分概率质量
    return items


def score_response(dist_a: list[tuple[str, float]], dist_b: list[tuple[str, float]]) -> MockResponse:
    """按给定分布构造带 logprobs 的 <score_A>/<score_B> 响应。"""
    la = max(dist_a, key=lambda x: x[1])[0]
    lb = max(dist_b, key=lambda x: x[1])[0]
    segs = ["<score_A>", f" {la}", " </score_A>", "\n<score_B>", f" {lb}", " </score_B>"]
    entries = [{"token": s, "logprob": -0.02,
                "top_logprobs": [{"token": s, "logprob": -0.02}]} for s in segs]
    entries[1]["top_logprobs"] = [{"token": f" {t}", "logprob": math.log(p)} for t, p in dist_a]
    entries[4]["top_logprobs"] = [{"token": f" {t}", "logprob": math.log(p)} for t, p in dist_b]
    text = "".join(segs)
    return MockResponse(text, entries)


# ---------------------------------------------------------------------------
# 小模型 verifier Mock：按轨迹关键词质量产评分分布
# ---------------------------------------------------------------------------

def make_scoring_mock(G: int = 20, name: str = "student-mock") -> MockLLM:
    """识别 pairwise 评分 prompt，对 Trajectory A/B 分别产字母分布。"""
    mock = MockLLM(name=name)
    traj_a_re = re.compile(r"Trajectory A:\n<<<\n(.*?)\n>>>", re.S)
    traj_b_re = re.compile(r"Trajectory B:\n<<<\n(.*?)\n>>>", re.S)

    def pred(messages, **kw):
        text = messages_text(messages)
        return "Trajectory A:" in text and "<score_A>" in text

    def handler(messages, **kw):
        text = messages_text(messages)
        ma, mb = traj_a_re.search(text), traj_b_re.search(text)
        if not (ma and mb):
            return MockResponse("MOCK-NO-TRAJ")
        ia = keyword_quality_index(ma.group(1), G)
        ib = keyword_quality_index(mb.group(1), G)
        return score_response(letter_distribution(ia, G), letter_distribution(ib, G))

    mock.add_rule(pred, handler)
    return mock


# ---------------------------------------------------------------------------
# 大模型 Mock：两阶段 reasoning + 经验卡抽取
# ---------------------------------------------------------------------------

def make_teacher_mock(G: int = 20, name: str = "teacher-mock") -> MockLLM:
    """stage-1 reasoning（含离散整数分）+ 五元组经验卡抽取。"""
    mock = MockLLM(name=name)
    traj_a_re = re.compile(r"Trajectory A:\n<<<\n(.*?)\n>>>", re.S)
    traj_b_re = re.compile(r"Trajectory B:\n<<<\n(.*?)\n>>>", re.S)
    single_traj_re = re.compile(r"Trajectory:\n<<<\n(.*?)\n>>>", re.S)

    # -- stage-1：比较分析 + 离散分 -----------------------------------------
    def reasoning_pred(messages, **kw):
        text = messages_text(messages)
        return "senior" in text and "<reasoning>" in text and "Trajectory B:" in text

    def reasoning_handler(messages, **kw):
        text = messages_text(messages)
        ma, mb = traj_a_re.search(text), traj_b_re.search(text)
        ta, tb = (ma.group(1) if ma else ""), (mb.group(1) if mb else "")
        ia, ib = keyword_quality_index(ta, G), keyword_quality_index(tb, G)
        better, worse = ("A", "B") if ia >= ib else ("B", "A")
        analysis = (f"Trajectory {better} grounds its steps and verifies the result, "
                    f"while trajectory {worse} shows more failure signals and weaker "
                    f"validation; {better} is operationally stronger on this criterion.")
        sa = 1 + round(ia / (G - 1) * 9)
        sb = 1 + round(ib / (G - 1) * 9)
        return (f"<reasoning>{analysis}</reasoning>\n"
                f"<score_A> {sa} </score_A>\n<score_B> {sb} </score_B>")

    # -- 经验卡抽取：按轨迹关键词产出五元组 JSON ------------------------------
    def extract_pred(messages, **kw):
        return "mining reusable operational experience" in messages_text(messages)

    def extract_handler(messages, **kw):
        text = messages_text(messages)
        m = single_traj_re.search(text)
        traj = (m.group(1) if m else text).lower()
        if "kmp" in traj or "cyclic" in traj or "z-algorithm" in traj:
            card = {
                "name": "Linear-Time Substring Matching for Cyclic Shift Counting",
                "trigger": ("Use when a task requires finding all cyclic rotations or "
                            "shift positions of a long string, especially under "
                            "large-length constraints."),
                "procedure": ("1) Construct S=s+s. 2) Treat t as the pattern. "
                              "3) Run a linear-time matching algorithm (KMP, Z-algorithm, "
                              "or rolling hash) over S. 4) Keep only positions p<n. "
                              "5) Split counts by p=0 vs p!=0 if needed. "
                              "6) Sanity-test on large n."),
                "boundary": ("Must not contain an O(n)-length substring extraction "
                             "inside a loop over all shifts."),
                "role": "Guard",
            }
        elif "backoff" in traj or "retry" in traj:
            card = {
                "name": "Bounded Exponential-Backoff Retry for Flaky APIs",
                "trigger": ("Use when calling external APIs that intermittently return "
                            "5xx or time out and the operation is idempotent."),
                "procedure": ("1) Wrap the call in a retry loop with exponential backoff "
                              "and jitter. 2) Cap attempts at 4. 3) Verify the response "
                              "schema before using the payload. 4) Log each retry with "
                              "its cause."),
                "boundary": ("Must not retry on 4xx client errors or on non-idempotent "
                             "POST requests without an idempotency key."),
                "role": "Method",
            }
        else:
            card = {
                "name": "Final Requirements Cross-Check Before Answering",
                "trigger": ("Use when a multi-step task requires a final correctness "
                            "check before producing the answer."),
                "procedure": ("1) Re-read the task requirements. 2) Check each "
                              "requirement against the produced output. 3) Run available "
                              "tests. 4) Report any discrepancy explicitly."),
                "boundary": ("Must not skip the re-read step when the task statement "
                             "contains numeric constraints."),
                "role": "Workflow",
            }
        return json.dumps(card, ensure_ascii=False)

    mock.add_rule(reasoning_pred, reasoning_handler)
    mock.add_rule(extract_pred, extract_handler)
    return mock


# ---------------------------------------------------------------------------
# 裁决裁判 Mock：按两卡 procedure 的 Jaccard 相似度给标签
# ---------------------------------------------------------------------------

def make_judge_mock(name: str = "judge-mock", tau: float = 0.5) -> MockLLM:
    """脚本化裁判：两卡 procedure 词级 Jaccard >= tau 判 Same_Tactic，否则 Different。"""
    mock = MockLLM(name=name)
    card_a_re = re.compile(r"Card A:\n(\{[^\n]*\})")
    card_b_re = re.compile(r"Card B:\n(\{[^\n]*\})")
    tok_re = re.compile(r"[a-z0-9_]+")

    def pred(messages, **kw):
        text = messages_text(messages)
        return "Card A:" in text and "Card B:" in text

    def handler(messages, **kw):
        text = messages_text(messages)
        ma, mb = card_a_re.search(text), card_b_re.search(text)
        if not (ma and mb):
            return "Invalid"
        try:
            a, b = json.loads(ma.group(1)), json.loads(mb.group(1))
        except json.JSONDecodeError:
            return "Invalid"
        if a.get("role") != b.get("role"):
            return "Different\nrole mismatch"
        ta = set(tok_re.findall(a.get("procedure", "").lower()))
        tb = set(tok_re.findall(b.get("procedure", "").lower()))
        jac = len(ta & tb) / max(1, len(ta | tb))
        if jac >= tau:
            return f"Same_Tactic\nprocedure token jaccard={jac:.2f} >= {tau}"
        return f"Different\nprocedure token jaccard={jac:.2f} < {tau}"

    mock.add_rule(pred, handler)
    return mock
