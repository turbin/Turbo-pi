"""ExperienceCard schema（EvoAgentBench §3.2.2 + issue-010 交付物维度）。

五元组 a = (γ, π, E, ∂, ρ) + deliverables（交付物清单）：
- trigger   触发条件（"Use when ..." 句式，适用性条件而非主题标签）
- procedure 可复用程序（编号步骤，actionable operation）
- deliverables 任务最终必须产出的文件/产物/状态（非空字符串数组，issue-010）
- evidence  支撑证据 {task_id, backbone, trace_span_ref, verifier_score, target_ref}
- boundary  适用边界（"Must not ..." 句式，防止虚假迁移链接）
- role      Method | Guard | Workflow 三分类

提供 JSON 序列化 + 一个 stdlib 实现的 JSON Schema 子集校验器
（支持 type/required/properties/enum/minLength/pattern/minItems/items，
覆盖 CARD_SCHEMA 所需）。
"""
from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from typing import Any


class SchemaError(ValueError):
    """JSON Schema 校验失败。"""


# ---------------------------------------------------------------------------
# 五元组 schema（Draft JSON Schema 子集）
# ---------------------------------------------------------------------------

ROLES = ("Method", "Guard", "Workflow")

CARD_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["trigger", "procedure", "evidence", "boundary", "role", "deliverables"],
    "properties": {
        "name": {"type": "string"},
        "trigger": {"type": "string", "minLength": 8},
        "procedure": {"type": "string", "minLength": 8},
        # 交付物清单（issue-010）：任务最终必须产出的文件/产物/状态，非空字符串数组。
        "deliverables": {"type": "array", "minItems": 1, "items": {"type": "string", "minLength": 1}},
        "boundary": {"type": "string", "minLength": 9, "pattern": "^Must not"},
        "role": {"type": "string", "enum": list(ROLES)},
        "evidence": {
            "type": "object",
            "required": ["task_id", "verifier_score"],
            "properties": {
                "task_id": {"type": "string"},
                "backbone": {"type": "string"},
                "trace_span_ref": {"type": "string"},
                "verifier_score": {"type": "number"},
                "target_ref": {"type": "string"},
            },
        },
    },
}


# ---------------------------------------------------------------------------
# 极简 JSON Schema 校验器（stdlib only，只实现本项目用到的关键字）
# ---------------------------------------------------------------------------

_TYPE_CHECKS = {
    "object": lambda v: isinstance(v, dict),
    "array": lambda v: isinstance(v, list),
    "string": lambda v: isinstance(v, str),
    "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
    "integer": lambda v: isinstance(v, int) and not isinstance(v, bool),
    "boolean": lambda v: isinstance(v, bool),
}


def validate_schema(data: Any, schema: dict, path: str = "$") -> list[str]:
    """返回错误列表（空列表 = 通过）。只支持 CARD_SCHEMA 用到的关键字。"""
    errors: list[str] = []
    t = schema.get("type")
    if t in _TYPE_CHECKS and not _TYPE_CHECKS[t](data):
        errors.append(f"{path}: 期望类型 {t}，实际 {type(data).__name__}")
        return errors  # 类型不符时不再深入

    if "enum" in schema and data not in schema["enum"]:
        errors.append(f"{path}: 值 {data!r} 不在枚举 {schema['enum']} 内")

    if t == "string":
        if "minLength" in schema and len(data) < schema["minLength"]:
            errors.append(f"{path}: 长度 {len(data)} < minLength {schema['minLength']}")
        if "pattern" in schema and not re.search(schema["pattern"], data):
            errors.append(f"{path}: 不匹配 pattern {schema['pattern']!r}")

    if t == "object":
        for key in schema.get("required", []):
            if key not in data:
                errors.append(f"{path}: 缺少必填字段 {key!r}")
        for key, sub in schema.get("properties", {}).items():
            if key in data:
                errors.extend(validate_schema(data[key], sub, f"{path}.{key}"))

    if t == "array":
        if "minItems" in schema and len(data) < schema["minItems"]:
            errors.append(f"{path}: 长度 {len(data)} < minItems {schema['minItems']}")
        if "items" in schema:
            for i, item in enumerate(data):
                errors.extend(validate_schema(item, schema["items"], f"{path}[{i}]"))

    return errors


# ---------------------------------------------------------------------------
# ExperienceCard 数据类
# ---------------------------------------------------------------------------

@dataclass
class ExperienceCard:
    """经验卡五元组 + deliverables 交付物清单。name 为可选标题，不参与五元组语义。"""

    trigger: str
    procedure: str
    evidence: dict
    boundary: str
    role: str
    name: str = ""
    # 交付物清单（issue-010）：任务最终必须产出的文件/产物/状态。
    deliverables: list = field(default_factory=list)

    # -- 校验 ---------------------------------------------------------------
    def validate(self) -> list[str]:
        """按 CARD_SCHEMA 校验，返回错误列表（空 = 通过）。"""
        return validate_schema(self.to_dict(), CARD_SCHEMA)

    def validate_strict(self) -> None:
        errors = self.validate()
        if errors:
            raise SchemaError("ExperienceCard 校验失败: " + "; ".join(errors))

    # -- 序列化 -------------------------------------------------------------
    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "trigger": self.trigger,
            "procedure": self.procedure,
            "boundary": self.boundary,
            "role": self.role,
            "deliverables": list(self.deliverables),
            "evidence": dict(self.evidence),
        }

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), ensure_ascii=False, sort_keys=True)

    @classmethod
    def from_dict(cls, data: dict, *, strict: bool = True) -> "ExperienceCard":
        card = cls(
            trigger=data.get("trigger", ""),
            procedure=data.get("procedure", ""),
            evidence=dict(data.get("evidence", {})),
            boundary=data.get("boundary", ""),
            role=data.get("role", ""),
            name=data.get("name", ""),
            deliverables=list(data.get("deliverables", [])),
        )
        if strict:
            card.validate_strict()
        return card

    @classmethod
    def from_json(cls, text: str, *, strict: bool = True) -> "ExperienceCard":
        return cls.from_dict(json.loads(text), strict=strict)

    # -- 便捷视图 -----------------------------------------------------------
    def blocking_text(self) -> str:
        """canonicalization blocking 的索引文本（trigger+procedure+boundary+role）。"""
        return " ".join([self.trigger, self.procedure, self.boundary, self.role])


def parse_card_json(text: str, *, strict: bool = True) -> ExperienceCard:
    """从 LLM 输出中稳健解析首个 JSON 对象为 ExperienceCard。"""
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        raise SchemaError("输出中未找到 JSON 对象")
    try:
        data = json.loads(text[start:end + 1])
    except json.JSONDecodeError as e:
        raise SchemaError(f"JSON 解析失败: {e}") from e
    return ExperienceCard.from_dict(data, strict=strict)
