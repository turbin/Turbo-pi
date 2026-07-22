"""agent-server 离线 CLI：

  python -m sop_lifecycle --input trajectories.json --output sops.json

input:  [{ "toolCalls": [{ "messageNumber": int, "tool": str,
                           "arguments": dict, "result": str }] }]
        （agent-server 从会话 JSONL 采集的工具调用轨迹；长度 <2 的忽略）
output: [{ "name": str, "code": str, "docstring": str, "schema": dict, "tools": [str] }]
        （本批构造并存活下来的 active SOP）

真实工具在 agent 侧，子进程内无法重执行，因此：
- 工具注册表由轨迹中观测到的工具名构造为 echo callable；
- train_tasks 为空、epochs=1，只做 CONSTRUCTOR→MERGER 一轮，不跑
  EVALUATOR 抽样重执行，REVIEWER 的零调用剪枝规则也不会触发；
  重执行评估留待训练任务集（SPEC §4.2 step 2）接入后启用。

配置 LLM_BASE_URL + LLM_MODEL/TEACHER_MODEL 时走真实 OpenAI 兼容端点，
否则回退到确定性 MockLLM（离线联调用）。
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile

from skill_evolution import MockLLM, OpenAICompatClient, SkillStore, SopConfig, SopLifecycle


def _echo_tool(**kwargs) -> str:
    return json.dumps(kwargs, ensure_ascii=False)[:200]


def _normalize_trajectories(raw: list[dict]) -> tuple[list[list[dict]], list[str]]:
    trajs: list[list[dict]] = []
    tool_names: list[str] = []
    for item in raw:
        calls = item.get("toolCalls") or item.get("tool_calls") or []
        norm = []
        for i, c in enumerate(calls):
            tool = c.get("tool") or c.get("name")
            if not tool:
                continue
            norm.append(
                {
                    "message_number": int(c.get("messageNumber") or c.get("message_number") or i + 1),
                    "tool": str(tool),
                    "arguments": c.get("arguments") or {},
                    "result": str(c.get("result") or ""),
                }
            )
        if len(norm) >= 2:
            trajs.append(norm)
            tool_names.extend(c["tool"] for c in norm)
    return trajs, sorted(set(tool_names))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="sop_lifecycle")
    parser.add_argument("--input", required=True, help="trajectories.json 路径")
    parser.add_argument("--output", required=True, help="sops.json 输出路径")
    args = parser.parse_args(argv)

    with open(args.input, encoding="utf-8") as f:
        raw = json.load(f)
    trajs, tool_names = _normalize_trajectories(raw)

    if not trajs:
        with open(args.output, "w", encoding="utf-8") as f:
            json.dump([], f)
        return 0

    tools = {name: _echo_tool for name in tool_names}
    tool_docs = {name: f"{name}(**kwargs) -> str：会话轨迹中观测到的工具。" for name in tool_names}
    if os.environ.get("LLM_BASE_URL") and (os.environ.get("LLM_MODEL") or os.environ.get("TEACHER_MODEL")):
        llm = OpenAICompatClient.teacher_from_env()
    else:
        llm = MockLLM()

    cfg = SopConfig(epochs=1, construct_epochs=1, batch_size=len(trajs), seed=0)
    workdir = tempfile.mkdtemp(prefix="sop-lifecycle-")
    try:
        store = SkillStore(workdir)
        lifecycle = SopLifecycle(store, llm, tools, tool_docs, config=cfg)
        lifecycle.run(trajs, [])

        out = [
            {
                "name": s["name"],
                "code": s["code"],
                "docstring": s["docstring"],
                "schema": s["schema"],
                "tools": s["tools"],
            }
            for s in store.get_sops("active")
        ]
        store.close()
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
