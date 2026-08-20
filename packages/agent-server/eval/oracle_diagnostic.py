#!/usr/bin/env python3
r"""Oracle Teacher Plan 诊断 harness（T8，评审 §一，用户 08-19 裁决必须做）。

四条件能力分解（评审 §一 / 任务书 §1.3，预注册口径）：

  条件 A：9B Alone                  —— 8789 injection=off
  条件 B：9B + Retrieved Memory     —— 8789 injection=on
  条件 C：9B + Oracle Teacher Plan  —— 8789 injection=off + Oracle plan 直接
         嵌入任务 prompt 包装（**绕开检索**直接给计划，评审 §一：
         "不经过 BM25 / semantic retrieval，直接把教师生成的正确结构化 plan
         给 9B"）；plan 来自条件 D 轨迹蒸馏
  条件 D：Teacher Direct Solve      —— deepseek-v4-pro（8899 中继）跑同一
         bash-tool agent loop（同 MAX_TURNS=30 / TOOL_TIMEOUT=120 / 重试 /
         workspace 克隆 / judge safe_grade）

指标（每任务 + 汇总）：MemoryGain=B−A、RetrievalLoss=C−B、ExecutionGap=D−C、
TeacherSolveRate=P(score_D>=0.5)、plan 蒸馏成功率。

诊断子集（纯函数 deterministic_subset，n=5，键预注册 sha256("oracle-diag")）：
  D1 重复集（day==1 ∧ arm=="experiment" ∧ kind=="repeat"）中
    1) ExhaustedFailure（触顶∧失败：termination_reason=="max_turns" 或旧行
       requests>=30 且 score<0.5）优先
    2) 不足按 hard 档（D1 score<0.3，未入选者）补
    3) 再不足按 sha256("oracle-diag"+task_id) 排序取
  每档内部同样以 sha256 键排序，确定性。

plan 蒸馏（prompt 模板写死在本模块，预注册）：
  系统提示 = "你是任务规划专家。请把下面的 agent 执行轨迹总结为结构化执行计划：
  输出编号步骤，每步一句，形如：\n1. 步骤描述\n2. 步骤描述\n..."
  输入 = 条件 D 成功（score>=0.5）任务的 transcript 文本；
  解析 = 正则提取编号步骤（^\s*(\d+)[.)、．]\s*(.+)$），要求从 1 开始连续编号、
  每步长度 >= 4 字符；蒸馏 API 失败或格式不符 → 该任务条件 C 跳过并计数
  （distillation.failures_n）。

条件 A/B 数据来源：默认复用既有 run.jsonl（A=control/x3 臂行、
B=experiment/x2 臂行——四臂主批按 campaign_cross 等效臂口径复用，x1/x4 冻结
臂不参与；每任务每等效臂集合取文件首行）；任一任务缺 A 或 B 时报错并提示
--run-ab；--run-ab 时 A/B 全部新跑（8789 injection=off/on）。

写入隔离（评审 §十 与 preview.html §10 精神）：本脚本所有落盘（oracle.json +
transcripts/oracle-D-*.json / oracle-C-*.json）写 results/oracle-diagnostic-<date>/
独立目录，绝不写进 campaign 的 results/<run>/transcripts/——不进 evolution；
transcripts 文件名带 `oracle` 前缀（任务书 §1.3），合成器不认该臂名，天然隔离。

教师 client：base_url 参数化（默认 http://127.0.0.1:8899/v1，env
ORACLE_TEACHER_BASE_URL / --teacher-base-url 可覆盖），api_key 只从 env
JUDGE_API_KEY 读（代码只读 env 不读文件），model=deepseek-v4-pro。

CLI：
    ./.venv/bin/python oracle_diagnostic.py results/<run_id> [--run-ab]
        [--teacher-base-url URL] [--out-dir results/oracle-diagnostic-<date>]
"""

import argparse
import hashlib
import json
import os
import re
import statistics
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path

from openai import OpenAI

from campaign import PASS_THRESHOLD, run_agent, safe_grade, setup_workspace, task_prompt
from campaign_plan import load_tasks
from preflight import ensure_for_base_url

