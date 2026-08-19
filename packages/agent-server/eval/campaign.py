#!/usr/bin/env python3
"""C 阶段办公自动化 campaign runner（每日批次：重复集 + 新任务切片）。

每日流程（D1..D7）：
  1. 实验臂：重复集 20 + 当日新任务切片，经 8789（injection on）
  2. 对照臂（仅 D1/D7）：重复集，经 8789 + injection off（同路径对照，trace 全落库）
  3. 当日结束后：合成任务级轨迹 → runDailyEvolution → 次日用热库

判据预注册见 doc/design/2026-08-05-agent-server-c-campaign-design.md。

用法：
    ./.venv/bin/python campaign.py --day 1 --dry-run          # 打印当日批次
    ./.venv/bin/python campaign.py --day 1                    # 正式跑（自动 preflight）
    ./.venv/bin/python campaign.py --metrics results/campaign-x/run.jsonl  # 判据核算
"""

import argparse
import contextlib
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

from openai import OpenAI

from campaign_metrics import check_criteria, daily_summary
from campaign_plan import daily_batch, load_tasks
import campaign_cross
from preflight import ensure_for_base_url

EVAL_DIR = Path(__file__).resolve().parent
QCB_DIR = EVAL_DIR / "qcb" / "tasks-v1.1"
HARNESS_REF = EVAL_DIR / "qcb" / "harness-ref"
sys.path.insert(0, str(HARNESS_REF))  # vendored QCB lib_tasks/lib_grading

AGENT_SERVER = "http://127.0.0.1:8789/v1"
MAX_TURNS = 30
RETRY_BASE_SECONDS = 30  # 测试可 monkeypatch 为 0
TOOL_TIMEOUT_SECONDS = 120  # 单条 bash 命令上限；超时作为观察返回而非炸批
PASS_THRESHOLD = 0.5

BASH_TOOL = {
    "type": "function",
    "function": {
        "name": "bash",
        "description": "Execute a bash command in the task workspace.",
        "parameters": {
            "type": "object",
            "properties": {"command": {"type": "string", "description": "The bash command to execute"}},
            "required": ["command"],
        },
    },
}


def setup_workspace(task_id: str, workdir: Path) -> Path:
    """Copy the task's asset tree into an isolated workspace."""
    src = QCB_DIR / "assets" / task_id
    ws = workdir / task_id
    ws.mkdir(parents=True, exist_ok=True)
    if src.exists():
        shutil.copytree(src, ws, dirs_exist_ok=True)
    return ws


def _gateway_marker(resp: object) -> dict:
    """Escalation marker from the gateway x-gateway header (issue-003 M1)."""
    try:
        raw = resp.headers.get("x-gateway") if hasattr(resp, "headers") else None  # type: ignore[attr-defined]
        if not raw:
            return {}
        return json.loads(raw)
    except (AttributeError, json.JSONDecodeError):
        return {}


def _body_marker(resp: object) -> dict:
    """issue-004：非流式升级标记内嵌在 body 的 x_gateway 字段（openai SDK 的
    ChatCompletion 无 .headers，extra="allow" 使其穿透为同名属性）。"""
    m = getattr(resp, "x_gateway", None)
    return m if isinstance(m, dict) else {}


def _response_marker(resp: object) -> dict:
    """body 内嵌标记优先，header 标记回落。"""
    return _body_marker(resp) or _gateway_marker(resp)


def _response_trace_id(resp: object) -> str:
    """对账键 = gateway trace_id（marker），回落 body id。

    issue-015（M1/F0 回归）：F0 后 agent-server 把响应 body id 覆写为自己的
    请求 id（UUID 带横线），不再是 gateway trace_id——run.jsonl.trace_ids
    与 model_runs 的 join 静默断裂（pilot 暴露）。必须取 marker.trace_id。
    """
    return _response_marker(resp).get("trace_id") or getattr(resp, "id", "")


# --- Langfuse 监视（2026-08-19，可选） ---
# LANGFUSE_PUBLIC_KEY/SECRET_KEY 存在且 langfuse 包已安装时启用；缺省/异常
# 只告警降级，绝不杀死批次（issue-008/009/011 教训：可观测性不得炸批）。
# 对账口径：任务级 trace id = create_trace_id(seed=f"{run_id}-d{day}-{arm}-{task_id}")；
# gateway 侧每请求 generation 的 trace id = create_trace_id(seed=chatcmpl 响应 id)，
# 与 run.jsonl.trace_ids / model_runs / agent-server session marker 同一对账键。


