#!/usr/bin/env python3
r"""Plan Adherence 离线分析器（T7，评审 §三：9B 到底有没有遵循 Teacher Plan）。

输入：results/<run_id>/（run.jsonl + transcripts/dayN/）+ experience.db。
输出：按日分组的 JSON。

指标（启发式，预注册；误报面见"动作 token"节）：

  PlanAdoptionRate = 注入 Method/Guard 卡的任务（注入开启臂行）中，transcript
     任一 toolCall 覆盖 ≥1 个卡片关键动作 token 的任务占比。
     分母 = 当日注入开启臂（experiment/x1/x2）中 injected_ids 含 ABILITY
     Method/Guard 卡的任务数；注入卡 join 口径 = request_traces.injected_ids
     （F0 issue-013：实际进入 prompt 的卡 id 集，SKILL/SOP 独立通道不计）
     → experiences（type='ABILITY'，payload.role ∈ {Method, Guard}；
     Method 取 payload.procedure、Guard 取 payload.boundary 作为卡 content）。
     "覆盖" = 该任务 transcript 的任一 toolCall（name + arguments.command 拼接
     文本）包含 ≥1 个动作 token。

  PlanDeviationRate = 触顶∧失败任务中，与全部注入卡动作 token 零重叠的
     toolCall 占比（全部 toolCall 为分母，附逐任务明细）。
     触顶 = termination_reason=="max_turns"；旧行无该字段 fallback requests>=30
     （与 trajectory_metrics/campaign_metrics 同口径）。失败 = score<0.5。
     误报面：token 覆盖只看文本共现——语义上"执行了等价动作但用词不同"会被
     误判为偏离；反方向，文本相同但语义相反（如 `rm` 与 `cat` 同一路径）不会
     被误判为遵循。该指标只回答"文本层面是否复用了卡里的动作词"。

  动作 token 提取规则（启发式，从卡 content 正则提取，预注册）：
    1. bash 命令动词：`\b(?:cd|ls|cat|find|grep|sed|awk|cp|mv|rm|mkdir|touch|
       chmod|chown|python3?|node|npm|npx|git|curl|wget|tar|unzip|head|tail|wc|
       echo|printf|pwd|jq|source|bash|sh|rg|tree|diff|patch|make|pip3?|yarn|
       pnpm|nano|vim|less|sort|uniq|cut|tr|fold|env|export|mkdir)\b`
    2. 文件路径：绝对路径 `(?:/[A-Za-z0-9._-]+){1,}` 或带扩展名的相对路径
       `[A-Za-z0-9_./-]+\.(?:py|js|ts|md|json|yaml|yml|toml|sh|txt|env|cfg|ini|
       csv|log|html|css)`
    3. 工具名：`\b(?:bash)\b`（本 campaign 唯一 tool）
    停用词（单词 token 过滤）：the/and/for/with/are/you/your。
    覆盖判定：单词 token 用词边界（`\b`），路径 token 用子串包含（路径常被
    拼接改写，如 `config/app.json.bak`）。

CLI：
    ./.venv/bin/python plan_adherence.py results/<run_id> [--experience-db PATH]
    默认 experience.db = packages/agent-server/var/eval/experience.db
"""

import argparse
import json
import re
import sqlite3
import sys
from pathlib import Path

EVAL_DIR = Path(__file__).resolve().parent
DEFAULT_DB = EVAL_DIR.parent / "var" / "eval" / "experience.db"
PASS_THRESHOLD = 0.5  # 失败口径，与 campaign.py 同值
# 注入开启臂（request_traces.injected_ids 只在这些臂非空；control/x3/x4 为关）。
ON_ARMS = ("experiment", "x1", "x2")
# 卡 content 的动作 token 提取（预注册，见模块 docstring）。
VERB_RE = re.compile(
    r"\b(?:cd|ls|cat|find|grep|sed|awk|cp|mv|rm|mkdir|touch|chmod|chown|python3?|node|npm|npx|git|curl|wget|tar|unzip|head|tail|wc|echo|printf|pwd|jq|source|bash|sh|rg|tree|diff|patch|make|pip3?|yarn|pnpm|nano|vim|less|sort|uniq|cut|tr|fold|env|export)\b"
)
TOOL_RE = re.compile(r"\b(?:bash)\b")
PATH_RE = re.compile(r"(?:/[A-Za-z0-9._-]+){1,}|[A-Za-z0-9_./-]+\.(?:json|yaml|yml|toml|html|css|py|js|ts|md|sh|txt|env|cfg|ini|csv|log)")
STOPWORDS = {"the", "and", "for", "with", "are", "you", "your"}


