"""skill_evolution：External Skill Evolution（MetaSkill-Evolve + EvoSOP）复现包。

下游集成核心接口：
- SkillStore(root_dir)：SQLite + FTS5 知识库（evolution DAG + SOP 生命周期）。
- EvolutionRunner(store, teacher_llm, eval_fn, config)：双时间尺度 skill 进化主循环。
- SopLifecycle(store, llm, tools, tool_docs, ...)：SOP 构造—合并—评估—剪枝闭环。
- get_active_skills(store) / get_active_sops(store)：运行时注入接口。
- LLMClient 协议、OpenAICompatClient（真实 API）、MockLLM（离线确定性）。
"""
from .evolution import EvolutionConfig, EvolutionRunner, IterationReport
from .llm_client import LLMClient, LLMError, MockLLM, OpenAICompatClient
from .pipeline import (
    Allocator,
    Analysis,
    Analyzer,
    Evolver,
    EvolveResult,
    Inspiration,
    Proposal,
    Proposer,
    Retriever,
)
from .prompts import DEFAULT_META_SKILLS, META_COMPONENTS
from .runtime import TOOL_LIMIT, get_active_skills, get_active_sops, sop_to_schema
from .sop import SopConfig, SopLifecycle, default_reexecute, schema_from_code, static_check
from .store import SkillStore

__all__ = [
    "LLMClient",
    "LLMError",
    "MockLLM",
    "OpenAICompatClient",
    "SkillStore",
    "EvolutionRunner",
    "EvolutionConfig",
    "IterationReport",
    "Analyzer",
    "Retriever",
    "Allocator",
    "Proposer",
    "Evolver",
    "Analysis",
    "Inspiration",
    "Proposal",
    "EvolveResult",
    "DEFAULT_META_SKILLS",
    "META_COMPONENTS",
    "SopLifecycle",
    "SopConfig",
    "static_check",
    "schema_from_code",
    "default_reexecute",
    "get_active_skills",
    "get_active_sops",
    "sop_to_schema",
    "TOOL_LIMIT",
]