class _NullObservation:
    """langfuse 关闭时的 no-op 观察对象（与 generation.update 同形）。"""

    def update(self, **_fields: object) -> None:
        return None


def init_langfuse():
    """构建 Langfuse 客户端；未配置/未安装/初始化失败均返回 None。"""
    if not (os.environ.get("LANGFUSE_PUBLIC_KEY") and os.environ.get("LANGFUSE_SECRET_KEY")):
        return None
    try:
        from langfuse import Langfuse  # noqa: PLC0415 - 可选依赖，启用时才需要

        return Langfuse()  # 读 LANGFUSE_PUBLIC_KEY/SECRET_KEY/HOST env
    except Exception as e:  # noqa: BLE001 - 可选依赖初始化失败不炸批
        print(f"langfuse disabled ({type(e).__name__}: {e})", file=sys.stderr)
        return None


def task_observation(lf, *, seed: str, name: str, metadata: dict):
    """任务级 trace context；lf 为 None 时退化为 nullcontext(no-op)。"""
    if lf is None:
        return contextlib.nullcontext(_NullObservation())
    from langfuse.types import TraceContext  # noqa: PLC0415 - lf 非 None 时 langfuse 必可用

    return lf.start_as_current_observation(
        trace_context=TraceContext(trace_id=lf.create_trace_id(seed=seed)),
        name=name,
        as_type="agent",
        input=metadata,
        metadata=metadata,
    )


def report_score(lf, *, seed: str, score: float, comment: str) -> None:
    """QCB 分数上报；任何异常只告警。trace id 与 task_observation 同一 seed。"""
    if lf is None:
        return
    try:
        lf.create_score(
            name="qcb_score",
            value=score,
            trace_id=lf.create_trace_id(seed=seed),
            comment=comment[:500] if comment else None,
        )
    except Exception as e:  # noqa: BLE001 - 上报失败不炸批
        print(f"langfuse score failed ({type(e).__name__}: {e})", file=sys.stderr)


