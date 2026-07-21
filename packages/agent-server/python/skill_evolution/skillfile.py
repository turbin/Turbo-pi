"""SKILL.md 文件工具：分节、替换、hash、摘要。纯 stdlib。"""
from __future__ import annotations

import hashlib
import re

_SECTION_RE = re.compile(r"^(#{1,6})[ \t]+(.+?)[ \t]*$", re.M)


def sha256_text(text: str) -> str:
    """文本的 sha256（Evolver before/after hash 校验用）。"""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def split_sections(md: str) -> list[tuple[str, int, int]]:
    """把 Markdown 切成 [(标题, 正文起点, 正文终点), ...]。

    标题不含 # 号；文件开头到第一个标题之间的内容归入标题 ""（前言）。
    """
    matches = list(_SECTION_RE.finditer(md))
    sections: list[tuple[str, int, int]] = []
    if not matches:
        return [("", 0, len(md))]
    if matches[0].start() > 0:
        sections.append(("", 0, matches[0].start()))
    for i, m in enumerate(matches):
        body_start = m.end() + 1  # 跳过标题行后的换行
        body_end = matches[i + 1].start() if i + 1 < len(matches) else len(md)
        sections.append((m.group(2), body_start, body_end))
    return sections


def find_section(md: str, title: str) -> tuple[int, int] | None:
    """按标题名（精确匹配，忽略大小写）找到正文区间。"""
    for t, start, end in split_sections(md):
        if t.strip().lower() == title.strip().lower():
            return start, end
    return None


def replace_section(md: str, title: str, new_body: str) -> str:
    """把指定标题的正文替换为 new_body；标题不存在则在文末追加新节。

    这是 Evolver 的确定性 splice 兜底，也是 MockLLM evolver 的实现。
    """
    span = find_section(md, title)
    new_body = new_body.strip("\n")
    if span is None:
        prefix = md.rstrip("\n") + "\n\n" if md.strip() else ""
        return f"{prefix}## {title}\n\n{new_body}\n"
    start, end = span
    rest = md[end:].lstrip("\n")
    sep = "\n\n" if rest.strip() else "\n"  # 后续还有小节时隔一个空行
    return md[:start] + "\n" + new_body + sep + rest


def one_line_summary(md: str, limit: int = 60) -> str:
    """取首个非标题非空行作为一行摘要（skill catalog 渐进披露用）。"""
    for line in md.splitlines():
        s = line.strip().lstrip("#").strip()
        if s:
            return s[:limit]
    return ""


def tokenize(text: str) -> list[str]:
    """中英混合简易分词：ASCII 词 + CJK 单字与二字组（FTS 索引与余弦相似度用）。"""
    toks = re.findall(r"[A-Za-z0-9_]+", text.lower())
    cjk = re.findall(r"[一-鿿]", text)
    toks.extend(cjk)
    toks.extend("".join(cjk[i : i + 2]) for i in range(len(cjk) - 1))
    return toks


def cosine_sim(a: list[str], b: list[str]) -> float:
    """两个 token 列表的余弦相似度（词袋模型，无需 numpy）。"""
    from collections import Counter
    from math import sqrt

    ca, cb = Counter(a), Counter(b)
    if not ca or not cb:
        return 0.0
    dot = sum(ca[t] * cb.get(t, 0) for t in ca)
    na = sqrt(sum(v * v for v in ca.values()))
    nb = sqrt(sum(v * v for v in cb.values()))
    return dot / (na * nb) if na and nb else 0.0
