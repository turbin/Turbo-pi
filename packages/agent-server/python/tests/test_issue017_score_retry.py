"""issue-017 回归：打分 ScoreExtractionError 有限重试 + temperature=0 + 指纹含模型。

issue-017（doc/issues-snapshot/issue-017-verifier-score-extraction-no-retry.md）：
D1 夜间进化两次在打分阶段首调用即炸批——模型偶发不遵循标签格式（DeepSeek
默认 temperature=1.0 采样），`_score_once` 对 ScoreExtractionError 零重试，
单次不遵循即中断整个进化批。修复三条：

1. 打分调用显式 temperature=0（机械打分任务应确定性）；
2. 文本回退提取失败（ScoreExtractionError）重试至多 2 次（共 3 次尝试，
   间隔 0.5s），3 次全败才向上抛（fail loud，不静默给默认分）；
3. 打分指纹（pipeline `_prompt_fingerprint`）纳入模型名——跨模型断点复用
   会混用 pro/flash 打分口径（2026-08-20 D1 进化实战事故）。

覆盖：首败二成重试成功（调用数=2）；连续散文 3 次 fail loud；temperature=0
透传（mock 记录 kwargs）；同输入不同模型 → input_hash 不同（pipeline 层）。

运行：cd packages/agent-server && uv run pytest python/tests/test_issue017_score_retry.py -q
"""

from __future__ import annotations

import pytest

from verification_selection.checkpoint import input_hash
from verification_selection.llm_client import MockLLM, MockResponse
from verification_selection.pipeline import (
    TeacherTrajectory,
    _prompt_fingerprint,
    score_trajectories_with_checkpoint,
)
from verification_selection.testing import make_scoring_mock
from verification_selection.verifier import Criterion, LetterScale, ScoreExtractionError, Verifier

# 一次"模型未遵循标签格式"的分析散文（issue-017 两次事故的真实形态）。
PROSE = (
    "## Analysis\n"
    "The trajectory performs well overall: it applies backoff with jitter and "
    "retries after transient failures, and the final output is in the expected "
    "form. There are no failure signals.\n"
    "A: The trajectory is complete and correct.\n"
    "B: The trajectory is incomplete."
)

_CRITERION = Criterion("Specification", "Does the trajectory satisfy all requirements stated in the task?")


def _tag_text(letter_a: str, letter_b: str) -> str:
    """合规的标签响应（<score_A>/<score_B> 各一个字母）。"""
    return (
        "<reasoning>A is more complete than B.</reasoning>\n"
        f"<score_A> {letter_a} </score_A>\n"
        f"<score_B> {letter_b} </score_B>\n"
    )


def _sequence_mock(*responses: MockResponse) -> MockLLM:
    """按调用顺序依次返回给定响应（超出后重复最后一个）。"""
    mock = MockLLM(name="seq")
    state = {"i": 0}

    def _handler(messages, **kw):  # noqa: ARG001
        resp = responses[min(state["i"], len(responses) - 1)]
        state["i"] += 1
        return resp

    mock.add_rule(lambda _msgs, **_kw: True, _handler)
    return mock


def _verifier(mock: MockLLM) -> Verifier:
    """C=1 × K=1：一次 score_pair = 一次 _score_once，调用数断言无歧义。"""
    return Verifier(mock, scale=LetterScale(G=5), K=1, criteria=[_CRITERION])


def _patch_sleep(monkeypatch: pytest.MonkeyPatch) -> None:
    """重试间隔在测试中跳过（生产为 _SCORE_RETRY_SLEEP_S=0.5s）。"""
    monkeypatch.setattr("time.sleep", lambda _secs: None)


# ══════════════════════════════════════════════════════════════════════════════
# 1. 有限重试：首败（散文）二成（标签）→ 成功且调用数 = 2
# ══════════════════════════════════════════════════════════════════════════════


def test_retry_succeeds_when_second_attempt_has_tags(monkeypatch: pytest.MonkeyPatch) -> None:
    """第一次返回散文（提取失败）、第二次返回合规标签 → 重试后成功，调用数 = 2。"""
    _patch_sleep(monkeypatch)
    mock = _sequence_mock(
        MockResponse(PROSE, logprobs=[]),
        MockResponse(_tag_text("C", "A"), logprobs=[]),
    )
    v = _verifier(mock)
    result = v.score_pair("task", "traj_a", "traj_b")
    assert len(mock.calls) == 2  # 一次失败 + 一次重试
    # C → phi=3 → norm=0.5；A → phi=1 → norm=0
    assert result.ra == pytest.approx(0.5, abs=0.02)
    assert result.rb == pytest.approx(0.0, abs=0.02)


def test_retry_succeeds_on_third_attempt(monkeypatch: pytest.MonkeyPatch) -> None:
    """前两次散文、第三次合规 → 第 3 次尝试成功（重试上限边界）。"""
    _patch_sleep(monkeypatch)
    mock = _sequence_mock(
        MockResponse(PROSE, logprobs=[]),
        MockResponse(PROSE, logprobs=[]),
        MockResponse(_tag_text("E", "B"), logprobs=[]),
    )
    v = _verifier(mock)
    result = v.score_pair("task", "traj_a", "traj_b")
    assert len(mock.calls) == 3
    # E → phi=5 → norm=1.0；B → phi=2 → norm=0.25
    assert result.ra == pytest.approx(1.0, abs=0.02)
    assert result.rb == pytest.approx(0.25, abs=0.02)


