"""T1/T2 回归：task-block 随机臂序 + termination_reason + held-out 接线。

设计条款出处：
- preview.html §12.2：四臂模式禁止"全部 X1 → 全部 X2 → ..."臂块顺序
  （25h 窗口时间漂移），以 task 为 block、按 seed 确定性随机化臂序
  （seed 派生自 run_id+day+task_id，同 run-id 重跑顺序一致）；
- preview.html §8.1：终止原因三态 completed/max_turns/timeout，CapHit 严格
  以 termination_reason == "max_turns" 判定，不以 requests==30 替代；
- preview.html §7.2/Q8（用户 08-19 裁决 = 8 个）：held-out 冻结任务只挂
  current 臂（x2/x3）供 D7 memory on/off transfer 比较，x1/x4 与旧双臂不含；
- D1 resume 兼容：旧 run.jsonl 行（无 termination_reason 字段）读取不炸
  （completed_keys 只读 day/arm/task_id）。

mock 方式参考 tests/test_campaign_cross_wiring.py（monkeypatch 驱动
campaign.main() 真实执行回路）。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from types import SimpleNamespace

EVAL_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(EVAL_DIR))

import campaign  # noqa: E402

CROSS_ARMS = ("x1", "x2", "x3", "x4")
FROZEN_BASE = "http://frozen-instance:8787"


def _repeat_ids(n: int = 20) -> list[str]:
    return [f"task_{i:04d}_repeat_x" for i in range(1, n + 1)]


def _arms_dict(repeat_ids: list[str], held_ids: tuple[str, ...] = ()) -> dict[str, list[str]]:
    """与 campaign.main() 相同的四臂任务表（x2/x3 = 重复集 + held-out）。"""
    arms = {arm: list(repeat_ids) for arm in CROSS_ARMS}
    for arm in ("x2", "x3"):
        arms[arm] = arms[arm] + sorted(held_ids)
    return arms


# ── T1：task-block 随机臂序（preview §12.2）───────────────────────────────


def test_task_block_plan_deterministic_same_run_id():
    """同 run-id 重跑顺序一致（seed 派生自 run_id+day+task_id）。"""
    arms = _arms_dict(_repeat_ids())
    assert campaign.task_block_plan(arms, "run-1", 3) == campaign.task_block_plan(arms, "run-1", 3)


def test_task_block_plan_full_coverage_80_and_permutation():
    """四臂 × 20 重复任务 = 80 次执行全覆盖；每任务臂序为四臂的排列。"""
    repeat = _repeat_ids()
    pairs = list(campaign.task_block_plan(_arms_dict(repeat), "run-1", 3))
    assert len(pairs) == 80
    assert len(set(pairs)) == 80  # 无重复无遗漏
    for tid in repeat:
        arms_for = [a for a, t in pairs if t == tid]
        assert sorted(arms_for) == list(CROSS_ARMS)
    orders = {tid: [a for a, t in pairs if t == tid] for tid in repeat}
    assert len({tuple(o) for o in orders.values()}) >= 2, "不同 task 应产生不同臂序（§12.2 seed 确定性随机）"


def test_task_block_plan_order_differs_across_run_ids():
    """不同 run-id（seed 变化）臂序整体不同。"""
    repeat = _repeat_ids()
    orders = {}
    for run in ("run-1", "run-2"):
        plan = campaign.task_block_plan(_arms_dict(repeat), run, 3)
        orders[run] = {t: [a for a, t2 in plan if t2 == t] for t in repeat}
    assert any(orders["run-1"][t] != orders["run-2"][t] for t in repeat)


def test_task_block_plan_held_out_only_on_x2_x3():
    """held-out 任务在计划中只出现于 x2/x3（各一次），臂序仍确定性随机。"""
    repeat = _repeat_ids(2)
    held = ["task_9998_held_x", "task_9999_held_x"]
    plan = list(campaign.task_block_plan(_arms_dict(repeat, held), "run-1", 3))
    for arm, tid in plan:
        if tid in held:
            assert arm in ("x2", "x3"), "held-out 不得出现在 x1/x4"
    for tid in held:
        assert sorted(a for a, t in plan if t == tid) == ["x2", "x3"]


# ── T1：termination_reason 三态（preview §8.1）────────────────────────────


class _Msg:
    def __init__(self, content, tool_calls):
        self.content = content
        self.tool_calls = tool_calls

    def model_dump(self):
        d = {"role": "assistant", "content": self.content}
        if self.tool_calls:
            d["tool_calls"] = [
                {"id": tc.id, "type": "function",
                 "function": {"name": tc.function.name, "arguments": tc.function.arguments}}
                for tc in self.tool_calls
            ]
        return d


def _tool_call():
    return [SimpleNamespace(id="call_tb", function=SimpleNamespace(name="bash", arguments='{"command": ""}'))]


def _chat_client(messages: list) -> SimpleNamespace:
    from collections import deque

    class Resp:
        id = "chatcmpl-fake-tb"
        headers = {}

        def __init__(self, msg):
            self.choices = [SimpleNamespace(message=msg)]

    class Completions:
        def __init__(self):
            self.queue = deque(messages)

        def create(self, **kwargs):
            return Resp(self.queue.popleft())

    return SimpleNamespace(chat=SimpleNamespace(completions=Completions()))


def test_termination_reason_completed(tmp_path):
    """自然完成（无 tool_calls break）→ "completed"。"""
    client = _chat_client([_Msg("done", None)])
    result = campaign.run_agent(client, "agent-auto", "t", tmp_path, timeout_s=60,
                                injection=False, task_id="task_x", domain="office")
    assert result["termination_reason"] == "completed"


def test_termination_reason_max_turns(tmp_path, monkeypatch):
    """MAX_TURNS 耗尽（每回合都 tool_calls）→ "max_turns"，不得以 requests==30 替代。"""
    monkeypatch.setattr(campaign, "MAX_TURNS", 3)
    client = _chat_client([_Msg(None, _tool_call()) for _ in range(3)])
    result = campaign.run_agent(client, "agent-auto", "t", tmp_path, timeout_s=60,
                                injection=False, task_id="task_x", domain="office")
    assert result["termination_reason"] == "max_turns"
    assert result["requests"] == 3
    assert result["status"] == "completed"


def test_termination_reason_timeout(tmp_path, monkeypatch):
    """超 timeout_s → "timeout"，且 transcript 保留 [timeout] 追加。

    确定性时钟：t0=1000，首次循环检查时已 +1s，不依赖真实墙钟进度。"""
    clock = {"t": 1000.0}
    monkeypatch.setattr(campaign.time, "time", lambda: (clock.__setitem__("t", clock["t"] + 1.0) or clock["t"]))
    client = _chat_client([_Msg(None, _tool_call())])
    result = campaign.run_agent(client, "agent-auto", "t", tmp_path, timeout_s=0,
                                injection=False, task_id="task_x", domain="office")
    assert result["termination_reason"] == "timeout"
    assert any(
        part.get("text") == "[timeout]"
        for e in result["transcript"]
        if e.get("type") == "message"
        for part in e.get("message", {}).get("content", [])
        if isinstance(part, dict)
    )


# ── T1/T2：campaign.main() 回路（mock 驱动，参考 test_campaign_cross_wiring）─


class FakeOpenAI:
    def __init__(self, base_url: str, **kwargs):
        self.base_url = base_url


def _run_main(tmp_path, monkeypatch, argv, repeat_ids, new_ids=(), held_ids=(), done=None):
    """驱动 campaign.main()，返回 run_agent 调用记录。

    done=None：completed_keys 走真实文件（断点续跑测试）；done=set：注入集合。
    """
    calls: list[dict] = []

    def fake_run_agent(client, model, prompt, ws, timeout_s, *, injection, task_id, domain):
        arm = Path(ws).parts[-1]  # workspace 路径末段 = 臂名
        calls.append({"arm": arm, "injection": injection, "client": client, "task_id": task_id})
        return {"transcript": [{"role": "assistant", "content": "ok"}],
                "escalated": False, "trace_ids": ["chatcmpl-fake"], "requests": 1,
                "termination_reason": "completed"}

    all_ids = list(repeat_ids) + list(new_ids) + list(held_ids)
    monkeypatch.setattr(campaign, "load_tasks", lambda: [SimpleNamespace(id=t, timeout_seconds=60) for t in all_ids])
    monkeypatch.setattr(campaign, "daily_batch", lambda tasks, day: {"repeat": repeat_ids, "new": list(new_ids)})
    monkeypatch.setattr(campaign, "held_out_tasks", lambda tasks: sorted(held_ids))
    monkeypatch.setattr(campaign, "setup_workspace", lambda task_id, base: str(base))
    monkeypatch.setattr(campaign, "run_agent", fake_run_agent)
    monkeypatch.setattr(campaign, "safe_grade", lambda task_id, execution, ws: {"score": 0.5})
    monkeypatch.setattr(campaign, "ensure_for_base_url", lambda base: None)
    monkeypatch.setattr(campaign, "task_prompt", lambda task_id: f"do {task_id}")
    if done is not None:
        monkeypatch.setattr(campaign, "completed_keys", lambda path: set(done))
    monkeypatch.setattr(campaign, "OpenAI", FakeOpenAI)
    monkeypatch.setattr(campaign, "EVAL_DIR", tmp_path)
    monkeypatch.setattr(sys, "argv", argv)
    campaign.main()
    return calls


def test_arms_day_held_out_only_on_x2_x3(tmp_path, monkeypatch):
    """T2：四臂日 held-out 挂 x2/x3（§7.2 D7 memory on/off），x1/x4 不含；
    落库行 kind=held_out + termination_reason。"""
    repeat = _repeat_ids(2)
    held = ["task_9998_held_x"]
    calls = _run_main(tmp_path, monkeypatch,
                      ["campaign.py", "--day", "3", "--arms", "x1,x2,x3,x4",
                       "--frozen-base-url", FROZEN_BASE, "--run-id", "held-wiring"],
                      repeat_ids=repeat, held_ids=held)
    assert len(calls) == 2 * 4 + 1 * 2  # 8 + 2
    assert {c["arm"] for c in calls if c["task_id"] in held} == {"x2", "x3"}
    for tid in repeat:
        assert {c["arm"] for c in calls if c["task_id"] == tid} == set(CROSS_ARMS)

    rows = [json.loads(l) for l in (tmp_path / "results" / "held-wiring" / "run.jsonl").read_text().splitlines()]
    assert len(rows) == 10
    held_rows = [r for r in rows if r["task_id"] in held]
    assert len(held_rows) == 2 and {r["arm"] for r in held_rows} == {"x2", "x3"}
    assert all(r["kind"] == "held_out" for r in held_rows)
    assert all(r["termination_reason"] == "completed" for r in rows)
    assert all(r["kind"] == "repeat" for r in rows if r["task_id"] in repeat)


def test_non_arms_day_no_held_out(tmp_path, monkeypatch):
    """T2：非四臂日 held-out 完全不出现在任何臂（experiment/control 不含）。"""
    repeat = _repeat_ids(2)
    new_ids = ["task_0050_new_x"]
    held = ["task_9998_held_x"]
    calls = _run_main(tmp_path, monkeypatch,
                      ["campaign.py", "--day", "1", "--run-id", "dual-no-held"],
                      repeat_ids=repeat, new_ids=new_ids, held_ids=held)
    assert {c["task_id"] for c in calls} == set(repeat) | set(new_ids)
    assert all(c["task_id"] not in held for c in calls)


def test_resume_skips_done_pairs_and_writes_termination_reason(tmp_path, monkeypatch):
    """D1 resume 兼容：旧 run.jsonl 行（无 termination_reason）读取不炸；
    task-block 下 (day, arm, task_id) 断点跳过正确；新落库行带 termination_reason。"""
    repeat = _repeat_ids(3)
    run_jsonl = tmp_path / "results" / "resume-old" / "run.jsonl"
    run_jsonl.parent.mkdir(parents=True)
    run_jsonl.write_text("\n".join([
        json.dumps({"day": 3, "arm": "x1", "task_id": repeat[0]}),
        json.dumps({"day": 3, "arm": "x2", "task_id": repeat[1]}),
        json.dumps({"day": 3, "arm": "x2", "task_id": repeat[2]}),
    ]) + "\n")
    calls = _run_main(tmp_path, monkeypatch,
                      ["campaign.py", "--day", "3", "--arms", "x1,x2,x3,x4",
                       "--frozen-base-url", FROZEN_BASE, "--run-id", "resume-old"],
                      repeat_ids=repeat)  # done=None → completed_keys 读真实文件
    assert len(calls) == 12 - 3
    done_pairs = {("x1", repeat[0]), ("x2", repeat[1]), ("x2", repeat[2])}
    assert not ({(c["arm"], c["task_id"]) for c in calls} & done_pairs)
    rows = [json.loads(l) for l in run_jsonl.read_text().splitlines()]
    assert len(rows) == 12
    assert all("termination_reason" in r for r in rows[3:])  # 新行带字段，旧行不带


def test_completed_keys_tolerates_old_rows_without_termination_reason(tmp_path):
    """D1 resume 兼容：completed_keys 只读 day/arm/task_id，旧行无
    termination_reason 不炸（§8.1 新字段对旧行 .get() 容错的落点）。"""
    p = tmp_path / "run.jsonl"
    p.write_text("\n".join([
        json.dumps({"day": 1, "arm": "experiment", "task_id": "task_a", "score": 0.5}),
        json.dumps({"day": 2, "arm": "x2", "task_id": "task_b", "score": 0.6,
                    "termination_reason": "max_turns"}),
    ]))
    assert campaign.completed_keys(p) == {(1, "experiment", "task_a"), (2, "x2", "task_b")}


def test_resume_mid_task_block_no_dup_no_loss(tmp_path, monkeypatch):
    """断点续跑在 task-block 中段恢复：同一任务 4 臂已完成 3 臂（x1/x2/x3），
    恢复后只补缺失的 x4 一次，其余任务全量执行——不重不漏。"""
    repeat = _repeat_ids(3)
    r0, r1, r2 = repeat[0], repeat[1], repeat[2]
    run_jsonl = tmp_path / "results" / "resume-mid" / "run.jsonl"
    run_jsonl.parent.mkdir(parents=True)
    run_jsonl.write_text("\n".join([
        json.dumps({"day": 3, "arm": "x1", "task_id": r0, "termination_reason": "completed"}),
        json.dumps({"day": 3, "arm": "x2", "task_id": r0, "termination_reason": "completed"}),
        json.dumps({"day": 3, "arm": "x3", "task_id": r0, "termination_reason": "completed"}),
        json.dumps({"day": 3, "arm": "x1", "task_id": r1, "termination_reason": "completed"}),
        json.dumps({"day": 3, "arm": "x2", "task_id": r2, "termination_reason": "completed"}),
    ]) + "\n")
    calls = _run_main(tmp_path, monkeypatch,
                      ["campaign.py", "--day", "3", "--arms", "x1,x2,x3,x4",
                       "--frozen-base-url", FROZEN_BASE, "--run-id", "resume-mid"],
                      repeat_ids=repeat)
    # 12 计划 − 5 已完成 = 7；r0 只补 x4 一次。
    assert len(calls) == 7
    per_task = {}
    for c in calls:
        per_task.setdefault(c["task_id"], []).append(c["arm"])
    assert sorted(per_task[r0]) == ["x4"], "task-block 中段恢复：仅补缺失臂"
    assert sorted(per_task[r1]) == ["x2", "x3", "x4"]
    assert sorted(per_task[r2]) == ["x1", "x3", "x4"]
    rows = [json.loads(l) for l in run_jsonl.read_text().splitlines()]
    assert len(rows) == 12
    from collections import Counter
    assert max(Counter((r["arm"], r["task_id"]) for r in rows).values()) == 1, "无重复执行"


def test_termination_reason_timeout_via_main(tmp_path, monkeypatch):
    """timeout 路径端到端：campaign.main() 用真实 run_agent（确定性时钟，
    timeout_s=0）→ run.jsonl 行 termination_reason == "timeout"，transcript
    含 [timeout] 追加（pilot 出现过的 [timeout] 分支）。"""
    from collections import deque

    class Resp:
        id = "chatcmpl-fake-timeout"
        headers = {}

        def __init__(self, msg):
            self.choices = [SimpleNamespace(message=msg)]

    class Completions:
        def __init__(self):
            self.queue = deque([_Msg(None, _tool_call())])

        def create(self, **kwargs):
            return Resp(self.queue.popleft())

    class FakeClient:
        def __init__(self, **kwargs):
            self.chat = SimpleNamespace(completions=Completions())

    clock = {"t": 1000.0}

    def fake_time():
        t = clock["t"]
        clock["t"] += 1.0
        return t

    monkeypatch.setattr(campaign.time, "time", fake_time)
    monkeypatch.setattr(campaign, "load_tasks", lambda: [SimpleNamespace(id="task_x", timeout_seconds=0)])
    monkeypatch.setattr(campaign, "daily_batch", lambda tasks, day: {"repeat": [], "new": ["task_x"]})
    monkeypatch.setattr(campaign, "held_out_tasks", lambda tasks: [])
    monkeypatch.setattr(campaign, "setup_workspace", lambda task_id, base: str(base))
    monkeypatch.setattr(campaign, "ensure_for_base_url", lambda base: None)
    monkeypatch.setattr(campaign, "safe_grade", lambda task_id, execution, ws: {"score": 0.5, "grading_error": False})
    monkeypatch.setattr(campaign, "task_prompt", lambda task_id: f"do {task_id}")
    monkeypatch.setattr(campaign, "OpenAI", FakeClient)
    monkeypatch.setattr(campaign, "EVAL_DIR", tmp_path)
    monkeypatch.setattr(sys, "argv", ["campaign.py", "--day", "3", "--run-id", "timeout-run"])
    campaign.main()
    rows = [json.loads(l) for l in (tmp_path / "results" / "timeout-run" / "run.jsonl").read_text().splitlines()]
    assert len(rows) == 1
    assert rows[0]["termination_reason"] == "timeout"
    assert rows[0]["requests"] == 0
    assert rows[0]["kind"] == "new"
    # transcript 含 [timeout] 追加（transcripts 落盘物）。
    traj = json.loads((tmp_path / "results" / "timeout-run" / "transcripts" / "day3" / "experiment-task_x.json").read_text())
    assert any(
        part.get("text") == "[timeout]"
        for e in traj["transcript"]
        if e.get("type") == "message"
        for part in e.get("message", {}).get("content", [])
        if isinstance(part, dict)
    )


def test_dry_run_shows_task_block_order(tmp_path, monkeypatch, capsys):
    """dry-run 输出体现 task-block 臂序（§12.2 核验），held-out 挂 x2/x3 可见。"""
    repeat = _repeat_ids(2)
    held = ["task_9998_held_x"]
    _run_main(tmp_path, monkeypatch,
              ["campaign.py", "--day", "3", "--arms", "x1,x2,x3,x4",
               "--frozen-base-url", FROZEN_BASE, "--run-id", "dry", "--dry-run"],
              repeat_ids=repeat, held_ids=held)
    out = capsys.readouterr().out
    lines = [l.strip() for l in out.splitlines() if l.strip().startswith("task_")]
    assert len(lines) == 3  # 2 重复 + 1 held-out
    seqs = {l.split(":", 1)[0]: [a.strip() for a in l.split(":", 1)[1].split("→")] for l in lines}
    for tid in repeat:
        assert sorted(seqs[tid]) == list(CROSS_ARMS), f"{tid} 应四臂齐全: {seqs[tid]}"
    assert sorted(seqs[held[0]]) == ["x2", "x3"], "held-out dry-run 只显示 x2/x3"