# ── 动作 token 提取与覆盖 ──


def extract_action_tokens(content: str) -> dict[str, set[str]]:
    """从卡 content 提取关键动作 token（启发式，规则见模块 docstring）。

    返回 {"words": 命令动词/工具名集合, "paths": 文件路径集合}，全部小写。
    """
    text = content or ""
    words = {m.group(0).lower() for m in VERB_RE.finditer(text)}
    words |= {m.group(0).lower() for m in TOOL_RE.finditer(text)}
    words -= STOPWORDS
    paths = {m.group(0).lower() for m in PATH_RE.finditer(text)}
    return {"words": words, "paths": paths}


def token_covered(token: str, text: str, is_path: bool) -> bool:
    """单词 token 词边界匹配（防 "cat" 命中 "concatenate"），路径 token 子串匹配。"""
    haystack = text.lower()
    if is_path:
        return token in haystack
    return re.search(rf"\b{re.escape(token)}\b", haystack) is not None


def toolcall_texts(transcript: list[dict]) -> list[str]:
    """每个 toolCall 的拼接文本（name + arguments JSON 文本）。"""
    texts: list[str] = []
    for event in transcript or []:
        if not isinstance(event, dict):
            continue
        message = event.get("message")
        if not isinstance(message, dict):
            continue
        for part in message.get("content") or []:
            if isinstance(part, dict) and part.get("type") == "toolCall":
                name = part.get("name", "")
                args = part.get("arguments", {})
                if isinstance(args, dict):
                    command = args.get("command", "")
                    if isinstance(command, str):
                        texts.append(f"{name} {command}".strip())
    return texts


# ── experience.db 读取 ──


def connect_db(path: Path) -> sqlite3.Connection:
    """只读连接；内存库（:memory:，测试用）与文件库均支持。"""
    if str(path) == ":memory:":
        return sqlite3.connect(":memory:")
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True)


def injected_method_guard_cards(con: sqlite3.Connection, task_ids: set[str]) -> dict[str, list[tuple[str, str, dict]]]:
    """task_id → [(card_id, role, payload)]：request_traces.injected_ids join
    experiences 后的 Method/Guard 卡（type='ABILITY' 且 payload.role ∈ Method/Guard）。"""
    cards_by_task: dict[str, list[tuple[str, str, dict]]] = {tid: [] for tid in task_ids}
    if not task_ids:
        return cards_by_task
    by_id: dict[str, dict] = {}
    rows = con.execute("SELECT task_id, injected_ids FROM request_traces WHERE task_id IS NOT NULL").fetchall()
    want: set[str] = set()
    for task_id, injected_raw in rows:
        if task_id not in task_ids:
            continue
        try:
            injected = json.loads(injected_raw or "[]")
        except json.JSONDecodeError:
            continue
        want.update(i for i in injected if isinstance(i, str))
    for chunk in _chunks(sorted(want), 500):
        for exp_id, exp_type, payload_raw in con.execute(
            "SELECT id, type, payload FROM experiences WHERE id IN (%s)" % ",".join("?" * len(chunk)), chunk
        ):
            if exp_type != "ABILITY":
                continue
            try:
                payload = json.loads(payload_raw)
            except json.JSONDecodeError:
                continue
            by_id[exp_id] = payload
    for task_id, injected_raw in rows:
        if task_id not in task_ids:
            continue
        try:
            injected = json.loads(injected_raw or "[]")
        except json.JSONDecodeError:
            continue
        for card_id in injected:
            payload = by_id.get(card_id)
            if payload is None:
                continue
            role = payload.get("role")
            if role not in ("Method", "Guard"):
                continue
            cards_by_task[task_id].append((card_id, role, payload))
    return cards_by_task


