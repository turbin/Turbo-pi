"""EvoSOP 生命周期：CONSTRUCTOR → MERGER → EVALUATOR → REVIEWER + 每 epoch checkpoint 选优。

对齐简报 §4.1 Algorithm 1；简化（按简报 §7.2 与任务包要求）：
- EVALUATOR：训练集抽样 30-50% 重执行（被新 SOP 覆盖的任务必抽），替代全量重跑；
- REVIEWER：确定性阈值规则优先（缺陷率>0.5 或连续 2 epoch 零调用即剪），LLM 兜底；
- epoch 数默认 3（前 2 构造、后 1 纯优化），论文为 10（前 5 构造）；
- SOP 评审记录保留在库中（论文剪枝时删除记录；此处为可审计性保留，见 README 简化点）。
"""
from __future__ import annotations

import ast
import random
import re
from dataclasses import dataclass, field
from typing import Any, Callable

from . import prompts
from .llm_client import LLMClient
from .parsing import ParseError, extract_code, extract_pylist, llm_json
from .store import SkillStore

# REVIEWER 5 态标签（不互斥）
LABEL_OPTIMAL = "optimal_execution"
LABEL_PARTIAL = "partial_utility"
LABEL_NEUTRALITY = "neutrality"
LABEL_NEGATIVE = "negative_interference"
LABEL_DEFECT = "implementation_defect"
ALL_LABELS = [LABEL_OPTIMAL, LABEL_PARTIAL, LABEL_NEUTRALITY, LABEL_NEGATIVE, LABEL_DEFECT]

# 静态检查黑名单（危险操作前置过滤，简报 §7.2）
_BANNED = ("os.system", "subprocess", "__import__", "eval(", "exec(", "open(", "import os", "import sys")


@dataclass
class SopConfig:
    epochs: int = 3
    construct_epochs: int = 2  # 仅前 N 个 epoch 引入新 SOP（exclusive stage）
    batch_size: int = 2  # 每 epoch 喂入的轨迹条数
    sample_ratio: float = 0.5  # 训练集抽样比例（区间 0.3~0.5）
    min_calls: int = 3  # 缺陷率规则的最小调用数
    defect_prune: float = 0.5  # Implementation Defect 率阈值（>0.5 即剪）
    zero_call_epochs: int = 2  # 连续零调用 epoch 数（即剪）
    tool_limit: int = 15  # 注入工具列表硬上限
    seed: int = 0


@dataclass
class EpochReport:
    epoch: int
    new_sops: list[str] = field(default_factory=list)
    merged_sops: list[str] = field(default_factory=list)
    pruned: list[dict] = field(default_factory=list)
    tasks_attempted: int = 0
    tasks_passed: int = 0
    success_rate: float = 0.0
    active_sops: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# 静态检查与 schema 提取
# ---------------------------------------------------------------------------


def static_check(code: str, known_tools: set[str]) -> tuple[bool, str, str, str, list[str]]:
    """SOP 代码前置过滤。返回 (ok, reason, fn_name, docstring, used_tools)。"""
    lowered = code
    for bad in _BANNED:
        if bad in lowered:
            return False, f"含危险操作 {bad!r}", "", "", []
    try:
        tree = ast.parse(code)
    except SyntaxError as exc:
        return False, f"语法错误: {exc}", "", "", []
    fn = next((n for n in tree.body if isinstance(n, ast.FunctionDef)), None)
    if fn is None:
        return False, "未定义顶层函数", "", "", []
    doc = ast.get_docstring(fn) or ""
    if "Args:" not in doc or "Returns:" not in doc:
        return False, "docstring 缺少 Args:/Returns: 小节", "", "", []
    used = sorted(
        {
            n.func.id
            for n in ast.walk(tree)
            if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id in known_tools
        }
    )
    missing = [t for t in used if t not in doc]
    if missing:
        return False, f"docstring 未按序列出用到的 tool_call: {missing}", "", "", []
    return True, "ok", fn.name, doc, used


