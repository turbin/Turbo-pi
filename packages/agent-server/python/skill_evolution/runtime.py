"""运行时注入接口：agent server 在每轮任务前调用，向小模型重放知识库经验。

- get_active_skills()：返回应注入 prompt 的 skill 内容（渐进披露：先紧凑 catalog，再最优 skill 全文）。
- get_active_sops()：返回应注册进工具列表的 SOP function schema（上限 15 个）。
"""
from __future__ import annotations

from typing import Any

from .skillfile import one_line_summary
from .store import SkillStore

TOOL_LIMIT = 15  # 注入小模型的工具数硬上限（简报 §8：小模型工具列表过长会增加选择噪声）


def get_active_skills(store: SkillStore, top_n: int = 1) -> dict[str, Any]:
    """返回当前应注入 prompt 的 task skill。

    结构：{"catalog": [紧凑条目...], "skills": [{name, summary, content}...]}
    - catalog：archive 全量的一行摘要（名字 + tag + utility），供小模型按需索取全文；
    - skills：utility 最高的 top_n 个 skill 全文（默认直接注入）。
    """
    arch = store.archive()
    catalog = [
        {
            "name": f"skill-node-{n['id']}",
            "summary": n["tag"] or one_line_summary(n["skill_text"]),
            "utility": round(n["utility"], 4),
            "status": n["status"],
        }
        for n in arch
    ]
    best = sorted(arch, key=lambda n: (-n["utility"], n["id"]))[: max(1, top_n)]
    skills = [
        {
            "name": f"skill-node-{n['id']}",
            "summary": n["tag"],
            "utility": round(n["utility"], 4),
            "content": n["skill_text"],
        }
        for n in best
    ]
    return {"catalog": catalog, "skills": skills}


def get_active_sops(store: SkillStore, limit: int = TOOL_LIMIT) -> list[dict[str, Any]]:
    """返回应注册进 agent 工具列表的 SOP schema（OpenAI function 格式，上限 limit）。"""
    sops = store.get_sops("active")[:limit]
    return [sop_to_schema(s) for s in sops]


def sop_to_schema(sop: dict) -> dict[str, Any]:
    """SOP → OpenAI function-calling schema。"""
    params = sop.get("schema") or {"type": "object", "properties": {}}
    return {
        "type": "function",
        "function": {
            "name": sop["name"],
            "description": (sop.get("docstring") or "").strip()[:500],
            "parameters": params,
        },
    }
