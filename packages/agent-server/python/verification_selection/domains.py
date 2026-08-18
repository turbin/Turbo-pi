"""任务→域注册表（F3 / T4，issue-012 采纳项 5 落地）。

蒸馏管线按轨迹来源自动打标（合成器元数据透传 + 本注册表回退）；restill 重蒸
顺带打标。与 `src/offline/task-domain.ts` 的 ``domainForTask`` 镜像，改动需
两侧同步（两侧测试锁定同一期望表）。

规则：
- alfworld 任务（task_id 含 "alfworld"）→ "alfworld"；
- office campaign 任务（QCB 语料，task_id 形如 task_<编号>_<slug>）→ "office"；
- 其余 → ""（无标签：检索不过滤，向后兼容存量卡）。
"""


import re

# office campaign 任务（QCB 语料）：task_<编号>_<slug>，可能带臂前缀
# （control-task_... / experiment-task_...，session 级命名）。
# 注意：\b 词边界与 TS src/offline/task-domain.ts 完全一致（双副本同规则，
# 决策 T4-1；m4-test-review 缺陷-1 修复）——"mytask_00001" 等词字符前缀
# 输入不命中（保守，符合 task_id 命名规范）。
_OFFICE_TASK_RE = re.compile(r"\btask_\d+")


def task_domain(task_id: str) -> str:
    if not task_id:
        return ""
    if "alfworld" in task_id:
        return "alfworld"
    if _OFFICE_TASK_RE.search(task_id):
        return "office"
    return ""
