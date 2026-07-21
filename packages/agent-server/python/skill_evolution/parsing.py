"""结构化输出解析：JSON 提取 + 受约束 response_format + 一次 repair call。

对应 MetaSkill-Evolve 附录 A 的鲁棒性机制，按简报 §7.2 简化为两层：
1. primary：请求 JSON 输出（OpenAI response_format=json_object），本地多策略提取；
2. fallback：解析失败时发起一次受约束 repair call，再提取一次。
"""
from __future__ import annotations

import ast
import json
import re
from typing import Any

from .llm_client import LLMClient


class ParseError(ValueError):
    """结构化输出解析失败（含 repair 后仍失败）。"""


_FENCE_RE = re.compile(r"```(?:json|python)?\s*\n?(.*?)```", re.S)


def extract_json(text: str) -> Any:
    """从模型输出中提取 JSON：依次尝试 整串 → 围栏块 → 首尾括号切片。"""
    text = (text or "").strip()
    candidates = [text]
    m = _FENCE_RE.search(text)
    if m:
        candidates.insert(0, m.group(1).strip())
    for open_c, close_c in (("{", "}"), ("[", "]")):
        i, j = text.find(open_c), text.rfind(close_c)
        if i != -1 and j > i:
            candidates.append(text[i : j + 1])
    for cand in candidates:
        try:
            return json.loads(cand)
        except (json.JSONDecodeError, TypeError):
            continue
    raise ParseError(f"无法从输出中提取 JSON: {text[:200]!r}")


def extract_code(text: str) -> str:
    """从模型输出中提取 Python 代码：优先围栏块，否则整串。"""
    text = (text or "").strip()
    m = re.search(r"```(?:python)?\s*\n(.*?)```", text, re.S)
    return m.group(1).strip() if m else text


def extract_pylist(text: str) -> list:
    """提取序列化 Python list（EvoSOP f_extract 的输出契约）。"""
    text = (text or "").strip()
    m = re.search(r"\[.*\]", text, re.S)
    if not m:
        raise ParseError(f"未找到 list 输出: {text[:200]!r}")
    try:
        value = ast.literal_eval(m.group(0))
    except (SyntaxError, ValueError) as exc:
        raise ParseError(f"list 字面量解析失败: {exc}") from exc
    if not isinstance(value, list):
        raise ParseError("输出不是 list")
    return value


def llm_json(llm: LLMClient, messages: list[dict], **kw: Any) -> Any:
    """调用 LLM 并解析 JSON；失败时发起一次 repair call（第二层）。

    repair call 同样要求 JSON 输出；仍失败则抛 ParseError。
    """
    kw.setdefault("response_format", {"type": "json_object"})
    raw = llm.chat(messages, **kw)
    try:
        return extract_json(raw)
    except ParseError:
        pass
    repair_messages = [
        {"role": "system", "content": "[REPAIR] 你是 JSON 修复器，只输出合法 JSON，禁止任何解释。"},
        {"role": "user", "content": f"<<<BROKEN\n{raw}\n>>>\n请将上述内容修复为合法 JSON，仅输出 JSON。"},
    ]
    raw2 = llm.chat(repair_messages, **kw)
    return extract_json(raw2)