EVAL_DIR = Path(__file__).resolve().parent
AGENT_SERVER = "http://127.0.0.1:8789/v1"
DEFAULT_TEACHER_BASE_URL = "http://127.0.0.1:8899/v1"
TEACHER_MODEL = "deepseek-v4-pro"  # 教师模型（judge 同款，主批同口径）
STUDENT_MODEL = "agent-auto"
SELECTION_KEY = "oracle-diag"  # 子集选取键（预注册，任务书 §1.3）
SELECTION_N = 5
HARD_SCORE = 0.3  # hard 档：D1 score<0.3（任务书 §1.3 / 任务书 §1.1 难度分层）
# A/B 复用等效臂（pi-test 5.5 连带修复）：A=control/x3（注入关），
# B=experiment/x2（实验等效臂，campaign_cross 口径）；x1/x4 冻结臂不参与。
A_ARMS = ("control", "x3")
B_ARMS = ("experiment", "x2")
# 条件 C 包装模板（预注册；注释：绕开检索直接给计划，评审 §一）。
PLAN_WRAPPER_TEMPLATE = (
    "以下是教师为此类任务验证过的正确计划，请按步骤执行：\n{plan}\n\n原始任务：\n{prompt}"
)
DISTILL_SYSTEM_PROMPT = (
    "你是任务规划专家。请把下面的 agent 执行轨迹总结为结构化执行计划："
    "输出编号步骤，每步一句，形如：\n1. 步骤描述\n2. 步骤描述\n..."
    "\n只输出步骤本身，不要其他文字。"
)
STEP_RE = re.compile(r"^\s*(\d+)[.)、．]\s*(.+)$", re.MULTILINE)
MIN_STEP_LEN = 4  # 每步至少 4 字符（"每步一句"的最低实质要求，预注册）


# ── 子集选取（纯函数） ──


def _is_capped(row: dict) -> bool:
    term = row.get("termination_reason")
    if term is not None:
        return term == "max_turns"
    return int(row.get("requests") or 0) >= 30  # 旧行 fallback（与 campaign 同口径）


def _hash_rank(task_id: str) -> str:
    return hashlib.sha256(f"{SELECTION_KEY}{task_id}".encode()).hexdigest()


def deterministic_subset(rows: list[dict], n: int = SELECTION_N) -> list[str]:
    """D1 重复集诊断子集（优先级见模块 docstring，键 sha256("oracle-diag")）。"""
    d1 = [
        r
        for r in rows
        if int(r.get("day") or 0) == 1
        and r.get("arm") == "experiment"
        and (r.get("kind") in (None, "repeat"))
    ]
    score_by_task: dict[str, float] = {}
    for r in d1:
        score_by_task[r["task_id"]] = max(score_by_task.get(r["task_id"], 0.0), float(r.get("score") or 0.0))
    exhausted = {
        r["task_id"]
        for r in d1
        if _is_capped(r) and float(r.get("score") or 0.0) < PASS_THRESHOLD
    }
    hard = {tid for tid in score_by_task if tid not in exhausted and score_by_task[tid] < HARD_SCORE}
    rest = set(score_by_task) - exhausted - hard
    tiers = [
        sorted(exhausted, key=_hash_rank),
        sorted(hard, key=_hash_rank),
        sorted(rest, key=_hash_rank),
    ]
    selected: list[str] = []
    for tier in tiers:
        for tid in tier:
            if len(selected) >= n:
                break
            selected.append(tid)
        if len(selected) >= n:
            break
    return selected


# ── plan 蒸馏解析（纯函数） ──


def parse_distilled_plan(text: str) -> list[str] | None:
    """解析教师蒸馏输出：编号步骤，从 1 开始连续，每步 >= MIN_STEP_LEN 字符。

    格式不符（无编号 / 不从 1 开始 / 步骤过短）返回 None → 条件 C 跳过并计数。
    """
    if not text:
        return None
    steps: list[tuple[int, str]] = []
    for m in STEP_RE.finditer(text):
        steps.append((int(m.group(1)), m.group(2).strip()))
    if not steps:
        return None
    if steps[0][0] != 1:
        return None
    for idx, (num, _step) in enumerate(steps):
        if num != idx + 1:  # 编号必须连续从 1 起
            return None
    plan = [step for _num, step in steps]
    if any(len(step) < MIN_STEP_LEN for step in plan):
        return None
    return plan


