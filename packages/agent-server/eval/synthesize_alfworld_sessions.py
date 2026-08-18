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


def synthesize_game(game: dict, out_path: Path, prefix: str = "alfworld") -> None:
    """Write one pi-native session JSONL for a single ALFWorld game.

    M18（2026-08-09）：init_prompt 缺失即硬失败——伪造的 task-context（含
    完整轨迹）会自泄漏进进化管线；session id 前缀参数化避免跨臂碰撞。
    """
    if "init_prompt" not in game:
        raise ValueError(
            f"game {game.get('game_idx')} has no init_prompt — regenerate with the current "
            "alfworld_agent.py (M18: task context must be real, never synthesized)"
        )
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w") as f:
        f.write(
            json.dumps(
                {
                    "type": "session",
                    "version": 3,
                    "id": f"{prefix}-{game['game_idx']}",
                    "metadata": {
                        "task_type": game["task_type"],
                        "won": game["won"],
                        "gamefile": game["gamefile"],
                        "pool_size": game.get("pool_size"),
                        "pool_hash": game.get("pool_hash"),
                        # F3 (T4): 情景域透传（alfworld 域，检索跨域排除）。
                        "domain": "alfworld",
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
    ap.add_argument("--prefix", default="alfworld", help="session id 前缀（跨臂/跨轮防碰撞，M18）")
    args = ap.parse_args()

    out_dir = Path(args.output_dir)
    games = 0
    with open(args.input) as f:
        for line in f:
            game = json.loads(line)
            synthesize_game(game, out_dir / f"game-{game['game_idx']:03d}.jsonl", prefix=args.prefix)
            games += 1
    print(f"synthesized {games} sessions into {out_dir}")


if __name__ == "__main__":
    main()
