"""Verification-Guided Selection 复现包。

路线三：LLM-as-a-Verifier + EvoAgentBench 经验筛选管线。
大模型轨迹 → 小模型 verifier 连续打分 → 高分经验结构化（五元组）
→ 保守 canonicalize → SQLite(FTS5) 经验库 → Anchor oracle 诊断对照。
"""
from .llm_client import (LLMClient, LLMError, MockLLM, MockResponse,
                         OpenAICompatClient, contains, messages_text)
from .experience import (CARD_SCHEMA, ROLES, ExperienceCard, SchemaError,
                         parse_card_json, validate_schema)
from .verifier import (DEFAULT_CRITERIA, Criterion, DictReasoningCache, LetterScale,
                       PairScore, ScoreExtractionError, TournamentResult,
                       TwoStageScorer, Verifier, bradley_terry,
                       expected_from_top_logprobs, extract_tag_distribution,
                       probabilistic_pivot_tournament)
from .canonicalize import (ACCEPT_LABELS, REJECT_LABELS, Adjudication, CanonResult,
                           CanonicalUnit, adjudicate_pair, canonicalize,
                           tfidf_blocking)
from .library import ExperienceLibrary, SearchHit, SQLiteReasoningCache, card_id_of
from .anchor import AnchorOracleRouter, compare_routing
from .pipeline import (REFERENCE_TRAJECTORY, PipelineReport, ScoredTrajectory,
                       TeacherTrajectory, select_experiences)

__all__ = [
    "LLMClient", "LLMError", "MockLLM", "MockResponse", "OpenAICompatClient",
    "contains", "messages_text",
    "CARD_SCHEMA", "ROLES", "ExperienceCard", "SchemaError", "parse_card_json",
    "validate_schema",
    "DEFAULT_CRITERIA", "Criterion", "DictReasoningCache", "LetterScale",
    "PairScore", "ScoreExtractionError", "TournamentResult", "TwoStageScorer",
    "Verifier", "bradley_terry", "expected_from_top_logprobs",
    "extract_tag_distribution", "probabilistic_pivot_tournament",
    "ACCEPT_LABELS", "REJECT_LABELS", "Adjudication", "CanonResult",
    "CanonicalUnit", "adjudicate_pair", "canonicalize", "tfidf_blocking",
    "ExperienceLibrary", "SearchHit", "SQLiteReasoningCache", "card_id_of",
    "AnchorOracleRouter", "compare_routing",
    "REFERENCE_TRAJECTORY", "PipelineReport", "ScoredTrajectory",
    "TeacherTrajectory", "select_experiences",
]
