#!/usr/bin/env python3
"""D3 discrimination experiment: chat-tuned (gemma-4-12B) vs agent-tuned (Qwen3.5-9B)
on the EMPTY prompt set from the empty_output root-cause analysis (§4).

For each prompt case, query both models via omlx (127.0.0.1:8000) with the exact
agent runtime params (stop=["\n"], temperature=0, max_tokens=100) and record whether
content is EMPTY. The mechanism claim: gemma (chat-tuned) empties; agent-tuned model
should not.

Usage: ./.venv/bin/python d3_discriminate.py --api-key <omlx key> [--json-out path]
"""

import argparse
import json
import urllib.request
from pathlib import Path

EVAL_DIR = Path(__file__).resolve().parent
SYS = (
    "You are playing a text-based household task game. "
    "Respond with exactly one short command per turn, e.g. 'go to cabinet 1', "
    "'take mug 1 from countertop 1', 'open drawer 1', or 'think: <reasoning>'. "
    "Output the command only, no other text."
)
PREFIX = {
    "pick_and_place": "put",
    "pick_clean_then_place": "clean",
    "pick_heat_then_place": "heat",
    "pick_cool_then_place": "cool",
    "look_at_obj": "examine",
    "pick_two_obj": "puttwo",
}
MODELS = ["gemma-4-12B-it-4bit", "Qwen3.5-9B-4bit"]


def build_cases():
    prompts = json.load(open(EVAL_DIR / "alfworld" / "alfworld_3prompts.json"))
    recs = [json.loads(l) for l in open(EVAL_DIR / "results" / "alfworld-20260730" / "student-full.jsonl")]
    cases = []
    for gi in (8, 3, 12, 20):  # heat(曾EMPTY) / clean / cool / clean
        rec = recs[gi]
        pfx = PREFIX[rec["task_type"]]
        head = (
            "Interact with a household to solve a task. Here are two examples.\n"
            + prompts[f"react_{pfx}_1"]
            + prompts[f"react_{pfx}_0"]
            + "\nHere is the task.\n"
        )
        hist = ""
        for t in rec["trajectory"][:20]:
            hist += f" {t['action']}\n{t['obs']}\n>"
        cases.append((f"game{gi}-{rec['task_type']}-head+hist20", head + hist))
    # head-only 变体（gemma 曾 EMPTY）
    rec = recs[8]
    head = (
        "Interact with a household to solve a task. Here are two examples.\n"
        + prompts["react_heat_1"]
        + prompts["react_heat_0"]
        + "\nHere is the task.\n"
    )
    cases.append(("game8-heat-head-only", head))
    return cases


def query(base_url: str, key: str, model: str, prompt: str) -> dict:
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": SYS},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0,
        "max_tokens": 100,
        "stop": ["\n"],
    }
    req = urllib.request.Request(
        f"{base_url}/chat/completions",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
    )
    with urllib.request.urlopen(req, timeout=300) as r:
        d = json.load(r)
    msg = d["choices"][0]["message"]
    usage = d.get("usage", {})
    return {
        "content": msg.get("content"),
        "finish": d["choices"][0].get("finish_reason"),
        "completion_tokens": usage.get("completion_tokens"),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api-key", required=True)
    ap.add_argument("--base-url", default="http://127.0.0.1:8000/v1")
    ap.add_argument("--json-out", default="")
    args = ap.parse_args()

    from preflight import ensure_for_base_url

    ensure_for_base_url(args.base_url)

    cases = build_cases()
    results = []
    print(f"{'case':38s} | {'gemma-4-12B':28s} | {'Qwen3.5-9B':28s}")
    print("-" * 105)
    for name, prompt in cases:
        row = {"case": name}
        for model in MODELS:
            try:
                r = query(args.base_url, args.api_key, model, prompt)
                empty = r["content"] is None or r["content"] == ""
                row[model] = {"empty": empty, "content": (r["content"] or "")[:60], "completion_tokens": r["completion_tokens"]}
            except Exception as e:  # noqa: BLE001
                row[model] = {"empty": None, "error": f"{type(e).__name__}: {e}"}
        results.append(row)
        cells = []
        for model in MODELS:
            r = row[model]
            if r.get("error"):
                cells.append(f"ERR {r['error'][:22]}")
            elif r["empty"]:
                cells.append("EMPTY")
            else:
                cells.append(repr(r["content"][:24]))
        print(f"{name:38s} | {cells[0]:28s} | {cells[1]:28s}")

    gemma_empty = sum(1 for r in results if r[MODELS[0]].get("empty"))
    qwen_empty = sum(1 for r in results if r[MODELS[1]].get("empty"))
    print("-" * 105)
    print(f"EMPTY rate: gemma-4-12B {gemma_empty}/{len(results)} | Qwen3.5-9B {qwen_empty}/{len(results)}")

    if args.json_out:
        Path(args.json_out).write_text(json.dumps(results, ensure_ascii=False, indent=2))
        print(f"written: {args.json_out}")


if __name__ == "__main__":
    main()