def transcript_to_text(transcript: list[dict]) -> str:
    """把 QCB OpenClaw 事件序列折成文本行（供教师蒸馏）。"""
    lines: list[str] = []
    for event in transcript or []:
        if not isinstance(event, dict):
            continue
        message = event.get("message")
        if not isinstance(message, dict):
            continue
        role = message.get("role")
        if role == "assistant":
            for part in message.get("content") or []:
                if isinstance(part, dict) and part.get("type") == "toolCall":
                    args = part.get("arguments") or {}
                    command = args.get("command") if isinstance(args, dict) else None
                    lines.append(f"toolCall {part.get('name', '')}: {command}")
                elif isinstance(part, dict) and part.get("type") == "text":
                    lines.append(f"assistant: {part.get('text', '')}")
        elif role == "toolResult":
            content = message.get("content") or []
            text = content[0] if content and isinstance(content, list) else ""
            lines.append(f"toolResult: {text}")
    return "\n".join(lines)


def distill_plan(client: OpenAI, transcript: list[dict]) -> str | None:
    """用同一教师模型把 D 轨迹摘要为结构化步骤；API 失败返回 None。"""
    try:
        resp = client.chat.completions.create(
            model=TEACHER_MODEL,
            messages=[
                {"role": "system", "content": DISTILL_SYSTEM_PROMPT},
                {"role": "user", "content": transcript_to_text(transcript)},
            ],
        )
        return resp.choices[0].message.content or ""
    except Exception as e:  # noqa: BLE001 - 蒸馏失败降级为 C 跳过，不炸批
        print(f"  distill error ({type(e).__name__}: {e})", file=sys.stderr)
        return None


# ── A/B 复用与汇总（纯函数） ──


def ab_scores_from_rows(rows: list[dict], task_ids: list[str]) -> tuple[dict[str, dict[str, float | None]], list[str]]:
    """复用既有 run.jsonl：A/B 各取等效臂集合的文件序首行（pi-test 5.5 连带修复）。

    等效臂按 campaign_cross 口径：A=control/x3（注入关），B=experiment/x2
    （实验等效臂）；x1/x4 冻结臂不参与（冻结库维度非本诊断口径）。
    """
    per_task: dict[str, dict[str, float | None]] = {tid: {"A": None, "B": None} for tid in task_ids}
    for row in rows:
        tid = row["task_id"]
        if tid not in per_task:
            continue
        arm = row.get("arm")
        if arm in A_ARMS and per_task[tid]["A"] is None:
            per_task[tid]["A"] = float(row.get("score") or 0.0)
        elif arm in B_ARMS and per_task[tid]["B"] is None:
            per_task[tid]["B"] = float(row.get("score") or 0.0)
    missing = [tid for tid in task_ids if per_task[tid]["A"] is None or per_task[tid]["B"] is None]
    return per_task, missing


def compute_summary(per_task: dict[str, dict]) -> dict:
    """汇总：均值（逐指标取双方都存在任务的配对）、TeacherSolveRate、蒸馏成功率。"""
    gains = {"memory_gain": ("B", "A"), "retrieval_loss": ("C", "B"), "execution_gap": ("D", "C")}
    summary: dict = {}
    for key, (hi, lo) in gains.items():
        values = [
            per_task[t][hi] - per_task[t][lo]
            for t in per_task
            if per_task[t].get(hi) is not None and per_task[t].get(lo) is not None
        ]
        summary[key] = {"value": statistics.fmean(values) if values else 0.0, "n": len(values)}
    d_scores = [per_task[t]["D"] for t in per_task if per_task[t].get("D") is not None]
    solved = [t for t in per_task if per_task[t].get("D") is not None and per_task[t]["D"] >= PASS_THRESHOLD]
    distilled = [t for t in per_task if per_task[t].get("distilled") is True]
    summary["teacher_solve_rate"] = (len(solved) / len(d_scores)) if d_scores else 0.0
    summary["teacher_solve_n"] = len(solved)
    summary["distillation"] = {
        "candidates_n": len(solved),  # 蒸馏候选 = D 成功任务
        "success_n": len(distilled),
        "failures_n": len(solved) - len(distilled),
        "success_rate": (len(distilled) / len(solved)) if solved else 0.0,
    }
    return summary


# ── 运行上下文（测试注入 stub） ──