def _chunks(items: list[str], size: int) -> list[list[str]]:
    return [items[i : i + size] for i in range(0, len(items), size)]


def card_content(payload: dict) -> str:
    """卡 content：Method → procedure；Guard → boundary；回落 text/title 拼接。"""
    role = payload.get("role")
    if role == "Method":
        return str(payload.get("procedure") or "")
    if role == "Guard":
        return str(payload.get("boundary") or "")
    return str(payload.get("text") or "")


# ── 指标（纯函数） ──


def _is_capped(row: dict) -> bool:
    term = row.get("termination_reason")
    if term is not None:
        return term == "max_turns"
    return int(row.get("requests") or 0) >= 30  # 旧行 fallback（预注册口径）


def _tokens_by_task(cards_by_task: dict[str, list[tuple[str, str, dict]]]) -> dict[str, list[dict]]:
    """task_id → [{"words": set, "paths": set}]（每卡一套 token）。"""
    return {
        tid: [extract_action_tokens(card_content(payload)) for _cid, _role, payload in cards]
        for tid, cards in cards_by_task.items()
    }


def _covers_any(tokens: dict, toolcalls: list[str]) -> tuple[bool, list[str]]:
    """任一 toolCall 覆盖任一卡 token；返回 (是否覆盖, 覆盖的 token 列表)。"""
    covered: list[str] = []
    for text in toolcalls:
        for word in tokens["words"]:
            if token_covered(word, text, is_path=False):
                covered.append(word)
        for path in tokens["paths"]:
            if token_covered(path, text, is_path=True):
                covered.append(path)
    return bool(covered), covered


def _as_events(transcript) -> list[dict]:
    """兼容两种形态：事件列表，或 campaign 落盘记录（含 "transcript" 键）。"""
    if isinstance(transcript, dict) and "transcript" in transcript:
        return transcript["transcript"] or []
    return transcript or []


def plan_adoption_rate(rows: list[dict], transcripts: dict[str, list[dict]], cards_by_task: dict[str, list[tuple[str, str, dict]]]) -> dict:
    """PlanAdoptionRate（预注册口径见模块 docstring）。

    rows: run.jsonl 行（须含 day/task_id/arm）；transcripts: task_id → transcript
    事件列表（与行同 arm）；cards_by_task: injected_method_guard_cards 输出。
    """
    tokens_by_task = _tokens_by_task(cards_by_task)
    detail: list[dict] = []
    for row in rows:
        tid = row["task_id"]
        if row.get("arm") not in ON_ARMS:
            continue
        tokens = tokens_by_task.get(tid)
        if not tokens:
            continue  # 无注入 Method/Guard 卡，不计
        transcript = transcripts.get(tid)
        if transcript is None:
            detail.append({"task_id": tid, "adopted": None, "covered_tokens": [], "note": "transcript missing"})
            continue
        all_tokens = {"words": set(), "paths": set()}
        for t in tokens:
            all_tokens["words"] |= t["words"]
            all_tokens["paths"] |= t["paths"]
        adopted, covered = _covers_any(all_tokens, toolcall_texts(_as_events(transcript)))
        detail.append({"task_id": tid, "adopted": adopted, "covered_tokens": sorted(set(covered))[:20]})
    denominator = sum(1 for d in detail if d.get("adopted") is not None)
    adopted_n = sum(1 for d in detail if d.get("adopted") is True)
    return {
        "rate": (adopted_n / denominator) if denominator else 0.0,
        "adopted_n": adopted_n,
        "denominator": denominator,
        "detail": detail,
    }


