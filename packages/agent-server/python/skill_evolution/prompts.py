"""提示词模板：按简报附录 A/C 要点与 EvoSOP 附录 D 风格撰写（论文未公开全文，自行补全）。

约定：system 消息首行是 [MARKER]（MockLLM 据此路由）；用户消息中嵌入
<<<BLOCK ... >>> 结构化内容块，便于 MockLLM 确定性解析，真实 LLM 亦可读。
"""
from __future__ import annotations

import json
from typing import Any

# meta-skill 五组件名（与简报 §3.2 对应）
META_COMPONENTS = ["psi", "sigma", "alpha", "pi", "epsilon"]

# 初始 meta-skill：附录 C 的三条 Analyzer 指令 + 其余组件的最小可用策略
DEFAULT_META_SKILLS: dict[str, str] = {
    "psi": (
        "# Meta-Skill: Analyzer (psi)\n\n"
        "诊断策略：\n"
        "1. 从执行 trace 中识别主要失败类别（primary failure class）；\n"
        "2. 区分『skill 可解决的失败』与『基座模型能力上限』——防止 skill 被无谓改写；\n"
        "3. 赋予简短具体的失败 tag（≤15 词），tag 词表由本文件维护、由 slow loop 修订。\n\n"
        "## 策略要点\n\n仅诊断最差失败样本；输出结构化 JSON。\n"
    ),
    "sigma": (
        "# Meta-Skill: Retriever (sigma)\n\n"
        "共享策略：优先同 branch 候选，跨 branch 概率 p_cross=0.2；"
        "先按 tag 相似度 over-fetch 3×，再重排到 L_same=3 / L_cross=2。\n\n"
        "## 策略要点\n\n宽深平衡：tag 精确匹配优先，语义相似兜底。\n"
    ),
    "alpha": (
        "# Meta-Skill: Allocator (alpha)\n\n"
        "分配策略：每步 child 预算 K∈[1,K_max=3]；停滞（近期 ΔU 均值≈0）时扩，产效时缩。\n\n"
        "## 策略要点\n\n近 3 轮 ΔU 均值 ≤0.01 → K=K_max；否则 K=1~2。\n"
    ),
    "pi": (
        "# Meta-Skill: Proposer (pi)\n\n"
        "编辑提案策略：由 (失败样本, 根因分析, inspiration 节点) 产出编辑 δ="
        "(target_section, change, rationale, replacement)；K>1 时第 k 个提案须采取不同干预角度。\n\n"
        "## 策略要点\n\n提案必须可直接落实为文件编辑，禁止空泛建议。\n"
    ),
    "epsilon": (
        "# Meta-Skill: Evolver (epsilon)\n\n"
        "编辑执行策略：读当前文件 → 落实 δ → 校验 mutation 与提案一致 → before/after hash 检查"
        "（标记未改变文件的空编辑）→ 刷新 skill registry。\n\n"
        "## 策略要点\n\nhash 未变的编辑必须标记 empty_edit。\n"
    ),
}


def _j(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, indent=2)


# ---------------------------------------------------------------------------
# 五 agent pipeline prompts
# ---------------------------------------------------------------------------


