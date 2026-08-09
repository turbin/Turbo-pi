#!/usr/bin/env python3
"""M10（2026-08-09 对抗审查）：经验库快照——跑批前冻结 active 经验集。

用法：
    ./.venv/bin/python snapshot_store.py <live.db> <snapshot.db>

用 SQLite online backup API 复制经验库（WAL 安全）。跑批 runbook：
    1. 跑批前执行本脚本生成快照
    2. 以 AGENT_SERVER_STORE_SNAPSHOT=<snapshot.db> 启动（或重启）评估实例
    3. 跑批全程实验臂检索只读快照——手动进化 / dormant 提升 / TTL 清理
       不再中途改变被测对象的处理行为；写入仍走 live 库（学习回路不受影响）
"""

import sqlite3
import sys
from pathlib import Path


def snapshot(live_db: Path, snapshot_db: Path) -> None:
    if not live_db.exists():
        sys.exit(f"FATAL: live store not found: {live_db}")
    src = sqlite3.connect(str(live_db))
    dst = sqlite3.connect(str(snapshot_db))
    try:
        src.backup(dst)
        dst.commit()
    finally:
        dst.close()
        src.close()
    print(f"snapshot: {live_db} -> {snapshot_db}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(2)
    snapshot(Path(sys.argv[1]), Path(sys.argv[2]))