@dataclass
class RunContext:
    student_client: object
    teacher_client: object
    run_agent: object  # campaign.run_agent 同签名（client, model, prompt, ws, timeout_s, *, injection, task_id, domain）
    grade: object  # campaign.safe_grade 同签名（task_id, execution, ws）
    setup_workspace: object  # campaign.setup_workspace 同签名（task_id, workdir）
    task_prompt: object  # campaign.task_prompt 同签名（task_id）
    task_timeout: object  # task_id -> 秒
    distill: object = distill_plan
    teacher_model: str = TEACHER_MODEL
    student_model: str = STUDENT_MODEL


# ── 批量运行 ──


def run_diagnostic_batch(
    task_ids: list[str],
    rows: list[dict],
    ctx: RunContext,
    out_dir: Path,
    *,
    run_ab: bool = False,
) -> dict:
    """四条件诊断（A/B 复用或 --run-ab 新跑；C 依赖 D 蒸馏；隔离落盘 out_dir）。"""
    ab, missing = ab_scores_from_rows(rows, task_ids)
    if missing and not run_ab:
        raise RuntimeError(
            f"missing A/B rows for {sorted(missing)} — reuse run.jsonl incomplete; rerun with --run-ab "
            "(8789 injection off/on 新跑)"
        )
    out_dir.mkdir(parents=True, exist_ok=True)
    traj_dir = out_dir / "transcripts"  # 隔离目录（不进 campaign transcripts，评审 §十）
    traj_dir.mkdir(parents=True, exist_ok=True)
    per_task: dict[str, dict] = {}
    for tid in task_ids:
        prompt = ctx.task_prompt(tid)
        timeout_s = ctx.task_timeout(tid)
        record: dict = {"A": ab[tid]["A"], "B": ab[tid]["B"], "C": None, "D": None, "distilled": False, "plan": None}
        if run_ab:
            # 条件 A（injection off）/ B（injection on）新跑
            for cond, injection in (("A", False), ("B", True)):
                ws = ctx.setup_workspace(tid, out_dir / f"cond-{cond}")
                execution = ctx.run_agent(
                    ctx.student_client, ctx.student_model, prompt, ws, timeout_s,
                    injection=injection, task_id=tid, domain="office",
                )
                grade = ctx.grade(tid, execution, ws)
                record[cond] = float(grade.get("score") or 0.0)
                (traj_dir / f"oracle-{cond}-{tid}.json").write_text(
                    json.dumps({"task_id": tid, "condition": cond, "prompt": prompt,
                                "transcript": execution["transcript"], "score": record[cond]}, ensure_ascii=False)
                )
        # 条件 D：Teacher Direct Solve（deepseek 中继，同回路）
        ws_d = ctx.setup_workspace(tid, out_dir / "cond-D")
        execution_d = ctx.run_agent(
            ctx.teacher_client, ctx.teacher_model, prompt, ws_d, timeout_s,
            injection=False, task_id=tid, domain="office",
        )
        grade_d = ctx.grade(tid, execution_d, ws_d)
        record["D"] = float(grade_d.get("score") or 0.0)
        (traj_dir / f"oracle-D-{tid}.json").write_text(
            json.dumps({"task_id": tid, "condition": "D", "prompt": prompt,
                        "transcript": execution_d["transcript"], "score": record["D"]}, ensure_ascii=False)
        )
        # 蒸馏：D 成功任务 → 教师摘要结构化步骤
        if record["D"] >= PASS_THRESHOLD:
            raw = ctx.distill(ctx.teacher_client, execution_d["transcript"])
            plan = parse_distilled_plan(raw) if raw else None
            if plan:
                record["distilled"] = True
                record["plan"] = plan
        # 条件 C：9B + Oracle Teacher Plan（injection off + 包装 prompt 直接内嵌计划）
        if record["plan"]:
            numbered_plan = "\n".join(f"{i + 1}. {step}" for i, step in enumerate(record["plan"]))
            wrapped = PLAN_WRAPPER_TEMPLATE.format(plan=numbered_plan, prompt=prompt)
            ws_c = ctx.setup_workspace(tid, out_dir / "cond-C")
            execution_c = ctx.run_agent(
                ctx.student_client, ctx.student_model, wrapped, ws_c, timeout_s,
                injection=False, task_id=tid, domain="office",
            )
            grade_c = ctx.grade(tid, execution_c, ws_c)
            record["C"] = float(grade_c.get("score") or 0.0)
            (traj_dir / f"oracle-C-{tid}.json").write_text(
                json.dumps({"task_id": tid, "condition": "C", "prompt": wrapped,
                            "transcript": execution_c["transcript"], "score": record["C"]}, ensure_ascii=False)
            )
        per_task[tid] = record
    report = {
        "selection_key": SELECTION_KEY,
        "selection": task_ids,
        "per_task": per_task,
        "summary": compute_summary(per_task),
    }
    (out_dir / "oracle.json").write_text(json.dumps(report, indent=2, ensure_ascii=False))
    return report


