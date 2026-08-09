#!/usr/bin/env python3
"""把 campaign 每日任务的 transcript 合成为 pi-native session JSONL（夜间进化原料）。

与 synthesize_alfworld_sessions.py 同一纪律（M18）：
  - 每任务一个 .jsonl（任务级轨迹，禁喂 per-request session）
  - transcript 缺失/为空即硬失败，不伪造内容
  - --prefix 参数化防跨日/跨臂碰撞

输入：campaign.py 落盘的 transcripts（results/<run_id>/transcripts/dayN/<arm>-<task_id>.json，
含 prompt + transcript + score）。
"""

import argparse
import json
from pathlib import Path

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


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input-dir", required=True, help="transcripts/dayN 目录")
    ap.add_argument("--output-dir", required=True)
    ap.add_argument("--prefix", default="campaign", help="session id 前缀（防跨日/跨臂碰撞）")
    args = ap.parse_args()

    in_dir = Path(args.input_dir)
    files = sorted(in_dir.glob("*.json"))
    if not files:
        raise SystemExit(f"no transcript files in {in_dir}")
    out_dir = Path(args.output_dir)
    for path in files:
        record = json.loads(path.read_text())
        synthesize_task(record, out_dir / f"{path.stem}.jsonl", args.prefix)
    print(f"synthesized {len(files)} sessions into {out_dir}")


if __name__ == "__main__":
    main()
