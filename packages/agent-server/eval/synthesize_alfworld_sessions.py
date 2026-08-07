#!/usr/bin/env python3
"""把 alfworld_agent.py 的 JSONL 局结果合成为 pi-native session JSONL。

agent-server 的离线进化管线 (runDailyEvolution) 消费 pi-native session 文件；
它从 per-request session 重构轨迹 (collectTrajectories)。alfworld_agent.py 一局
对应一个完整任务轨迹，因此按局合成一个 session 文件，避免 6372 个 per-request
文件喂爆管线。

输出格式见 src/offline/pipeline.ts 的 parseSessionFile：
  - 每局一个 .jsonl 文件
  - 包含 session header + message 行
  - 首条 user 消息被当作 task 上下文，assistant/toolResult 消息拼成 text
"""

import argparse
import json
from pathlib import Path


SYSTEM_PROMPT = (
    "You are playing a text-based household task game. "
    "Respond with exactly one short command per turn, e.g. "
    "'go to cabinet 1', 'take mug 1 from countertop 1', "
    "'open drawer 1', or 'think: <reasoning>'. "
    "You may think briefly, but your final line MUST be the command itself."
)


def synthesize_game(game: dict, out_path: Path) -> None:
    """Write one pi-native session JSONL for a single ALFWorld game."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w") as f:
        f.write(
            json.dumps(
                {
                    "type": "session",
                    "version": 3,
                    "id": f"alfworld-27b-cold-{game['game_idx']}",
                    "metadata": {
                        "task_type": game["task_type"],
                        "won": game["won"],
                        "gamefile": game["gamefile"],
                    },
                },
                ensure_ascii=False,
            )
            + "\n"
        )
        f.write(json.dumps({"type": "message", "message": {"role": "system", "content": SYSTEM_PROMPT}}, ensure_ascii=False) + "\n")
        # First user message carries the full ReAct prompt head + initial observation.
        f.write(json.dumps({"type": "message", "message": {"role": "user", "content": game["init_prompt"]}}, ensure_ascii=False) + "\n")
        for step in game["trajectory"]:
            f.write(
                json.dumps(
                    {"type": "message", "message": {"role": "assistant", "content": step["action"]}},
                    ensure_ascii=False,
                )
                + "\n"
            )
            f.write(
                json.dumps(
                    {"type": "message", "message": {"role": "toolResult", "content": step["obs"]}},
                    ensure_ascii=False,
                )
                + "\n"
            )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True, help="alfworld_agent JSONL")
    ap.add_argument("--output-dir", required=True, help="directory for synthesized .jsonl files")
    args = ap.parse_args()

    out_dir = Path(args.output_dir)
    games = 0
    with open(args.input) as f:
        for line in f:
            game = json.loads(line)
            # init_prompt was not originally emitted by alfworld_agent.py; reconstruct it.
            # The first step's prompt is prompt_head + ob + "\n>".
            if "init_prompt" not in game:
                traj = game.get("trajectory", [])
                # We cannot reconstruct init_prompt from the record alone, so derive the
                # task type from gamefile and use the trajectory as the narrative text.
                game["init_prompt"] = f"[Task: {game['task_type']}]\n" + "\n".join(
                    f"> {s['action']}\n{s['obs']}" for s in traj
                )
            synthesize_game(game, out_dir / f"game-{game['game_idx']:03d}.jsonl")
            games += 1
    print(f"synthesized {games} sessions into {out_dir}")


if __name__ == "__main__":
    main()
