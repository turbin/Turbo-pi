"""SQLite + FTS5 经验知识库。

三张表：cards（经验卡 + 质量分 + canonical 链接）、cards_fts（FTS5 全文索引）、
units（canonical 单元）、reasoning_cache（两阶段通路的 teacher reasoning 缓存）。
FTS5 不可用时自动降级为 LIKE 检索（ fts_enabled=False ）。
"""
from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone

from .canonicalize import CanonicalUnit
from .experience import ExperienceCard


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def card_id_of(card: ExperienceCard) -> str:
    """内容寻址 card id（含 evidence，因此同文本不同任务的卡不冲突）。"""
    return "C" + hashlib.sha1(card.to_json().encode("utf-8")).hexdigest()[:12]


@dataclass
class SearchHit:
    card_id: str
    card: ExperienceCard
    score: float       # FTS5 为 -bm25（越大越好）；LIKE 降级为命中词数
    quality: float
    source: str        # "fts" | "like"


class ExperienceLibrary:
    """经验知识库。path=":memory:" 为纯内存；也可落盘为文件。"""

    def __init__(self, path: str = ":memory:"):
        self.path = path
        self.conn = sqlite3.connect(path)
        self.conn.row_factory = sqlite3.Row
        self.fts_enabled = self._probe_fts5()
        self._init_schema()

    # -- schema -------------------------------------------------------------
    def _probe_fts5(self) -> bool:
        try:
            self.conn.execute("CREATE VIRTUAL TABLE temp._fts_probe USING fts5(x)")
            self.conn.execute("DROP TABLE temp._fts_probe")
            return True
        except sqlite3.OperationalError:
            return False

    def _init_schema(self) -> None:
        cur = self.conn.cursor()
        cur.executescript("""
        CREATE TABLE IF NOT EXISTS cards (
            card_id      TEXT PRIMARY KEY,
            name         TEXT NOT NULL DEFAULT '',
            trigger_text TEXT NOT NULL,
            procedure    TEXT NOT NULL,
            boundary     TEXT NOT NULL,
            role         TEXT NOT NULL,
            quality      REAL NOT NULL DEFAULT 0.0,
            canonical_id TEXT,
            task_id      TEXT NOT NULL DEFAULT '',
            card_json    TEXT NOT NULL,
            created_at   TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS units (
            unit_id            TEXT PRIMARY KEY,
            role               TEXT NOT NULL,
            trigger_text       TEXT NOT NULL,
            procedure          TEXT NOT NULL,
            boundary           TEXT NOT NULL,
            quality            REAL NOT NULL DEFAULT 0.0,
            members_json       TEXT NOT NULL,
            support_tasks_json TEXT NOT NULL,
            created_at         TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS reasoning_cache (
            cache_key  TEXT PRIMARY KEY,
            reasoning  TEXT NOT NULL,
            meta       TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL
        );
        """)
        if self.fts_enabled:
            cur.execute("""
            CREATE VIRTUAL TABLE IF NOT EXISTS cards_fts USING fts5(
                card_id UNINDEXED, name, trigger_text, procedure, boundary
            )""")
        self.conn.commit()

    # -- 写入 ---------------------------------------------------------------
    def add_card(self, card: ExperienceCard, quality: float, *,
                 task_id: str = "", canonical_id: str | None = None) -> str:
        """入库经验卡（内容寻址去重：同 id 已存在则直接返回）。"""
        card.validate_strict()
        cid = card_id_of(card)
        cur = self.conn.execute(
            """INSERT OR IGNORE INTO cards
               (card_id, name, trigger_text, procedure, boundary, role,
                quality, canonical_id, task_id, card_json, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (cid, card.name, card.trigger, card.procedure, card.boundary, card.role,
             quality, canonical_id, task_id, card.to_json(), _utcnow()))
        if cur.rowcount and self.fts_enabled:
            self.conn.execute(
                "INSERT INTO cards_fts (card_id, name, trigger_text, procedure, boundary)"
                " VALUES (?,?,?,?,?)",
                (cid, card.name, card.trigger, card.procedure, card.boundary))
        self.conn.commit()
        return cid

    def set_canonical_id(self, card_id: str, canonical_id: str) -> None:
        self.conn.execute("UPDATE cards SET canonical_id=? WHERE card_id=?",
                          (canonical_id, card_id))
        self.conn.commit()

    def add_unit(self, unit: CanonicalUnit) -> None:
        self.conn.execute(
            """INSERT OR REPLACE INTO units
               (unit_id, role, trigger_text, procedure, boundary, quality,
                members_json, support_tasks_json, created_at)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (unit.unit_id, unit.role, unit.trigger, unit.procedure, unit.boundary,
             unit.quality, json.dumps(unit.members, ensure_ascii=False),
             json.dumps(unit.support_tasks, ensure_ascii=False), _utcnow()))
        self.conn.commit()

    # -- 读取 ---------------------------------------------------------------
    def get_card(self, card_id: str) -> ExperienceCard | None:
        row = self.conn.execute("SELECT card_json FROM cards WHERE card_id=?",
                                (card_id,)).fetchone()
        return ExperienceCard.from_json(row["card_json"]) if row else None

    def list_cards(self) -> list[sqlite3.Row]:
        return self.conn.execute(
            "SELECT card_id, name, role, quality, canonical_id, task_id FROM cards"
            " ORDER BY quality DESC").fetchall()

    def cards_of_unit(self, unit_id: str) -> list[sqlite3.Row]:
        return self.conn.execute(
            "SELECT card_id, name, role, quality, task_id FROM cards"
            " WHERE canonical_id=? ORDER BY quality DESC", (unit_id,)).fetchall()

    def get_unit(self, unit_id: str) -> dict | None:
        row = self.conn.execute("SELECT * FROM units WHERE unit_id=?", (unit_id,)).fetchone()
        return dict(row) if row else None

    def list_units(self) -> list[sqlite3.Row]:
        return self.conn.execute(
            "SELECT unit_id, role, quality, members_json, support_tasks_json FROM units"
            " ORDER BY quality DESC").fetchall()

    # -- 检索（运行时 routing 的自动通道） ----------------------------------
    @staticmethod
    def _query_tokens(query: str) -> list[str]:
        return re.findall(r"[a-z0-9_]+|[\u4e00-\u9fff]", query.lower())

    def search(self, query: str, top_k: int = 5) -> list[SearchHit]:
        """FTS5 全文检索（bm25 排序）；FTS5 不可用时降级 LIKE。"""
        tokens = self._query_tokens(query)
        if not tokens:
            return []
        if self.fts_enabled:
            match = " OR ".join(f'"{t}"' for t in tokens)
            rows = self.conn.execute(
                """SELECT f.card_id AS card_id, bm25(cards_fts) AS rank, c.quality AS quality
                   FROM cards_fts f JOIN cards c ON c.card_id = f.card_id
                   WHERE cards_fts MATCH ? ORDER BY rank LIMIT ?""",
                (match, top_k)).fetchall()
            hits = [SearchHit(r["card_id"], self.get_card(r["card_id"]),
                              -float(r["rank"]), float(r["quality"]), "fts")
                    for r in rows]
            return hits
        # LIKE 降级：按命中 token 数排序
        hits: list[SearchHit] = []
        for row in self.conn.execute("SELECT card_id, quality, card_json FROM cards"):
            card = ExperienceCard.from_json(row["card_json"])
            text = card.blocking_text().lower() + " " + card.name.lower()
            n_hit = sum(1 for t in tokens if t in text)
            if n_hit:
                hits.append(SearchHit(row["card_id"], card, float(n_hit),
                                      float(row["quality"]), "like"))
        hits.sort(key=lambda h: (-h.score, -h.quality))
        return hits[:top_k]

    # -- reasoning 缓存（两阶段通路） ---------------------------------------
    def put_reasoning(self, key: str, reasoning: str, meta: dict | None = None) -> None:
        self.conn.execute(
            "INSERT OR REPLACE INTO reasoning_cache (cache_key, reasoning, meta, created_at)"
            " VALUES (?,?,?,?)",
            (key, reasoning, json.dumps(meta or {}, ensure_ascii=False), _utcnow()))
        self.conn.commit()

    def get_reasoning(self, key: str) -> str | None:
        row = self.conn.execute("SELECT reasoning FROM reasoning_cache WHERE cache_key=?",
                                (key,)).fetchone()
        return row["reasoning"] if row else None

    # -- 统计 ---------------------------------------------------------------
    def stats(self) -> dict:
        c = self.conn.execute("SELECT COUNT(*) AS n FROM cards").fetchone()["n"]
        u = self.conn.execute("SELECT COUNT(*) AS n FROM units").fetchone()["n"]
        r = self.conn.execute("SELECT COUNT(*) AS n FROM reasoning_cache").fetchone()["n"]
        return {"cards": c, "units": u, "reasoning_cache": r,
                "fts_enabled": self.fts_enabled, "path": self.path}

    def close(self) -> None:
        self.conn.close()


class SQLiteReasoningCache:
    """挂到知识库 reasoning_cache 表的两阶段通路缓存。"""

    def __init__(self, library: ExperienceLibrary):
        self.library = library

    def get(self, key: str) -> str | None:
        return self.library.get_reasoning(key)

    def set(self, key: str, value: str, meta: dict | None = None) -> None:
        self.library.put_reasoning(key, value, meta)
