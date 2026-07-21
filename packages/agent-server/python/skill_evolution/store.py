"""SkillStore：SKILL.md 文件 + SQLite（FTS5 索引 + evolution DAG + SOP 生命周期表）。

设计对齐简报 §3.3 / §7.1：
- nodes 表：evolution DAG 节点，存 skill 快照、meta_state_json、U、ΔU、φ、
  branch_path、times_selected；append-only，创建后不被原地修改。
- edges 表：lineage（父子血缘）与 inspiration（检索启发）双类边。
- node_fts：FTS5 contentless 索引（中英混合简易分词），供 Retriever 候选召回。
- sops / sop_reviews / checkpoints：EvoSOP 生命周期存储。
- meta_snapshots：slow loop 每次重写 meta-skill 的快照（provenance）。
工作目录结构：<root>/evolution.db、<root>/worktree/（restore 的临时文件）。
"""
from __future__ import annotations

import json
import os
import sqlite3
from datetime import datetime, timezone
from typing import Any

from .skillfile import tokenize

_SCHEMA = """
CREATE TABLE IF NOT EXISTS nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_id INTEGER,
    kind TEXT NOT NULL DEFAULT 'skill',
    skill_text TEXT NOT NULL,
    utility REAL NOT NULL DEFAULT 0.0,
    delta_u REAL NOT NULL DEFAULT 0.0,
    tag TEXT NOT NULL DEFAULT '',
    branch_path TEXT NOT NULL DEFAULT '0',
    times_selected INTEGER NOT NULL DEFAULT 0,
    meta_state_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'dormant',      -- archive | dormant
    iteration INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    src INTEGER NOT NULL,
    dst INTEGER NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('lineage', 'inspiration'))
);
CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst);
CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id);
CREATE VIRTUAL TABLE IF NOT EXISTS node_fts USING fts5(text_tok, content='');
CREATE TABLE IF NOT EXISTS meta_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    iteration INTEGER NOT NULL,
    tag TEXT NOT NULL DEFAULT '',
    p_hat REAL NOT NULL DEFAULT 0.0,
    state_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    code TEXT NOT NULL,
    docstring TEXT NOT NULL DEFAULT '',
    schema_json TEXT NOT NULL DEFAULT '{}',
    tools_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'active',       -- active | pruned
    epoch_created INTEGER NOT NULL DEFAULT 0,
    epoch_pruned INTEGER,
    merged_from TEXT NOT NULL DEFAULT '',
    source_trace TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sop_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sop_id INTEGER NOT NULL,
    epoch INTEGER NOT NULL,
    calls INTEGER NOT NULL DEFAULT 0,
    success INTEGER NOT NULL DEFAULT 0,
    labels_json TEXT NOT NULL DEFAULT '{}',
    reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reviews_sop ON sop_reviews(sop_id);
CREATE TABLE IF NOT EXISTS checkpoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    epoch INTEGER NOT NULL,
    success_rate REAL NOT NULL,
    snapshot_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class SkillStore:
    """SQLite 持久化的 evolution DAG + SOP 生命周期库（知识库唯一事实来源）。"""

    def __init__(self, root_dir: str) -> None:
        self.root = os.path.abspath(root_dir)
        os.makedirs(self.root, exist_ok=True)
        os.makedirs(os.path.join(self.root, "worktree"), exist_ok=True)
        self.db = sqlite3.connect(os.path.join(self.root, "evolution.db"))
        self.db.row_factory = sqlite3.Row
        self.db.executescript(_SCHEMA)
        self.db.commit()

    def close(self) -> None:
        self.db.close()

    # ------------------------------------------------------------------
    # evolution DAG：nodes / edges / FTS
    # ------------------------------------------------------------------

    def add_node(
        self,
        *,
        parent_id: int | None,
        skill_text: str,
        utility: float,
        delta_u: float,
        tag: str,
        branch_path: str,
        meta_state: dict[str, str],
        iteration: int,
        status: str,
        kind: str = "skill",
    ) -> int:
        """追加 DAG 节点（append-only）；同时写入 FTS 索引。"""
        cur = self.db.execute(
            "INSERT INTO nodes(parent_id, kind, skill_text, utility, delta_u, tag, "
            "branch_path, times_selected, meta_state_json, status, iteration, created_at) "
            "VALUES (?,?,?,?,?,?,?,0,?,?,?,?)",
            (
                parent_id,
                kind,
                skill_text,
                float(utility),
                float(delta_u),
                tag,
                branch_path,
                json.dumps(meta_state, ensure_ascii=False),
                status,
                iteration,
                _now(),
            ),
        )
        nid = int(cur.lastrowid)
        self.db.execute(
            "INSERT INTO node_fts(rowid, text_tok) VALUES (?, ?)",
            (nid, " ".join(tokenize(f"{tag} {skill_text[:2000]}"))),
        )
        self.db.commit()
        return nid

    def add_edge(self, src: int, dst: int, type_: str) -> None:
        if type_ not in ("lineage", "inspiration"):
            raise ValueError(f"非法边类型: {type_}")
        self.db.execute("INSERT INTO edges(src, dst, type) VALUES (?,?,?)", (src, dst, type_))
        self.db.commit()

    def get_node(self, nid: int) -> dict | None:
        row = self.db.execute("SELECT * FROM nodes WHERE id=?", (nid,)).fetchone()
        return self._node_dict(row) if row else None

    def children_of(self, nid: int) -> list[dict]:
        rows = self.db.execute(
            "SELECT * FROM nodes WHERE parent_id=? ORDER BY id", (nid,)
        ).fetchall()
        return [self._node_dict(r) for r in rows]

    def inspirations_of(self, nid: int) -> list[dict]:
        rows = self.db.execute(
            "SELECT n.* FROM edges e JOIN nodes n ON n.id=e.src "
            "WHERE e.dst=? AND e.type='inspiration'",
            (nid,),
        ).fetchall()
        return [self._node_dict(r) for r in rows]

    def archive(self) -> list[dict]:
        """archive 集合：ΔU>0 的 child + root（有资格当 parent 的节点）。"""
        rows = self.db.execute(
            "SELECT * FROM nodes WHERE status='archive' ORDER BY id"
        ).fetchall()
        return [self._node_dict(r) for r in rows]

    def bump_times_selected(self, nid: int) -> None:
        self.db.execute(
            "UPDATE nodes SET times_selected=times_selected+1 WHERE id=?", (nid,)
        )
        self.db.commit()

    def mean_child_delta(self, nid: int) -> float:
        """P̂_v = 该节点全部 child 的 ΔU 均值；无 child 时为 0。"""
        row = self.db.execute(
            "SELECT AVG(delta_u) AS m, COUNT(*) AS c FROM nodes WHERE parent_id=?", (nid,)
        ).fetchone()
        return float(row["m"]) if row and row["c"] else 0.0

    def fts_search(self, query: str, limit: int = 12) -> list[dict]:
        """FTS5 候选召回；查询为空或语法失败时返回 []（调用方兜底全表扫描）。"""
        toks = tokenize(query)[:16]
        if not toks:
            return []
        match = " OR ".join(f'"{t}"' for t in toks)
        try:
            rows = self.db.execute(
                "SELECT n.* FROM node_fts f JOIN nodes n ON n.id=f.rowid "
                "WHERE node_fts MATCH ? ORDER BY rank LIMIT ?",
                (match, limit),
            ).fetchall()
        except sqlite3.OperationalError:
            return []
        return [self._node_dict(r) for r in rows]

    def all_nodes(self, limit: int = 200) -> list[dict]:
        rows = self.db.execute("SELECT * FROM nodes ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
        return [self._node_dict(r) for r in rows]

    # ------------------------------------------------------------------
    # meta snapshots（slow loop provenance）
    # ------------------------------------------------------------------

    def add_meta_snapshot(self, iteration: int, tag: str, p_hat: float, state: dict[str, str]) -> int:
        cur = self.db.execute(
            "INSERT INTO meta_snapshots(iteration, tag, p_hat, state_json, created_at) "
            "VALUES (?,?,?,?,?)",
            (iteration, tag, float(p_hat), json.dumps(state, ensure_ascii=False), _now()),
        )
        self.db.commit()
        return int(cur.lastrowid)

    def meta_snapshots(self) -> list[dict]:
        rows = self.db.execute("SELECT * FROM meta_snapshots ORDER BY id").fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["state"] = json.loads(d.pop("state_json"))
            out.append(d)
        return out

    # ------------------------------------------------------------------
    # EvoSOP：sops / sop_reviews / checkpoints
    # ------------------------------------------------------------------

    def add_sop(
        self,
        *,
        name: str,
        code: str,
        docstring: str,
        schema: dict,
        tools: list[str],
        epoch_created: int,
        merged_from: str = "",
        source_trace: str = "",
    ) -> int | None:
        """注册 SOP；同名去重返回 None。"""
        try:
            cur = self.db.execute(
                "INSERT INTO sops(name, code, docstring, schema_json, tools_json, status, "
                "epoch_created, merged_from, source_trace, created_at) "
                "VALUES (?,?,?,?,?,'active',?,?,?,?)",
                (
                    name,
                    code,
                    docstring,
                    json.dumps(schema, ensure_ascii=False),
                    json.dumps(tools, ensure_ascii=False),
                    epoch_created,
                    merged_from,
                    source_trace,
                    _now(),
                ),
            )
            self.db.commit()
            return int(cur.lastrowid)
        except sqlite3.IntegrityError:
            return None

    def get_sops(self, status: str | None = "active") -> list[dict]:
        if status is None:
            rows = self.db.execute("SELECT * FROM sops ORDER BY id").fetchall()
        else:
            rows = self.db.execute(
                "SELECT * FROM sops WHERE status=? ORDER BY id", (status,)
            ).fetchall()
        return [self._sop_dict(r) for r in rows]

    def prune_sop(self, sop_id: int, epoch: int) -> None:
        self.db.execute(
            "UPDATE sops SET status='pruned', epoch_pruned=? WHERE id=?", (epoch, sop_id)
        )
        self.db.commit()

    def add_sop_review(
        self, sop_id: int, epoch: int, calls: int, success: int, labels: dict[str, int], reason: str
    ) -> None:
        self.db.execute(
            "INSERT INTO sop_reviews(sop_id, epoch, calls, success, labels_json, reason, created_at) "
            "VALUES (?,?,?,?,?,?,?)",
            (sop_id, epoch, calls, success, json.dumps(labels, ensure_ascii=False), reason, _now()),
        )
        self.db.commit()

    def sop_reviews(self, sop_id: int) -> list[dict]:
        rows = self.db.execute(
            "SELECT * FROM sop_reviews WHERE sop_id=? ORDER BY epoch", (sop_id,)
        ).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["labels"] = json.loads(d.pop("labels_json"))
            out.append(d)
        return out

    def sop_stats(self, sop_id: int) -> dict:
        """跨 epoch 聚合：总调用、总成功、缺陷率、最近零调用 epoch 数。"""
        reviews = self.sop_reviews(sop_id)
        calls = sum(r["calls"] for r in reviews)
        success = sum(r["success"] for r in reviews)
        defects = sum(r["labels"].get("implementation_defect", 0) for r in reviews)
        return {
            "calls": calls,
            "success": success,
            "defects": defects,
            "defect_rate": (defects / calls) if calls else 0.0,
            "reviews": reviews,
        }

    def consecutive_zero_call_epochs(self, sop_id: int, current_epoch: int, since_epoch: int = 0) -> int:
        """截至 current_epoch 连续零调用的 epoch 数（无评审记录视为零调用）。

        只从 SOP 创建 epoch（since_epoch）起算，避免新生 SOP 被误剪。
        """
        called = {r["epoch"] for r in self.sop_reviews(sop_id) if r["calls"] > 0}
        n = 0
        e = current_epoch
        while e >= since_epoch and e not in called:
            n += 1
            e -= 1
        return n

    def save_checkpoint(self, epoch: int, success_rate: float, snapshot: list[dict]) -> int:
        cur = self.db.execute(
            "INSERT INTO checkpoints(epoch, success_rate, snapshot_json, created_at) "
            "VALUES (?,?,?,?)",
            (epoch, float(success_rate), json.dumps(snapshot, ensure_ascii=False), _now()),
        )
        self.db.commit()
        return int(cur.lastrowid)

    def best_checkpoint(self) -> dict | None:
        """训练成功率最高的 checkpoint（同分取较早 epoch，对抗随机性误剪）。"""
        row = self.db.execute(
            "SELECT * FROM checkpoints ORDER BY success_rate DESC, epoch ASC LIMIT 1"
        ).fetchone()
        if not row:
            return None
        d = dict(row)
        d["snapshot"] = json.loads(d.pop("snapshot_json"))
        return d

    def checkpoints(self) -> list[dict]:
        rows = self.db.execute("SELECT * FROM checkpoints ORDER BY epoch").fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["snapshot"] = json.loads(d.pop("snapshot_json"))
            out.append(d)
        return out

    # ------------------------------------------------------------------
    # 内部
    # ------------------------------------------------------------------

    @staticmethod
    def _node_dict(row: sqlite3.Row) -> dict:
        d = dict(row)
        d["meta_state"] = json.loads(d.pop("meta_state_json") or "{}")
        return d

    @staticmethod
    def _sop_dict(row: sqlite3.Row) -> dict:
        d = dict(row)
        d["schema"] = json.loads(d.pop("schema_json") or "{}")
        d["tools"] = json.loads(d.pop("tools_json") or "[]")
        return d