def plan_deviation_rate(rows: list[dict], transcripts: dict[str, list[dict]], cards_by_task: dict[str, list[tuple[str, str, dict]]]) -> dict:
    """PlanDeviationRate：触顶∧失败任务中与全部注入卡动作 token 零重叠的 toolCall 占比。"""
    tokens_by_task = _tokens_by_task(cards_by_task)
    total = 0
    deviating = 0
    detail: list[dict] = []
    for row in rows:
        tid = row["task_id"]
        if row.get("arm") not in ON_ARMS:
            continue
        if not (_is_capped(row) and float(row.get("score") or 0.0) < PASS_THRESHOLD):
            continue
        tokens = tokens_by_task.get(tid)
        if not tokens:
            continue
        transcript = transcripts.get(tid)
        if transcript is None:
            continue
        all_tokens = {"words": set(), "paths": set()}
        for t in tokens:
            all_tokens["words"] |= t["words"]
            all_tokens["paths"] |= t["paths"]
        per_call: list[bool] = []
        for text in toolcall_texts(_as_events(transcript)):
            covered, _ = _covers_any(all_tokens, [text])
            per_call.append(not covered)  # 零重叠 = 偏离
        total += len(per_call)
        deviating += sum(per_call)
        detail.append({"task_id": tid, "toolcalls_n": len(per_call), "deviating_n": sum(per_call)})
    return {
        "rate": (deviating / total) if total else 0.0,
        "deviating_n": deviating,
        "toolcalls_n": total,
        "detail": detail,
    }


# ── 整库 wiring ──


def report(run_dir: Path, db_path: Path) -> dict:
    """读 results/<run_id>（run.jsonl + transcripts）+ experience.db，按日分组输出。"""
    run_rows = [json.loads(line) for line in (run_dir / "run.jsonl").read_text().splitlines() if line.strip()]
    task_ids = {r["task_id"] for r in run_rows}
    con = connect_db(db_path)
    try:
        cards_by_task = injected_method_guard_cards(con, task_ids)
    finally:
        con.close()
    by_day: dict[str, dict] = {}
    for day in sorted({int(r["day"]) for r in run_rows}):
        day_rows = [r for r in run_rows if int(r["day"]) == day]
        transcripts: dict[str, list[dict]] = {}
        for r in day_rows:
            if r.get("arm") not in ON_ARMS:
                continue  # 指标只统计注入开启臂，transcript 同臂取用
            path = run_dir / "transcripts" / f"day{day}" / f"{r['arm']}-{r['task_id']}.json"
            if path.exists() and r["task_id"] not in transcripts:
                transcripts[r["task_id"]] = json.loads(path.read_text()).get("transcript") or []
        adoption = plan_adoption_rate(day_rows, transcripts, cards_by_task)
        deviation = plan_deviation_rate(day_rows, transcripts, cards_by_task)
        by_day[str(day)] = {
            "plan_adoption_rate": adoption["rate"],
            "plan_adoption_adopted_n": adoption["adopted_n"],
            "plan_adoption_denominator": adoption["denominator"],
            "adoption_detail": adoption["detail"],
            "plan_deviation_rate": deviation["rate"],
            "plan_deviation_deviating_n": deviation["deviating_n"],
            "plan_deviation_toolcalls_n": deviation["toolcalls_n"],
            "deviation_detail": deviation["detail"],
        }
    return {"run_id": run_dir.name, "experience_db": str(db_path), "by_day": by_day}


def main() -> None:
    ap = argparse.ArgumentParser(description="Plan Adherence 离线分析（T7，评审 §三）")
    ap.add_argument("run_dir", type=Path, help="results/<run_id> 目录（run.jsonl + transcripts）")
    ap.add_argument("--experience-db", type=Path, default=DEFAULT_DB, help="experience.db 路径")
    args = ap.parse_args()
    if not args.run_dir.exists():
        sys.exit(f"run dir not found: {args.run_dir}")
    print(json.dumps(report(args.run_dir, args.experience_db), indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
