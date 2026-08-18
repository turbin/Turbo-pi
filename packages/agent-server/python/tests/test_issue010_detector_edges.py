"""issue-010 补充回归：交付检测器保守方向锁（决策 T2-5 边界）。

锁定检测器的确定性边界：
1. 误报方向（permissive 边）——"无真实交付但含写命令噪声"（如调试 log）会
   通过检测器：这是"交付证据≠交付证明"的已知边界（决策记录 §3-3），
   锁定现状防止检测器改动时无意识收紧/放松；
2. 漏报方向（保守边）——未加引号的路径交付声明、/dev/null 重定向、纯读
   操作不判为交付：方向安全（漏报 → 封顶 → 不产新卡）；
3. C 语料实测的 4/98 误封顶形态（内联答案/API 执行型）保持在"不判交付"。

运行：cd packages/agent-server && uv run pytest python/tests/test_issue010_detector_edges.py -q
"""

from __future__ import annotations

from verification_selection.deliverables import has_deliverable


def test_read_only_and_redirect_noise_are_not_deliverables():
    """纯读操作 / 无扩展名重定向不判为交付（保守方向）。"""
    assert not has_deliverable("bash: cat report.md")
    assert not has_deliverable("bash: ls -la /tmp")
    assert not has_deliverable("bash: diff a.md b.md")
    assert not has_deliverable("bash: echo x > /dev/null")
    assert not has_deliverable("bash: cat ./policy/input_trust_policy_v2.yaml")


def test_unquoted_path_claims_are_not_detected_conservative():
    """声明类 marker 要求带引号/反引号文件名：未加引号的路径声明漏报（保守方向锁）。"""
    # 漏报方向：实际有交付但检测器不判 → 封顶（安全方向，不产新卡）。
    assert not has_deliverable("wrote the summary to /tmp/out.json")
    assert has_deliverable("wrote the summary to `/tmp/out.json`")
    assert has_deliverable("I've written it to `security_policy_assessment.md`.")


def test_debug_log_noise_passes_permissive_edge_locked():
    """误报方向锁：调试 log 写入会让无真实交付的轨迹通过检测器（交付证据≠证明）。"""
    # 现状锁定：echo 到带扩展名文件 = 写文件证据（宽松方向）。
    assert has_deliverable("bash: echo debug > /tmp/debug.log")
    # 但纯分析 + 无任何写命令的轨迹仍被正确判为无交付（issue-010 靶形态）。
    assert not has_deliverable(
        "The agent read the policy files, cross-checked the checklist, identified the gaps, "
        "and presented the full assessment inline without writing any file."
    )


def test_inline_answer_tasks_stay_no_deliverable():
    """C 语料 4/98 误封顶形态（内联答案/API 执行型交付）：保持不判交付（决策 §3-2）。"""
    assert not has_deliverable(
        "Executed the API call against the service endpoint and returned the JSON response inline."
    )
    assert not has_deliverable(
        "Ran the SPARQL query and printed the matching triples directly in the chat."
    )