def run_agent(client: OpenAI, model: str, prompt: str, ws: Path, timeout_s: int, *, injection: bool, task_id: str, domain: str) -> dict:
    """Minimal bash-tool agent loop (E1 harness 同源形态）。

    C1（2026-08-09 对抗审查）：`injection` 是必选关键字参数——实验/对照臂
    必须显式声明注入开关，而不是靠未定义变量 NameError。每条响应记录
    trace_id 与 x-gateway 升级标记（C2/M1），供判据核算与 model_runs 回填。

    F0（issue-013）：`task_id` 同为必选关键字参数——随请求透传到
    request_traces.task_id（extra_body），补上 任务分数↔请求↔注入集 的
    join 链；缺省会静默丢失归因键，故不允许缺省。

    F3（T4）：`domain` 同为必选关键字参数——随请求透传（extra_body），
    agent-server 侧用于检索域过滤（跨域注入为零）与 session 元数据；
    缺省会静默丢失情景键，故不允许缺省。
    """
    transcript: list[dict] = []
    messages = [
        {
            "role": "system",
            "content": (
                f"You are an office-automation agent. Your workspace is {ws}. "
                "Complete the task using the bash tool. Work entirely inside the workspace."
            ),
        },
        {"role": "user", "content": prompt},
    ]
    t0 = time.time()
    requests = 0
    trace_ids: list[str] = []
    escalated = False
    for _ in range(MAX_TURNS):
        if time.time() - t0 > timeout_s:
            transcript.append({"type": "message", "message": {"role": "assistant", "content": [{"type": "text", "text": "[timeout]"}]}})
            break
        requests += 1
        # 27B 慢回合 latency 可达 700-950s（D1 事故：单次 APITimeout 杀死整日
        # 批次）。瞬时 API 错误重试，指数退避；重试耗尽才向外抛。
        resp = None
        last_err: Exception | None = None
        for attempt in range(4):
            try:
                resp = client.chat.completions.create(
                    model=model,
                    messages=messages,
                    tools=[BASH_TOOL],
                    extra_body={"injection": injection, "task_id": task_id, "domain": domain},
                )
                break
            except Exception as e:  # noqa: BLE001 - APITimeout/Connection/5xx 均为瞬时
                last_err = e
                wait = RETRY_BASE_SECONDS * (2**attempt)
                print(f"  llm error ({type(e).__name__}); retry {attempt + 1}/4 in {wait}s", file=sys.stderr)
                time.sleep(wait)
        if resp is None:
            raise RuntimeError(f"llm failed after 4 attempts: {last_err}")
        trace_ids.append(_response_trace_id(resp))
        escalated = escalated or bool(_response_marker(resp).get("escalated"))
        msg = resp.choices[0].message
        # transcript 采用 QCB lib_grading 的 OpenClaw 事件形态
        # （{type:"message", message:{role, content:[parts]}}），
        # judge 的 _summarize_transcript 只认这个结构。
        parts: list[dict] = []
        if msg.content:
            parts.append({"type": "text", "text": msg.content})
        for call in msg.tool_calls or []:
            parts.append(
                {
                    "type": "toolCall",
                    "name": call.function.name,
                    "arguments": json.loads(call.function.arguments or "{}"),
                }
            )
        transcript.append({"type": "message", "message": {"role": "assistant", "content": parts}})
        if not msg.tool_calls:
            messages.append({"role": "assistant", "content": msg.content or ""})
            break
        messages.append(msg.model_dump())
        for call in msg.tool_calls:
            args = json.loads(call.function.arguments or "{}")
            try:
                proc = subprocess.run(
                    ["bash", "-c", args.get("command", "")],
                    cwd=ws,
                    capture_output=True,
                    text=True,
                    timeout=TOOL_TIMEOUT_SECONDS,
                )
                output = (proc.stdout + proc.stderr)[:8000]
            except subprocess.TimeoutExpired:
                # D2 事故：agent 的大范围 find（1T 外置盘）撞 120s 上限，
                # TimeoutExpired 未捕获杀死整批。超时转为观察让 agent 自行调整。
                output = f"[command timed out after {TOOL_TIMEOUT_SECONDS}s — narrow the command scope]"
            except OSError as e:
                output = f"[command failed to start: {e}]"
            transcript.append({"type": "message", "message": {"role": "toolResult", "content": [output[:500]]}})
            messages.append({"role": "tool", "tool_call_id": call.id, "content": output})
    return {
        "status": "completed",
        "transcript": transcript,
        "workspace": str(ws),
        "requests": requests,
        "trace_ids": trace_ids,
        "escalated": escalated,
    }


