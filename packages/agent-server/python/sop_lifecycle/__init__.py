"""sop_lifecycle：EvoSOP 生命周期的 agent-server 离线入口包。

SPEC §4.2 step 3 约定 `python -m sop_lifecycle --input ... --output ...`；
EvoSOP 实现本体在 skill_evolution 包（handoff 复现代码把 MetaSkill-Evolve
与 EvoSOP 放在同一 SkillStore 上），这里做薄封装，保持 SPEC 的命令契约。
"""
from skill_evolution import SopConfig, SopLifecycle, get_active_sops

__all__ = ["SopConfig", "SopLifecycle", "get_active_sops"]
