"""F3/T4 补充回归：任务→域注册表双副本一致性（决策 T4-1 "镜像同规则"）。

TS（src/offline/task-domain.ts）与 Python（verification_selection/domains.py）
声称同规则镜像。实测发现边界分歧：

- TS 用 `\\btask_\\d+`（词边界）；Python 用 `task_\\d+`（子串搜索）。
- 分歧输入：task_id 中 "task_<数字>" 前接**词字符**（字母/下划线）——
  "mytask_00001" / "footask_7_bar" / "x_task_5_y"：TS 判无域（保守、符合
  "task_id 形如 task_<编号>_<slug>" 的规范形态），Python 误判 office。

本文件锁定**同一期望表**（以 TS 保守语义为参照——canonical 前缀 + 臂前缀
命中，词字符前缀不命中）。当前 Python 侧 3 例红（缺陷证据，m4-test-review
§2c）；修复 domains.py 为 `re.compile(r"\\btask_\\d+")` 后转绿。

运行：cd packages/agent-server && uv run pytest python/tests/test_issue012_domain_registry_parity.py -q
"""

from __future__ import annotations

import re

import pytest

from verification_selection.domains import task_domain

# 与 TS `domainForTask` 的期望表（同规则镜像的权威参照）。
EXPECTED = {
    "task_00091_security_policy_assessment": "office",  # canonical 前缀
    "task_00002_workspace_onboarding": "office",
    "experiment-task_00091_x": "office",  # 臂前缀（连字符 = 词边界）
    "control-task_2_foo": "office",
    "alfworld_pick_clean_then_place": "alfworld",
    "alfworld": "alfworld",
    "some_other_domain_task": "",  # 无 task_<数字>
    "": "",
    "mytask_00001": "",  # 词字符前缀（字母）——TS 不命中，Python 当前误判 office
    "footask_7_bar": "",  # 同上
    "x_task_5_y": "",  # 下划线是词字符，非边界——TS 不命中
}


@pytest.mark.parametrize("task_id,expected", sorted(EXPECTED.items()))
def test_task_domain_matches_ts_reference_table(task_id: str, expected: str):
    """双副本必须对同一期望表给出同一结果（TS 语义为参照）。"""
    assert task_domain(task_id) == expected, (
        f"task_domain({task_id!r}) = {task_domain(task_id)!r}, TS 语义应为 {expected!r}"
    )


def test_python_regex_uses_word_boundary_like_ts():
    """根因锁定：Python 注册表正则必须带 \\b（与 TS 一致），当前实现缺失。"""
    # 当前实现：子串搜索（缺陷）；修复后：\btask_\d+
    current = re.compile(r"task_\d+")
    fixed = re.compile(r"\btask_\d+")
    assert current.search("mytask_00001") is not None  # 现状（缺陷）
    assert fixed.search("mytask_00001") is None  # 目标语义
    assert fixed.search("task_00091_x") is not None
    assert fixed.search("experiment-task_00091_x") is not None  # 连字符是边界
