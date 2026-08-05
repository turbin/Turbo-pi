#!/usr/bin/env python3
"""ALFWorld ReAct agent with dual-arm endpoint switching (E2').

Faithful port of the ReAct paper's alfworld.ipynb loop to the chat.completions
API. Two-shot prompt per task type (react_{type}_1 + react_{type}_0), 49-step
cap, stop=["\n"], temperature=0. One JSONL record per game.

Usage:
    ALFWORLD_DATA=$PWD/alfworld_data ./.venv/bin/python alfworld_agent.py \
        --base-url https://api.deepseek.com/v1 --api-key $DEEPSEEK_API_KEY \
        --output results/alfworld-control.jsonl [--games 5] [--start 0]
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

import yaml
from openai import OpenAI

from preflight import ensure_for_base_url

EVAL_DIR = Path(__file__).resolve().parent
CONFIG_PATH = EVAL_DIR / "alfworld" / "base_config.yaml"
PROMPTS_PATH = EVAL_DIR / "alfworld" / "alfworld_3prompts.json"

PREFIXES = {
    "pick_and_place": "put",
    "pick_clean_then_place": "clean",
    "pick_heat_then_place": "heat",
    "pick_cool_then_place": "cool",
    "look_at_obj": "examine",
    "pick_two_obj": "puttwo",
}

MAX_STEPS = 49

def process_ob(ob: str) -> str:
    if ob.startswith("You arrive at loc "):
        ob = ob[ob.find(". ") + 2 :]
    return ob


# Command extraction: reasoning-distilled models (e.g. Qwen3.5-27B-Distilled)
# narrate before acting ("Let me think...") instead of emitting the ReAct
# command on the first line. Generate without stop=["\n"] and extract the
# command: last line starting with a known verb, or a backticked command.
# For single-command outputs (DeepSeek) this is a no-op. (2026-08-04 fix)
COMMAND_VERBS = (
    "go to", "take", "put", "open", "close", "clean", "heat", "cool",
    "use", "look", "examine", "inventory", "think:",
)


def extract_command(text: str) -> str:
    import re

    # Find verb-initial command phrases anywhere in the text (line-anchored or
    # after prose/backticks), take the last one, and cut at the verb start.
    verb_re = re.compile(
        r"(go to |take |put |open |close |clean |heat |cool |use |examine |inventory\b|look\b|think:)"
    )
    matches = []
    for m in verb_re.finditer(text):
        phrase = text[m.start():].split("\n")[0]
        phrase = phrase.strip().strip("`").rstrip(".").strip()
        if phrase:
            matches.append(phrase)
    if matches:
        return matches[-1].lstrip(">").strip()
    return text.strip().split("\n")[-1].strip().lstrip(">").strip()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", required=True)
    ap.add_argument("--api-key", required=True)
    ap.add_argument("--model", default="deepseek-v4-flash")
    ap.add_argument("--output", required=True)
    ap.add_argument("--games", type=int, default=134)
    ap.add_argument("--start", type=int, default=0)
    ap.add_argument(
        "--injection",
        choices=["on", "off"],
        default=None,
        help="experience injection override; only honored by agent-server (:8789). "
        "Default: server-side setting (env AGENT_SERVER_INJECTION, on). "
        "Control arms should run via :8789 with --injection off so their "
        "traces still feed the learning loop.",
    )
    args = ap.parse_args()

    # Dependency gate: probe (and auto-start what we own) before burning hours.
    ensure_for_base_url(args.base_url)
    if args.injection and ":8789" not in args.base_url:
        print("warning: --injection is ignored by non-agent-server endpoints", file=sys.stderr)

    client = OpenAI(base_url=args.base_url, api_key=args.api_key, timeout=120.0)

    def llm(prompt: str) -> tuple[str, dict]:
        for attempt in range(6):
            try:
                resp = client.chat.completions.create(
                    model=args.model,
                    messages=[
                        {
                            "role": "system",
                            "content": (
                                "You are playing a text-based household task game. "
                                "Respond with exactly one short command per turn, e.g. "
                                "'go to cabinet 1', 'take mug 1 from countertop 1', "
                                "'open drawer 1', or 'think: <reasoning>'. "
                                "You may think briefly, but your final line MUST be "
                                "the command itself."
                            ),
                        },
                        {"role": "user", "content": prompt},
                    ],
                    temperature=0,
                    max_tokens=200,
                    extra_body={
                        "thinking": {"type": "disabled"},
                        **({"injection": args.injection == "on"} if args.injection else {}),
                    },
                )
                usage = resp.usage.model_dump() if resp.usage else {}
                raw = resp.choices[0].message.content.strip()
                action = extract_command(raw)
                return action, usage
            except Exception as e:  # noqa: BLE001 - retry any transient API error
                wait = min(2**attempt * 4, 60)
                print(f"  llm error ({type(e).__name__}: {e}); retry in {wait}s", file=sys.stderr)
                time.sleep(wait)
        raise RuntimeError("llm failed after 6 attempts")

    with open(CONFIG_PATH) as f:
        config = yaml.safe_load(f)
    prompts = json.load(open(PROMPTS_PATH))

    import alfworld.agents.environment as environment

    env = environment.get_environment(config["env"]["type"])(config, train_eval="eval_out_of_distribution")
    env.game_files = sorted(env.game_files)  # deterministic order for A/B alignment
    print(f"game files: {len(env.game_files)}")
    env = env.init_env(batch_size=1)

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out = open(out_path, "a")

    for game_idx in range(args.start, min(args.start + args.games, 134)):
        ob, info = env.reset()
        ob = "\n".join(ob[0].split("\n\n")[1:])
        gamefile = info["extra.gamefile"][0]
        name = "/".join(gamefile.split("/")[-3:-1])

        task_type = None
        for k, v in PREFIXES.items():
            if name.startswith(k):
                task_type, pfx = k, v
                break
        if task_type is None:
            print(f"skip (unknown type): {name}", file=sys.stderr)
            continue

        prompt_head = (
            "Interact with a household to solve a task. Here are two examples.\n"
            + prompts[f"react_{pfx}_1"]
            + prompts[f"react_{pfx}_0"]
            + "\nHere is the task.\n"
        )

        init_prompt = prompt_head + ob + "\n>"
        history = ""
        won = False
        tokens_in = tokens_out = 0
        traj = []
        t0 = time.time()

        for step in range(1, MAX_STEPS + 1):
            action, usage = llm(init_prompt + history)
            tokens_in += usage.get("prompt_tokens", 0)
            tokens_out += usage.get("completion_tokens", 0)
            observation, _, done, step_info = env.step([action])
            observation, won, done = process_ob(observation[0]), bool(step_info["won"][0]), bool(done[0])
            if action.startswith("think:"):
                observation = "OK."
            traj.append({"step": step, "action": action, "obs": observation})
            history += f" {action}\n{observation}\n>"
            if done:
                break

        rec = {
            "game_idx": game_idx,
            "gamefile": gamefile,
            "task_type": task_type,
            "won": won,
            "steps": len(traj),
            "tokens_in": tokens_in,
            "tokens_out": tokens_out,
            "elapsed_s": round(time.time() - t0, 1),
            "trajectory": traj,
        }
        out.write(json.dumps(rec) + "\n")
        out.flush()
        print(f"[{game_idx + 1}/134] {task_type} won={won} steps={len(traj)} in={tokens_in} out={tokens_out}")

    out.close()


if __name__ == "__main__":
    main()