def analyzer_prompt(failure: dict, psi_text: str) -> list[dict]:
    """Analyzer：诊断最差失败样本，输出 {tag, analysis, failure_class, target_skill}。"""
    system = (
        "[ANALYZER] 你是失败诊断专家。遵循当前诊断策略（psi meta-skill）：\n"
        f"{psi_text}\n"
        "硬性要求：\n"
        "1. 识别主要失败类别；\n"
        "2. 必须区分『skill 可解决的失败』与『基座模型能力上限』；\n"
        "3. tag 不超过 15 个词。\n"
        "仅输出 JSON：{\"tag\": str, \"analysis\": str, "
        "\"failure_class\": \"skill_fixable\"|\"capability_limit\", \"target_skill\": str}。"
    )
    user = f"最差失败样本：\n<<<FAILURE\n{_j(failure)}\n>>>"
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def analyzer_meta_prompt(meta_trace: dict, meta_state: dict[str, str]) -> list[dict]:
    """Constrained Analyzer（slow loop）：点名最受牵连的单个 meta 组件，不缩小编辑范围。"""
    system = (
        "[ANALYZER_META] 你是改进策略的诊断专家。输入是一条合成的 meta-failure trace"
        "（最近 H 轮进化的 tags/diagnoses/ΔU 折叠而成）。\n"
        "请诊断改进策略本身哪个组件最受牵连，target_component 必须是 "
        "psi/sigma/alpha/pi/epsilon 之一；若证据不足可输出 null（由调度方 round-robin 兜底）。\n"
        "仅输出 JSON：{\"tag\": str, \"analysis\": str, "
        "\"failure_class\": str, \"target_component\": str|null}。"
    )
    user = f"meta-failure trace：\n<<<META_TRACE\n{_j(meta_trace)}\n>>>"
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def proposer_prompt(
    failure: dict,
    analysis: dict,
    inspirations: list[dict],
    skill_text: str,
    pi_text: str,
    diversity_k: int = 1,
) -> list[dict]:
    """Proposer：产出 δ=(target_section, change, rationale, replacement)。"""
    diversity = (
        f"\n你是第 {diversity_k} 个并行提案者：必须采取与先前提案不同的干预角度，避免近重复 child。"
        if diversity_k > 1
        else ""
    )
    system = (
        f"[PROPOSER k={diversity_k}] 你是 skill 编辑提案专家。遵循提案策略（pi meta-skill）：\n"
        f"{pi_text}{diversity}\n"
        "仅输出 JSON：{\"target_section\": str, \"change\": str, \"rationale\": str, "
        "\"replacement\": str}，replacement 为目标小节的完整新内容。"
    )
    user = (
        f"失败样本：\n<<<FAILURE\n{_j(failure)}\n>>>\n"
        f"根因分析：\n<<<ANALYSIS\n{_j(analysis)}\n>>>\n"
        f"inspiration 节点（可为空）：\n<<<INSPIRATIONS\n{_j(inspirations)}\n>>>\n"
        f"当前 skill 全文：\n<<<CURRENT\n{skill_text}\n>>>"
    )
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def proposer_meta_prompt(
    meta_trace: dict,
    analysis: dict,
    target_component: str,
    meta_file_text: str,
    pi_text: str,
) -> list[dict]:
    """meta Proposer（slow loop whole-m rewrite，串行逐组件）。"""
    system = (
        f"[PROPOSER_META tgt={target_component}] 你是 meta-skill 编辑提案专家。"
        f"本轮目标组件：{target_component}。遵循提案策略：\n{pi_text}\n"
        "仅输出 JSON：{\"target_section\": str, \"change\": str, \"rationale\": str, "
        "\"replacement\": str}。"
    )
    user = (
        f"meta-failure trace：\n<<<META_TRACE\n{_j(meta_trace)}\n>>>\n"
        f"meta 诊断：\n<<<ANALYSIS\n{_j(analysis)}\n>>>\n"
        f"目标 meta 文件当前内容：\n<<<CURRENT\n{meta_file_text}\n>>>"
    )
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def evolver_prompt(skill_text: str, proposal: dict, epsilon_text: str) -> list[dict]:
    """Evolver：落实 δ 并输出新文件全文（JSON），由调用方做 hash 校验。"""
    system = (
        "[EVOLVER] 你是 skill 文件编辑执行器。遵循执行策略（epsilon meta-skill）：\n"
        f"{epsilon_text}\n"
        "把提案落实到文件：仅修改目标小节，保持其余内容不变。"
        "仅输出 JSON：{\"new_content\": str, \"notes\": str}。"
    )
    user = (
        f"当前文件：\n<<<CURRENT\n{skill_text}\n>>>\n"
        f"编辑提案：\n<<<PROPOSAL\n{_j(proposal)}\n>>>"
    )
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def allocator_prompt(recent_delta_us: list[float], analysis: dict, k_max: int) -> list[dict]:
    """Allocator 的 LLM 模式（默认规则化，此 prompt 仅备选）。"""
    system = (
        "[ALLOCATOR] 你是 child 预算分配专家。停滞扩、产效缩。"
        "仅输出 JSON：{\"K\": int, \"rationale\": str}。"
    )
    user = (
        f"历史与诊断：\n<<<HISTORY\n"
        f"{_j({'recent_delta_us': recent_delta_us, 'k_max': k_max, 'analysis': analysis.get('analysis', '')})}\n>>>"
    )
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


# ---------------------------------------------------------------------------
# EvoSOP prompts（按附录 D 的六段式：Identity→Mission→Paradigm→Constraints→Output→Input）
# ---------------------------------------------------------------------------


