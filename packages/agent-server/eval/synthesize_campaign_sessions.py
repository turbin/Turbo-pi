#!/usr/bin/env python3
"""把 campaign 每日任务的 transcript 合成为 pi-native session JSONL（夜间进化原料）。

与 synthesize_alfworld_sessions.py 同一纪律（M18）：
  - 每任务一个 .jsonl（任务级轨迹，禁喂 per-request session）
  - transcript 缺失/为空即硬失败，不伪造内容
  - --prefix 参数化防跨日/跨臂碰撞

输入：campaign.py 落盘的 transcripts（results/<run_id>/transcripts/dayN/<arm>-<task_id>.json，
含 prompt + transcript + score）。

写入隔离（preview.html §10 与 §7.2/Q8）：
  - 默认只合成 experiment/x2 两臂（--eligible-arms 可覆盖）——X1/X3/X4 只读不写入；
  - held-out 任务的 transcripts 一律排除（memory 中不得有其 exact trajectory）。
"""

import argparse
import json
import uuid
from datetime import datetime, timezone
from pathlib import Path

from campaign_plan import held_out_tasks, load_tasks

SYSTEM_PROMPT = (
    "You are an office-automation agent. Complete the task using the bash tool. "
    "Work entirely inside the workspace."
)


def synthesize_task(record: dict, out_path: Path, prefix: str) -> None:
    task_id = record.get("task_id")
    prompt = record.get("prompt")
    transcript = record.get("transcript")
    if not task_id or not prompt or not transcript:
        raise ValueError(f"transcript 记录不完整（task_id/prompt/transcript 缺失）: {task_id!r}")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w") as f:
        f.write(
            json.dumps(
                {
                    "type": "session",
                    "version": 3,
                    "id": f"{prefix}-{record.get('arm', 'unknown')}-{task_id}",
                    "metadata": {
                        "task_id": task_id,
                        "arm": record.get("arm"),
                        "day": record.get("day"),
                        "score": record.get("score"),
                        # F3 (T4): 情景域透传——office campaign 语料（蒸馏按轨迹
                        # 来源自动打标；collectTrajectories 透传到蒸馏管线）。
                        "domain": "office",
                    },
                },
                ensure_ascii=False,
            )
            + "\n"
        )
        f.write(json.dumps({"type": "message", "message": {"role": "system", "content": SYSTEM_PROMPT}}, ensure_ascii=False) + "\n")
        f.write(json.dumps({"type": "message", "message": {"role": "user", "content": prompt}}, ensure_ascii=False) + "\n")
        for turn in transcript:
            # transcript 为 OpenClaw 事件形态：{type:"message", message:{role, content:[parts]}}。
            msg = turn.get("message", {}) if turn.get("type") == "message" else turn
            role = msg.get("role", "")
            content = msg.get("content")
            texts: list[str] = []
            if isinstance(content, str):
                texts = [content]
            elif isinstance(content, list):
                for part in content:
                    if isinstance(part, str):
                        texts.append(part)
                    elif isinstance(part, dict):
                        if part.get("type") == "text" and part.get("text"):
                            texts.append(str(part["text"]))
                        elif part.get("type") == "toolCall":
                            args = part.get("arguments") or {}
                            texts.append(f"{part.get('name', 'tool')}: {args.get('command', json.dumps(args, ensure_ascii=False))}")
            out_role = "toolResult" if role == "toolResult" else "assistant"
            for text in texts:
                if not text.strip():
                    continue
                f.write(
                    json.dumps({"type": "message", "message": {"role": out_role, "content": text}}, ensure_ascii=False)
                    + "\n"
                )
        # issue-018（T6 契约）：session 末尾追加与 session-writer v3 线上一致的
        # response_completed 闭合条目（type=custom + customType + id/parentId/
        # timestamp）——ETL 完整性判据（offline/etl.ts）有头无闭合 = 半截整体
        # 隔离（D1 实战 etlIsolated=32/32, etlInserted=0，dormant 断流）。
        # 本文件条目无 id 链，parentId 与线上首条目一致为 null。
        f.write(
            json.dumps(
                {
                    "type": "custom",
                    "customType": "response_completed",
                    "id": str(uuid.uuid4()),
                    "parentId": None,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                },
                ensure_ascii=False,
            )
            + "\n"
        )


def filter_inputs(files: list[Path], eligible_arms: set[str], held_out: set[str]) -> tuple[list[Path], int, int]:
    """写入隔离过滤（preview.html §10/§7.2）：返回可合成文件与排除计数。

    文件名 <arm>-<task_id>.json：臂名不在 eligible_arms 的跳过（默认
    experiment,x2——X1/X3/X4 只读不写入）；task_id 在 held-out 集的跳过
    （held-out 不得进入 evolution）。"""
    kept: list[Path] = []
    skipped_arm = 0
    skipped_held = 0
    for path in files:
        stem = path.stem
        arm = stem.split("-", 1)[0]
        task_id = stem.split("-", 1)[1] if "-" in stem else stem
        if arm not in eligible_arms:
            skipped_arm += 1
            continue
        if task_id in held_out:
            skipped_held += 1
            continue
        kept.append(path)
    return kept, skipped_arm, skipped_held


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input-dir", required=True, help="transcripts/dayN 目录")
    ap.add_argument("--output-dir", required=True)
    ap.add_argument("--prefix", default="campaign", help="session id 前缀（防跨日/跨臂碰撞）")
    ap.add_argument(
        "--eligible-arms",
        default="experiment,x2",
        help="可进入 runDailyEvolution 的臂白名单（逗号分隔）；缺省 experiment,x2——"
        "preview.html §10：X1/X3/X4 默认只读不写入。",
    )
    args = ap.parse_args()

    in_dir = Path(args.input_dir)
    files = sorted(in_dir.glob("*.json"))
    if not files:
        raise SystemExit(f"no transcript files in {in_dir}")
    out_dir = Path(args.output_dir)
    eligible = set(args.eligible_arms.split(","))
    # preview.html §7.2/Q8：held-out 任务的 transcript 一律排除（不进入进化）。
    held = set(held_out_tasks(load_tasks()))
    kept, skipped_arm, skipped_held = filter_inputs(files, eligible, held)
    if not kept:
        raise SystemExit(
            f"no eligible transcript files in {in_dir} "
            f"(excluded {skipped_arm} arm-ineligible, {skipped_held} held-out)"
        )
    for path in kept:
        record = json.loads(path.read_text())
        synthesize_task(record, out_dir / f"{path.stem}.jsonl", args.prefix)
    print(f"synthesized {len(kept)} sessions into {out_dir}; "
          f"excluded {skipped_arm} arm-ineligible, {skipped_held} held-out")


if __name__ == "__main__":
    main()
