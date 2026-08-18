"""交付物产出检测（issue-010 交付检查，统一修改方案 §2 F1）。

issue-010 根因：Method 卡只提炼"过程步骤"，不提炼"任务交付物要求"；
验证闸门只评"程序合理性"，不验证"按卡执行能否产出交付物"——照卡执行
挤占交付本能（D3 重复集 task_00091 分析完整但交付文件从未落盘）。

本模块提供打分的确定性前置检查：``has_deliverable`` 判断轨迹文本中是否
存在交付物产出的证据。它是保守启发式（确定性、零 LLM 调用——"物理拦截"
语义），以办公自动化语料（bash 工具会话）为准：

- 强证据：bash 命令行内的写文件操作（重定向 / tee / heredoc 到带扩展名的
  工作区文件）；
- 声明证据：assistant 文本中的交付声明（"written it to `x.md`" /
  "Files Created" 等）。

已知局限（诚实边界）：非文件型交付（内联答案、API 执行等）会被误判为
无交付——C 语料实测 4/98 高分轨迹因此被保守拦截（task_00017/00043/00066/
00067 型任务），代价是新卡不产出（安全方向）；检测器版本变化须同步递增
``DELIVERY_CAP_VERSION``（pipeline 打分指纹的一部分，使既有打分缓存失效）。
"""

from __future__ import annotations

import re

# 无交付轨迹的 quality 封顶值（严格低于主管线 0.5 晋升阈值）。
DELIVERY_CAP_QUALITY = 0.49

# 交付检查逻辑版本：检测器/封顶语义变化时递增，使既有打分缓存（ScoreJournal）
# 全部失效重打（输入哈希 = prompt 指纹 + 轨迹内容，指纹含本版本）。
DELIVERY_CAP_VERSION = "v1"

_FILE_EXT = r"(?:md|json|csv|yaml|yml|txt|py|sh|xml|html|ini|log|docx|pdf)"

# 强证据 1：bash 工具结果里的写文件命令（重定向 / tee / heredoc 到工作区文件）。
# 形如 "bash: cat > security_policy_assessment.md <<EOF" / "bash: tee report.md"。
_BASH_WRITE = re.compile(
    rf"bash:[^\n]*?(?:>>?|tee|<<)\s*['\"]?[\w./-]+\.{_FILE_EXT}\b",
    re.IGNORECASE,
)

# 声明证据 2：交付声明（"written it to `x.md`" / "wrote the report to x.md"）。
_CLAIM_WRITE = re.compile(
    rf"\b(?:written|wrote|saved|generated|created)\b[^.\n]{{0,60}}(?:to|as)?\s*[`\"][\w./-]+\.{_FILE_EXT}\b",
    re.IGNORECASE,
)

# 声明证据 3：总结式交付清单（"### Files Created" / "files written"）。
_FILES_CREATED = re.compile(r"\bfiles?\s+(?:created|written|saved|produced)\b", re.IGNORECASE)

# 声明证据 4：显式输出落盘声明。
_OUTPUT_WRITTEN = re.compile(r"\boutput written to\b", re.IGNORECASE)

_MARKERS = (_BASH_WRITE, _CLAIM_WRITE, _FILES_CREATED, _OUTPUT_WRITTEN)


def has_deliverable(trajectory_text: str) -> bool:
    """轨迹是否存在交付物产出证据（保守启发式，确定性）。

    任一强/声明证据命中即视为有交付；纯分析（读文件、交叉核对、内联呈现）
    不命中。供打分侧封顶（pipeline.score_trajectories_with_checkpoint）与
    存量卡重蒸（restill）共用。
    """
    return any(m.search(trajectory_text) for m in _MARKERS)