def schema_from_code(code: str) -> dict:
    """从 SOP 函数签名提取 function-calling 参数 schema（全部按 string 处理）。"""
    try:
        tree = ast.parse(code)
        fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef))
    except (SyntaxError, StopIteration):
        return {"type": "object", "properties": {}}
    props: dict[str, Any] = {}
    required: list[str] = []
    defaults_offset = len(fn.args.args) - len(fn.args.defaults)
    for i, arg in enumerate(fn.args.args):
        if arg.arg in ("self", "cls"):
            continue
        props[arg.arg] = {"type": "string", "description": f"参数 {arg.arg}"}
        if i < defaults_offset:
            required.append(arg.arg)
    return {"type": "object", "properties": props, "required": required}


# ---------------------------------------------------------------------------
# 默认重执行器（demo / 测试用；真实集成时由 agent server 注入 reexecute_fn）
# ---------------------------------------------------------------------------


def default_reexecute(
    tasks: list[dict], sops: list[dict], tools: dict[str, Callable[..., Any]]
) -> tuple[list[dict], dict[str, dict]]:
    """在沙箱命名空间中执行 SOP 并采集评审标签。

    task 形如 {"id": ..., "sop": <name>, "kwargs": {...}, "expect": True}。
    返回 (任务结果列表, {sop_name: {calls, success, labels, reasons}})。
    """
    namespace: dict[str, Any] = dict(tools)
    for sop in sops:
        try:
            exec(compile(sop["code"], f"<sop:{sop['name']}>", "exec"), namespace)
        except Exception:
            pass  # 编译期失败的 SOP 在调用期体现为缺失
    results: list[dict] = []
    stats: dict[str, dict] = {}

    def _stat(name: str) -> dict:
        return stats.setdefault(
            name, {"calls": 0, "success": 0, "labels": {k: 0 for k in ALL_LABELS}, "reasons": []}
        )

    for task in tasks:
        name = task.get("sop", "")
        expect = bool(task.get("expect", True))
        fn = namespace.get(name) if name else None
        active = any(s["name"] == name for s in sops)
        if not fn or not active:
            results.append({"id": task.get("id"), "success": False, "reason": "SOP 未注册或已剪除"})
            continue
        st = _stat(name)
        st["calls"] += 1
        try:
            out = fn(**task.get("kwargs", {}))
        except Exception as exc:  # 异常逃逸 → Implementation Defect
            st["labels"][LABEL_DEFECT] += 1
            st["reasons"].append(f"异常逃逸: {type(exc).__name__}: {exc}")
            results.append({"id": task.get("id"), "success": False, "reason": f"defect: {exc}"})
            continue
        if isinstance(out, dict) and out.get("status") is True:
            st["labels"][LABEL_OPTIMAL] += 1
            st["success"] += 1
            ok = expect
        elif isinstance(out, dict) and out.get("status") is False:
            st["labels"][LABEL_NEGATIVE] += 1
            st["reasons"].append(str(out.get("content", {}))[:120])
            ok = not expect
        else:
            st["labels"][LABEL_NEUTRALITY] += 1
            st["reasons"].append("返回结构不规范（无 status 字段）")
            ok = False
        results.append({"id": task.get("id"), "success": bool(ok), "reason": ""})
    return results, stats


# ---------------------------------------------------------------------------
# 生命周期主类
# ---------------------------------------------------------------------------