# ══════════════════════════════════════════════════════════════════════════════
# 2. 连续散文 3 次 → 最终抛 ScoreExtractionError（fail loud）
# ══════════════════════════════════════════════════════════════════════════════


def test_three_prose_attempts_raise_fail_loud(monkeypatch: pytest.MonkeyPatch) -> None:
    """3 次全败才向上抛（fail loud 语义保留：不静默给默认分）。"""
    _patch_sleep(monkeypatch)
    mock = _sequence_mock(*[MockResponse(PROSE, logprobs=[])] * 3)
    v = _verifier(mock)
    with pytest.raises(ScoreExtractionError, match="logprobs 不可用且文本中未找到"):
        v.score_pair("task", "traj_a", "traj_b")
    assert len(mock.calls) == 3  # 恰好 3 次尝试，不再多


# ══════════════════════════════════════════════════════════════════════════════
# 3. 打分调用显式 temperature=0（mock 记录 kwargs 透传）
# ══════════════════════════════════════════════════════════════════════════════


def test_score_call_passes_temperature_zero() -> None:
    """打分调用显式 temperature=0（机械打分确定性）；其余打分参数不变。"""
    mock = make_scoring_mock(G=5)
    v = _verifier(mock)
    v.score_pair("task", "traj_a", "traj_b")
    assert len(mock.calls) == 1
    kw = mock.calls[0]["kw"]
    assert kw["temperature"] == 0
    assert kw["max_tokens"] == 512  # 封顶保持不变
    assert kw["thinking"] == {"type": "disabled"}  # 关 thinking 保持不变
    assert kw["top_logprobs"] == v.top_logprobs


# ══════════════════════════════════════════════════════════════════════════════
# 4. 打分指纹含模型：同输入不同模型 → input_hash 不同（pipeline 层）
# ══════════════════════════════════════════════════════════════════════════════


def _single_traj() -> list[TeacherTrajectory]:
    return [
        TeacherTrajectory(
            task_id="task-x",
            task="handle the backoff request",
            trajectory=(
                "First check the checklist, then apply backoff with jitter and retry.\n"
                "bash: cat > report.md <<EOF\nall green\nEOF"
            ),
        ),
    ]


def test_fingerprint_includes_model(tmp_path) -> None:
    """同输入换模型 → 指纹不匹配 → 同 run 目录 resume 全量重打（跨模型断点复用失效）。"""
    rundir = tmp_path / "run"
    trajs = _single_traj()

    flash = make_scoring_mock(G=5, name="flash-mock")
    flash.model = "deepseek-v4-flash"
    v_flash = Verifier(flash, scale=LetterScale(G=5), K=1, criteria=[_CRITERION])
    score_trajectories_with_checkpoint(trajs, verifier=v_flash, run_dir=str(rundir))
    first_calls = len(flash.calls)
    assert first_calls > 0

    # 同模型 resume → 缓存命中，零 LLM 调用（幂等不变）。
    flash2 = make_scoring_mock(G=5, name="flash-mock")
    flash2.model = "deepseek-v4-flash"
    v_flash2 = Verifier(flash2, scale=LetterScale(G=5), K=1, criteria=[_CRITERION])
    score_trajectories_with_checkpoint(trajs, verifier=v_flash2, run_dir=str(rundir))
    assert len(flash2.calls) == 0

    # 同输入、同 G/K/标准，仅模型不同 → 指纹不匹配 → 零缓存复用、全量重打。
    pro = make_scoring_mock(G=5, name="pro-mock")
    pro.model = "deepseek-v4-pro"
    v_pro = Verifier(pro, scale=LetterScale(G=5), K=1, criteria=[_CRITERION])
    score_trajectories_with_checkpoint(trajs, verifier=v_pro, run_dir=str(rundir))
    assert len(pro.calls) == first_calls

    # 直接断言：同输入不同模型 → input_hash 不同。
    h_flash = input_hash(_prompt_fingerprint(v_flash), trajs[0].task, trajs[0].trajectory)
    h_pro = input_hash(_prompt_fingerprint(v_pro), trajs[0].task, trajs[0].trajectory)
    assert h_flash != h_pro


def test_fingerprint_model_unknown_when_client_lacks_model() -> None:
    """MockLLM 无 model 属性 → getattr 容错 "unknown"，与显式 model="unknown" 指纹一致。"""
    a = make_scoring_mock(G=5, name="a")  # 无 model 属性（与既有测试一致）
    b = make_scoring_mock(G=5, name="b")
    b.model = "unknown"
    va = Verifier(a, scale=LetterScale(G=5), K=1, criteria=[_CRITERION])
    vb = Verifier(b, scale=LetterScale(G=5), K=1, criteria=[_CRITERION])
    assert _prompt_fingerprint(va) == _prompt_fingerprint(vb)