def sop_extract_prompt(traj_json: list[dict], tool_docs: dict[str, str]) -> list[dict]:
    """CONSTRUCTOR 阶段一 f_extract：从轨迹识别 2-5 个共现原子动作段。"""
    system = (
        "[SOP_EXTRACT] You are a specialized agent who is good at text extraction and "
        "analyzing, designed to extract reusable and meaningful consecutive `tool_call`s "
        "from action trajectories, forming Standard Operation Procedures (SOPs).\n"
        "归纳范式：1) 连续 tool_call；2) 逻辑紧密但非连续的调用；3) 前一返回值被后一用作输入；"
        "4) 有意义的组合；5) 高频使用。\n"
        "硬约束：每个 SOP 至少 2 个、至多 5 个 tool_call；组合跨度不能太大；"
        "DO NOT INTEGRATE IRRELEVANT TOOL COMBINATIONS；无价值组合输出空 list；"
        "除要求输出外 DO NOT OUTPUT ANYTHING ELSE。"
    )
    user = (
        f"原子工具文档：\n{_j(tool_docs)}\n"
        f"轨迹（仅 tool_call 的 JSON，忽略长 text 字段）：\n<<<TRAJ\n{_j(traj_json)}\n>>>\n"
        "输出：序列化 Python list，元素为各 SOP 的 message_number 列表，如 [[1,2],[4,5,6]]；无则 []。"
    )
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def sop_rewrite_prompt(segment_calls: list[dict], tool_docs: dict[str, str], function_guidance: str) -> list[dict]:
    """CONSTRUCTOR 阶段二 f_rewrite：把选段函数化为带分支/错误处理的 Python SOP。"""
    system = (
        "[SOP_REWRITE] You are a specialized agent who is good at software engineering, "
        "designed to rewrite consecutive `tool_call`s into a Standard Operating Procedure (SOP) "
        "as a single Python function with a Google-style docstring.\n"
        "约束：Pay special attention to the docstrings of the input parameters；"
        "在 docstring 中按序列出所有用到的 tool_call 名称；"
        "允许条件分支、错误处理与重试；Except the code, DO NOT OUTPUT ANY OTHER THINGS。\n"
        f"环境特定函数构造约束（function_guidance）：{function_guidance}"
    )
    involved = {c["tool"]: tool_docs.get(c["tool"], "") for c in segment_calls}
    user = (
        f"涉及工具的 docstring：\n{_j(involved)}\n"
        f"选段（带 message_number）：\n<<<SEGMENT\n{_j({'calls': segment_calls})}\n>>>"
    )
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def merger_prompt(sops: list[dict]) -> list[dict]:
    """MERGER：检测功能冗余，合成更泛化的复合 SOP（非破坏性，旧件保留）。"""
    brief = [
        {"name": s["name"], "docstring": s.get("docstring", ""), "tools": s.get("tools", []), "code": s.get("code", "")[:800]}
        for s in sops
    ]
    system = (
        "[MERGER] 你是 SOP 结构优化专家。检测候选 SOP 间是否存在共享目标或高度相似的逻辑"
        "（functional overlaps），将重叠组合成为更具表达力且保持泛化性的复合 SOP。\n"
        "非破坏性约束：只新增复合 SOP，不删除原 SOP；无明显重叠时输出空 merges。\n"
        "仅输出 JSON：{\"merges\": [{\"members\": [name...], \"sop\": {\"name\": str, "
        "\"code\": str, \"docstring\": str, \"tools\": [str...]}, \"rationale\": str}]}。"
    )
    user = f"候选 SOP 集合：\n<<<SOPS\n{_j(brief)}\n>>>"
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def reviewer_prompt(sop: dict, stats: dict) -> list[dict]:
    """REVIEWER 的 LLM 兜底 f_check：确定性规则未触发时裁决 remove/retain。"""
    system = (
        "[REVIEWER] 你是 SOP 质量评审专家（LLM-as-a-critic）。"
        "依据聚合统计判定 remove/retain。剪除信号：高 Implementation Defect 率、"
        "与现有工具显著冗余、低效用（很少被调用）、语义错位（误导性名称/docstring）。\n"
        "仅输出 JSON：{\"decision\": \"remove\"|\"retain\", \"reason\": str}。"
    )
    user = f"SOP 与聚合统计：\n<<<STATS\n{_j({'sop': sop, 'stats': stats})}\n>>>"
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


# ---------------------------------------------------------------------------
# meta-failure trace 构造（简报 §5：同一 Analyzer prompt 服务两个时间尺度的实现技巧）
# ---------------------------------------------------------------------------


def build_meta_failure_trace(window: list[dict], p_hat: float, iteration: int) -> dict:
    """把最近 H 轮的 (tag, analysis 摘要, ΔU) + P̂ 折叠成一条合成的 meta-failure trace。"""
    return {
        "kind": "meta_failure_trace",
        "iteration": iteration,
        "p_hat": round(p_hat, 6),
        "window": [
            {
                "iteration": w.get("iteration"),
                "tag": w.get("tag", ""),
                "delta_u": round(float(w.get("delta_u", 0.0)), 6),
                "analysis": str(w.get("analysis", ""))[:120],
            }
            for w in window
        ],
        "instruction": "请诊断改进策略本身哪个组件（psi/sigma/alpha/pi/epsilon）导致停滞或失效。",
    }
