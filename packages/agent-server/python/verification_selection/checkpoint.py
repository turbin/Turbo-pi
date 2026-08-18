"""打分阶段断点（最小断点，2026-08-14 立项，统一修改方案 §5）。

verification_selection 打分是离线进化管线最贵阶段（issue-002 r3 的 1608
次打分、13-27h 估算来源）；任一阶段失败全量重跑。本模块提供：

- ``prompt_fingerprint``：打分 prompt 指纹——PAIRWISE_TEMPLATE /
  REFERENCE_TRAJECTORY / 标准分解 / G / K 任一变化即全部缓存失效（防脏复用）；
- ``input_hash``：打分输入哈希 = prompt 指纹 + 轨迹内容（任务文本 +
  组内全部轨迹，按序）——内容变化即该组重打；
- ``ScoreJournal``：run 目录下的 JSONL 打分日志，逐条 append + flush +
  fsync——中途崩溃不丢已完成部分；load() 忽略损坏（半截）行，该 key
  视为未完成、resume 时重打。

--resume 语义：load() 按 key（主管线 = 任务组 task_id；rescore = 候选
content_hash）取哈希匹配的条目，匹配即跳过（幂等），不匹配即重打并追加。
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path


def prompt_fingerprint(pairwise_template: str, reference_trajectory: str, criteria: list[str],
                       g: int, k: int) -> str:
    """打分 prompt 指纹：模板/参照轨迹/标准分解/G/K 任一变化即缓存失效。"""
    h = hashlib.sha256()
    h.update(pairwise_template.encode("utf-8"))
    h.update(b"\x00")
    h.update(reference_trajectory.encode("utf-8"))
    h.update(b"\x00")
    for desc in criteria:
        h.update(desc.encode("utf-8"))
        h.update(b"\x00")
    h.update(f"G={g}\x00K={k}\x00".encode("utf-8"))
    return h.hexdigest()[:16]


def input_hash(prompt_fingerprint_: str, *parts: str) -> str:
    """打分输入哈希：prompt 指纹 + 全部输入片段（任务文本/轨迹文本，按序）。"""
    h = hashlib.sha256()
    h.update(prompt_fingerprint_.encode("utf-8"))
    h.update(b"\x00")
    for part in parts:
        h.update(part.encode("utf-8"))
        h.update(b"\x00")
    return h.hexdigest()


class ScoreJournal:
    """增量打分日志：run 目录下一个 JSONL 文件，逐条 append + flush + fsync。

    load() 按 key 取最后一条（last write wins）；跳过损坏行——崩溃可能留下
    半截行，该 key 视为未完成、resume 时重打。
    """

    def __init__(self, run_dir: str | None, file_name: str) -> None:
        self.path: Path | None = Path(run_dir) / file_name if run_dir else None

    def load(self) -> dict[str, dict]:
        if self.path is None or not self.path.exists():
            return {}
        cache: dict[str, dict] = {}
        for line in self.path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue  # 半截行：忽略，该 key 会被重打
            key = entry.get("key")
            if isinstance(key, str) and key:
                cache[key] = entry
        return cache

    def append(self, key: str, entry: dict) -> None:
        if self.path is None:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        record = {"key": key, **entry}
        with self.path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
            f.flush()
            os.fsync(f.fileno())