class SopLifecycle:
    """EvoSOP 四模块闭环：构造—合并—评估—剪枝 + checkpoint 选优。"""

    def __init__(
        self,
        store: SkillStore,
        llm: LLMClient,
        tools: dict[str, Callable[..., Any]],
        tool_docs: dict[str, str],
        function_guidance: str = "函数必须是自包含的，仅通过参数接收输入，原子工具以全局名直接调用。",
        config: SopConfig | None = None,
        reexecute: Callable | None = None,
    ) -> None:
        self.store = store
        self.llm = llm
        self.tools = tools
        self.tool_docs = tool_docs
        self.guidance = function_guidance
        self.cfg = config or SopConfig()
        self.rng = random.Random(self.cfg.seed)
        # reexecute(tasks, sops, tools) -> (results, stats)；默认内置沙箱执行器
        self.reexecute = reexecute or default_reexecute

    # ---- Module 1: CONSTRUCTOR --------------------------------------------

    def constructor_extract(self, traj: list[dict]) -> list[list[int]]:
        """f_extract：从轨迹识别 2-5 个共现原子动作段（message_number 列表）。"""
        raw = self.llm.chat(prompts.sop_extract_prompt(traj, self.tool_docs))
        try:
            segments = extract_pylist(raw)
        except ParseError:
            return []
        valid: list[list[int]] = []
        msg_ids = {c.get("message_number") for c in traj}
        for seg in segments:
            if isinstance(seg, list) and 2 <= len(seg) <= 5 and all(isinstance(x, int) for x in seg):
                if all(x in msg_ids for x in seg):
                    valid.append(seg)
        return valid

    def constructor_rewrite(self, traj: list[dict], segment: list[int], epoch: int) -> dict | None:
        """f_rewrite：函数化改写 + 静态检查 + 注册（同名去重）。"""
        by_msg = {c.get("message_number"): c for c in traj}
        calls = [by_msg[m] for m in segment if m in by_msg]
        if len(calls) < 2:
            return None
        raw = self.llm.chat(
            prompts.sop_rewrite_prompt(calls, self.tool_docs, self.guidance)
        )
        code = extract_code(raw)
        ok, reason, name, doc, used = static_check(code, set(self.tools))
        if not ok:
            return None
        schema = schema_from_code(code)
        sop_id = self.store.add_sop(
            name=name,
            code=code,
            docstring=doc,
            schema=schema,
            tools=used,
            epoch_created=epoch,
            source_trace=json_dumps_short(traj),
        )
        if sop_id is None:
            return None  # 同名已存在
        return {"id": sop_id, "name": name, "code": code, "docstring": doc, "tools": used, "schema": schema}

    # ---- Module 2: MERGER（非破坏性） --------------------------------------

    def merger(self, epoch: int) -> list[dict]:
        active = self.store.get_sops("active")
        if len(active) < 2:
            return []
        data = llm_json(self.llm, prompts.merger_prompt(active))
        merged: list[dict] = []
        for m in data.get("merges", []):
            sop = m.get("sop", {})
            code = sop.get("code", "")
            ok, reason, name, doc, used = static_check(code, set(self.tools))
            if not ok:
                continue
            sop_id = self.store.add_sop(
                name=name,
                code=code,
                docstring=doc,
                schema=schema_from_code(code),
                tools=used,
                epoch_created=epoch,
                merged_from=",".join(m.get("members", [])),
            )
            if sop_id is not None:
                merged.append({"id": sop_id, "name": name, "members": m.get("members", [])})
        return merged

    # ---- Module 3: EVALUATOR（抽样 30-50% 重执行） -------------------------

    def evaluator(self, epoch: int, train_tasks: list[dict], new_sop_names: set[str]) -> EpochReport:
        active = self.store.get_sops("active")
        # 训练集抽样：ratio ∈ [0.3, 0.5]，被新 SOP 覆盖的任务必抽
        must = [t for t in train_tasks if t.get("sop") in new_sop_names]
        rest = [t for t in train_tasks if t not in must]
        k = max(len(must), min(len(train_tasks), round(len(train_tasks) * self.cfg.sample_ratio)))
        extra = self.rng.sample(rest, min(len(rest), k - len(must))) if k > len(must) else []
        sampled = must + extra

        results, stats = self.reexecute(sampled, active, self.tools)
        # 评审记录入库（⊕ 聚合）
        by_name = {s["name"]: s for s in active}
        for name, st in stats.items():
            sop = by_name.get(name)
            if sop:
                self.store.add_sop_review(
                    sop["id"], epoch, st["calls"], st["success"], st["labels"],
                    reason="; ".join(st["reasons"][:3]),
                )
        passed = sum(1 for r in results if r.get("success"))
        return EpochReport(
            epoch=epoch,
            tasks_attempted=len(sampled),
            tasks_passed=passed,
            success_rate=(passed / len(sampled)) if sampled else 0.0,
        )

    # ---- Module 4: REVIEWER（确定性阈值规则 + LLM 兜底） --------------------

    def reviewer(self, epoch: int) -> list[dict]:
        pruned: list[dict] = []
        for sop in self.store.get_sops("active"):
            stats = self.store.sop_stats(sop["id"])
            reason = ""
            # 规则 1：调用 ≥min_calls 且缺陷率 > 0.5 → remove
            if stats["calls"] >= self.cfg.min_calls and stats["defect_rate"] > self.cfg.defect_prune:
                reason = f"Implementation Defect 率 {stats['defect_rate']:.2f} > {self.cfg.defect_prune}"
            # 规则 2：连续 N epoch 零调用 → remove（从 SOP 创建 epoch 起算）
            elif (
                self.store.consecutive_zero_call_epochs(sop["id"], epoch, sop.get("epoch_created", 0))
                >= self.cfg.zero_call_epochs
            ):
                reason = f"连续 {self.cfg.zero_call_epochs} 个 epoch 零调用"
            else:
                # LLM 兜底裁决
                data = llm_json(self.llm, prompts.reviewer_prompt(sop, stats))
                if data.get("decision") == "remove":
                    reason = f"LLM 裁决: {data.get('reason', '')}"
            if reason:
                self.store.prune_sop(sop["id"], epoch)
                pruned.append({"name": sop["name"], "reason": reason})
        return pruned

    # ---- 主循环（Algorithm 1） ---------------------------------------------

    def run(self, trajectories: list[list[dict]], train_tasks: list[dict]) -> dict:
        reports: list[EpochReport] = []
        for epoch in range(self.cfg.epochs):
            rep = EpochReport(epoch=epoch)
            new_names: set[str] = set()
            # 阶段 1：CONSTRUCTOR（仅前 construct_epochs 个 epoch 引入新 SOP）
            if epoch < self.cfg.construct_epochs:
                start = epoch * self.cfg.batch_size
                batch = trajectories[start : start + self.cfg.batch_size]
                for traj in batch:
                    for seg in self.constructor_extract(traj):
                        sop = self.constructor_rewrite(traj, seg, epoch)
                        if sop:
                            rep.new_sops.append(sop["name"])
                            new_names.add(sop["name"])
            # 阶段 2：MERGER（非破坏性合并；工具数超上限则跳过新增）
            if len(self.store.get_sops("active")) < self.cfg.tool_limit:
                for m in self.merger(epoch):
                    rep.merged_sops.append(m["name"])
                    new_names.add(m["name"])
            # 阶段 3：EVALUATOR（抽样重执行）
            eval_rep = self.evaluator(epoch, train_tasks, new_names)
            rep.tasks_attempted = eval_rep.tasks_attempted
            rep.tasks_passed = eval_rep.tasks_passed
            rep.success_rate = eval_rep.success_rate
            # 阶段 4：REVIEWER（确定性规则 + LLM 兜底）
            rep.pruned = self.reviewer(epoch)
            # Checkpoint：归档当前工具集快照
            active = self.store.get_sops("active")
            rep.active_sops = [s["name"] for s in active]
            self.store.save_checkpoint(
                epoch,
                rep.success_rate,
                [
                    {"name": s["name"], "code": s["code"], "docstring": s["docstring"], "schema": s["schema"]}
                    for s in active
                ],
            )
            reports.append(rep)
        best = self.store.best_checkpoint() or {}
        return {
            "epochs": [r.__dict__ for r in reports],
            "best_epoch": best.get("epoch"),
            "best_success_rate": best.get("success_rate"),
            "final_active": [s["name"] for s in self.store.get_sops("active")],
        }


def json_dumps_short(traj: list[dict], limit: int = 300) -> str:
    import json

    return json.dumps(traj, ensure_ascii=False)[:limit]
