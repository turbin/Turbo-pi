#!/usr/bin/env python3
"""M10（2026-08-09 对抗审查）：经验库快照——跑批前冻结 active 经验集。

用法：
    ./.venv/bin/python snapshot_store.py <live.db> <snapshot.db>   # legacy：指定路径
    ./.venv/bin/python snapshot_store.py <live.db> --snapshots-dir <dir> [--retain N]
        # 每日快照模式：生成 snapshot-<ts>.db 并保留最新 N 份（N 预注册默认 7，台账 4）

用 SQLite online backup API 复制经验库（WAL 安全）。跑批 runbook：
    1. 跑批前执行本脚本生成快照
    2. 以 AGENT_SERVER_STORE_SNAPSHOT=<snapshot.db> 启动（或重启）评估实例
    3. 跑批全程实验臂检索只读快照——手动进化 / dormant 提升 / TTL 清理
       不再中途改变被测对象的处理行为；写入仍走 live 库（学习回路不受影响）

回滚 runbook（台账 4）——"回滚到昨日 active 集"：
    a) 冻结回滚（推荐，不动 live 库）：以昨日快照为 AGENT_SERVER_STORE_SNAPSHOT
       重启评估实例——检索回到昨日 active 集，写入仍进 live 库；
    b) 整库回滚（live 库也恢复）：停止实例 → 复制昨日快照覆盖 live 路径
       （cp snapshot-<昨日>.db <live.db>）→ 重启实例。
    c) 验证：启动后 /api/stats 或一次注入请求核对检索集与昨日一致。

F2（T3）快照再生：experiences 表新增 confidence/rescore_excluded_batches 列
后，**快照必须重新生成**（本脚本整库复制，新列随 live 库自动带入）；
旧 schema 快照仍可只读打开（读路径 COALESCE 默认 confidence=0.5 / 排除计数=0），
但检索排序不含真实置信度——归因奖惩生效期跑批前请重新生成快照。
"""

import argparse
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

# 每日快照留存份数（台账 4 预注册）。
DEFAULT_RETAIN = 7


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


def create_snapshots_dir_snapshot(
    live_db: Path, snapshots_dir: Path, retain: int = DEFAULT_RETAIN, ts: str | None = None
) -> Path:
    """每日快照模式：生成 snapshot-<ts>.db 并剪枝到最新 retain 份，返回新快照路径。"""
    snapshots_dir.mkdir(parents=True, exist_ok=True)
    ts = ts or datetime.now().strftime("%Y%m%d-%H%M%S")
    out = snapshots_dir / f"snapshot-{ts}.db"
    snapshot(live_db, out)
    prune_snapshots(snapshots_dir, retain=retain)
    return out


def prune_snapshots(snapshots_dir: Path, retain: int = DEFAULT_RETAIN) -> int:
    """保留最新 retain 份 snapshot-*.db，删除更旧的；返回删除数（非快照文件不动）。"""
    snaps = sorted(snapshots_dir.glob("snapshot-*.db"))
    removed = 0
    for old in snaps[:-retain] if retain > 0 else snaps:
        old.unlink()
        removed += 1
    return removed


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="snapshot_store", description="经验库快照：冻结 active 集 + 留存剪枝")
    ap.add_argument("live_db", help="live 经验库路径")
    ap.add_argument("snapshot_db", nargs="?", default=None, help="legacy 模式：目标快照路径")
    ap.add_argument("--snapshots-dir", default=None, help="每日快照模式：快照目录（自动命名 + 留存剪枝）")
    ap.add_argument("--retain", type=int, default=DEFAULT_RETAIN, help=f"每日快照模式保留份数（默认 {DEFAULT_RETAIN}）")
    args = ap.parse_args(argv)

    live = Path(args.live_db)
    if args.snapshots_dir:
        create_snapshots_dir_snapshot(live, Path(args.snapshots_dir), retain=args.retain)
    elif args.snapshot_db:
        snapshot(live, Path(args.snapshot_db))
    else:
        print(__doc__)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