def grade(task_id: str, execution: dict, ws: Path) -> dict:
    """Vendored QCB grading（automated + judge hybrid）。judge 走 .env 的 DeepSeek。"""
    from lib_grading import grade_task  # noqa: PLC0415 - vendored import
    from lib_tasks import TaskLoader  # noqa: PLC0415

    task = TaskLoader(QCB_DIR / "tasks").load_task(QCB_DIR / "tasks" / f"{task_id}.md")
    # judge 口径（P-D6）：deepseek-v4-pro；vendored 默认 claude-opus 不可用，必须显式覆盖。
    result = grade_task(
        task=task,
        execution_result=execution,
        skill_dir=ws,
        judge_model=os.environ.get("JUDGE_MODEL", "deepseek-v4-pro"),
    )
    return result.to_dict()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--day", type=int)
    ap.add_argument("--run-id", default=f"campaign-{time.strftime('%Y%m%d')}")
    ap.add_argument("--model", default="agent-auto")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument(
        "--arms",
        default="",
        help="T7 交叉臂模式：x1,x2,x3,x4（冻结库×注入开 / 当日库×开 / 当日库×关 / 冻结库×关）；"
        "每臂跑当日重复集。缺省 = 旧双臂（experiment/control）。",
    )
    ap.add_argument(
        "--frozen-base-url",
        default="",
        help="T7 冻结臂（X1/X4）的评估实例 base URL（加载 D1 快照且全程不换载）；"
        "缺省回退 AGENT_SERVER（单实例模式，真实跑批必须显式指定）。",
    )
    ap.add_argument("--metrics", default="", help="核算既有结果 JSONL 的判据，不跑批")
    ap.add_argument(
        "--gateway-db",
        default="",
        help="gateway SQLite（model_runs 回填升级标记，C2）；--metrics 时生效。"
        "默认 packages/agent-gateway/var/agent_gateway.db",
    )
    args = ap.parse_args()

    if args.metrics:
        from campaign_metrics import annotate_escalation, load_results

        rows = load_results(Path(args.metrics))
        gateway_db = Path(args.gateway_db or "../../agent-gateway/var/agent_gateway.db")
        if gateway_db.exists():
            rows = annotate_escalation(rows, gateway_db)
        report = {"daily": daily_summary(rows), "criteria": check_criteria(rows)}
        # T7：结果含四臂时附加交叉差分核算（库演进 / 即时注入 / sanity）。
        if all(any(r.get("arm") == arm for r in rows) for arm in campaign_cross.CROSS_ARMS):
            report["cross"] = {"diffs": campaign_cross.cross_arm_diffs(rows),
                               "sanity": campaign_cross.check_sanity(rows)}
        print(json.dumps(report, indent=2, ensure_ascii=False))
        return

    if not args.day:
        ap.error("--day required unless --metrics")

    tasks = load_tasks()
    batch = daily_batch(tasks, args.day)
    if args.arms:
        # T7 交叉臂模式：每臂跑当日重复集（四臂 = 库版本 × 注入开关 2×2）。
        arms = {arm: batch["repeat"] for arm in args.arms.split(",")}
        frozen_base = args.frozen_base_url or AGENT_SERVER
        client_frozen = OpenAI(base_url=frozen_base, api_key="lobster-local-key", timeout=1800.0)
        print(f"day {args.day}: cross arms {sorted(arms)} repeat={len(batch['repeat'])} each"
              f" (frozen base: {frozen_base})")
    else:
        arms = {"experiment": batch["repeat"] + batch["new"]}
        if args.day in (1, 7):
            arms["control"] = batch["repeat"]
        client_frozen = None
        print(f"day {args.day}: repeat={len(batch['repeat'])} new={len(batch['new'])}")
    if args.dry_run:
        for arm, ids in arms.items():
            print(f"  [{arm}] {len(ids)} tasks")
            for tid in ids:
                print(f"    {tid}")
        return

    ensure_for_base_url(AGENT_SERVER)
    lf = init_langfuse()
    if lf is not None:
        print(f"langfuse: enabled (host {os.environ.get('LANGFUSE_HOST', 'https://cloud.langfuse.com')})")
    out_dir = EVAL_DIR / "results" / args.run_id
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "run.jsonl"
    # 单请求可能 15min+（27B 长输出），客户端超时必须大于最慢回合。
    client = OpenAI(base_url=AGENT_SERVER, api_key="lobster-local-key", timeout=1800.0)
    done = completed_keys(out_path)
    if done:
        print(f"resume: {len(done)} tasks already completed, skipping")

    with open(out_path, "a") as out:
        for arm, ids in arms.items():
            for i, task_id in enumerate(ids):
                if (args.day, arm, task_id) in done:
                    print(f"[{arm} {i + 1}/{len(ids)}] {task_id} skip (done)")
                    continue
                kind = "repeat" if task_id in set(batch["repeat"]) else "new"
                meta = next(t for t in tasks if t.id == task_id)
                ws = setup_workspace(task_id, out_dir / f"day{args.day}" / arm)
                # T7 交叉臂（m5-test-review 缺陷-1 修复）：注入按臂接线
                # （ARM_INJECTION：x1/x2 开、x3/x4 关）、冻结臂走冻结实例
                # （client_frozen，锁库不换载）、library 维度按臂取值。
                if args.arms:
                    arm_client = client_frozen if campaign_cross.ARM_LIBRARY[arm] == "frozen" else client
                    injection = campaign_cross.ARM_INJECTION[arm]
                    library = campaign_cross.ARM_LIBRARY[arm]
                else:
                    arm_client = client
                    injection = arm == "experiment"
                    library = ""
                execution = None
                lf_seed = f"{args.run_id}-d{args.day}-{arm}-{task_id}"
                lf_meta = {
                    "run_id": args.run_id,
                    "day": args.day,
                    "arm": arm,
                    "task_id": task_id,
                    "kind": kind,
                    "model": args.model,
                    **({"library": library} if args.arms else {}),
                }
                with task_observation(lf, seed=lf_seed, name=f"task:{arm}:{task_id}", metadata=lf_meta) as obs:
                    execution = run_agent(
                        arm_client, args.model, task_prompt(task_id), ws, meta.timeout_seconds,
                        injection=injection, task_id=task_id, domain="office",
                    )
                    g = safe_grade(task_id, execution, ws)
                    try:
                        obs.update(output={
                            "score": g["score"],
                            "requests": execution["requests"],
                            "escalated": execution["escalated"],
                            "trace_ids": execution["trace_ids"],
                        })
                    except Exception as e:  # noqa: BLE001 - 上报失败不炸批
                        print(f"langfuse update failed ({type(e).__name__}: {e})", file=sys.stderr)
                report_score(lf, seed=lf_seed, score=g["score"], comment=str(g.get("notes", "")))
                # 轨迹落盘（夜间进化的原料）：每任务一份完整 transcript，
                # 缺失即无进化输入——合成器对它硬失败。
                traj_dir = out_dir / "transcripts" / f"day{args.day}"
                traj_dir.mkdir(parents=True, exist_ok=True)
                (traj_dir / f"{arm}-{task_id}.json").write_text(
                    json.dumps(
                        {
                            "task_id": task_id,
                            "arm": arm,
                            "day": args.day,
                            "prompt": task_prompt(task_id),
                            "transcript": execution["transcript"],
                            "score": g["score"],
                        },
                        ensure_ascii=False,
                    )
                )
                row = {
                    "day": args.day,
                    "task_id": task_id,
                    "kind": kind,
                    "arm": arm,
                    "score": g["score"],
                    "passed": g["score"] >= PASS_THRESHOLD,
                    # T7：四臂落库附库版本维度（frozen/daily），差分核算按臂取值。
                    **({"library": library} if args.arms else {}),
                    # C2：升级标记来自网关 x-gateway 头（M1），trace_ids 供
                    # model_runs 回填核对；不再硬编码 False。
                    "escalated": execution["escalated"],
                    "trace_ids": execution["trace_ids"],
                    "requests": execution["requests"],
                    "grading": g,
                }
                out.write(json.dumps(row, ensure_ascii=False) + "\n")
                out.flush()
                print(f"[{arm} {i + 1}/{len(ids)}] {task_id} score={g['score']:.2f}")

    if lf is not None:
        try:
            lf.flush()
        except Exception as e:  # noqa: BLE001 - flush 失败不炸批
            print(f"langfuse flush failed ({type(e).__name__}: {e})", file=sys.stderr)