# ── CLI ──


def teacher_client(base_url: str = "") -> OpenAI:
    """教师 client：base_url 参数化，api_key 只从 env JUDGE_API_KEY 读（不读文件）。"""
    return OpenAI(base_url=base_url or DEFAULT_TEACHER_BASE_URL, api_key=os.environ.get("JUDGE_API_KEY", ""), timeout=1800.0)


def _teacher_models_url(base_url: str) -> str:
    """OpenAI 兼容 base → /v1/models 探针 URL（去尾 /v1 防双拼，pi-test 5.4）。"""
    base = base_url.rstrip("/")
    if base.endswith("/v1"):
        base = base[: -len("/v1")]
    return f"{base}/v1/models"


def _probe_teacher(base_url: str) -> None:
    """教师中继可达性探针（无认证，不读 .env；不可达 fail fast）。"""
    try:
        with urllib.request.urlopen(_teacher_models_url(base_url), timeout=5):
            return
    except urllib.error.HTTPError:
        return
    except Exception:
        sys.exit(
            f"preflight FAIL: teacher relay {base_url} unreachable — start it "
            "(node eval/deepseek_relay.mjs) or override with ORACLE_TEACHER_BASE_URL"
        )


def main() -> None:
    ap = argparse.ArgumentParser(description="Oracle Teacher Plan 诊断（T8，评审 §一）")
    ap.add_argument("results", type=Path, help="results/<run_id>（run.jsonl，A/B 复用与子集选取）")
    ap.add_argument("--run-ab", action="store_true", help="A/B 新跑（8789 injection off/on）而非复用 run.jsonl")
    ap.add_argument("--teacher-base-url", default="", help=f"默认 {DEFAULT_TEACHER_BASE_URL}")
    ap.add_argument("--out-dir", type=Path, default=EVAL_DIR / "results" / f"oracle-diagnostic-{time.strftime('%Y%m%d')}")
    args = ap.parse_args()
    run_jsonl = args.results / "run.jsonl"
    if not run_jsonl.exists():
        sys.exit(f"run.jsonl not found: {run_jsonl}")
    rows = [json.loads(line) for line in run_jsonl.read_text().splitlines() if line.strip()]
    task_ids = deterministic_subset(rows)
    if not task_ids:
        sys.exit("no D1 repeat rows found in run.jsonl — cannot build diagnostic subset")
    print(f"diagnostic subset ({len(task_ids)}): {task_ids}")
    base = args.teacher_base_url or os.environ.get("ORACLE_TEACHER_BASE_URL", DEFAULT_TEACHER_BASE_URL)
    ensure_for_base_url(AGENT_SERVER)
    _probe_teacher(base)
    student = OpenAI(base_url=AGENT_SERVER, api_key="lobster-local-key", timeout=1800.0)
    meta = {t.id: t for t in load_tasks()}
    ctx = RunContext(
        student_client=student,
        teacher_client=teacher_client(base),
        run_agent=run_agent,
        grade=safe_grade,
        setup_workspace=setup_workspace,
        task_prompt=task_prompt,
        task_timeout=lambda tid: meta.get(tid).timeout_seconds if meta.get(tid) else 1800,
    )
    report = run_diagnostic_batch(task_ids, rows, ctx, args.out_dir, run_ab=args.run_ab)
    print(json.dumps(report, indent=2, ensure_ascii=False))
    print(f"wrote {args.out_dir / 'oracle.json'} (isolated dir, not campaign transcripts)")


if __name__ == "__main__":
    main()