def safe_grade(task_id: str, execution: dict, ws: Path) -> dict:
    """评分崩溃降级为 grading_error 行（score=0），不杀死批次。

    issue-011：QCB 任务内嵌评分脚本自身有 bug（如 readme_content 未绑定——
    agent 未产出 README 时触发 UnboundLocalError），exec 评分代码的异常
    不得穿透到批次层。
    """
    try:
        g = grade(task_id, execution, ws)
        g["grading_error"] = False
        return g
    except Exception as e:  # noqa: BLE001 - vendored 评分代码异常不可枚举
        return {
            "task_id": task_id,
            "score": 0.0,
            "grading_type": "error",
            "breakdown": {},
            "notes": f"grading crashed: {type(e).__name__}: {e}",
            "grading_error": True,
        }


def completed_keys(results_path: Path) -> set[tuple[int, str, str]]:
    """断点续跑：已从 run.jsonl 完成的 (day, arm, task_id) 集合。缺文件返回空集。"""
    if not results_path.exists():
        return set()
    done: set[tuple[int, str, str]] = set()
    for line in results_path.read_text().splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        done.add((int(row["day"]), str(row["arm"]), str(row["task_id"])))
    return done


def task_prompt(task_id: str) -> str:
    """取任务 md 的 ## Prompt 节正文（到下一个 ## 之前）。"""
    body = (QCB_DIR / "tasks" / f"{task_id}.md").read_text()
    return body.split("## Prompt", 1)[1].split("\n## ", 1)[0].strip()


if __name__ == "__main__":
    main()
