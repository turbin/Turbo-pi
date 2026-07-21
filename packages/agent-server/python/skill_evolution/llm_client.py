"""LLM 抽象层：LLMClient 协议 + OpenAICompatClient + MockLLM。

所有 LLM 调用必须经此层，业务代码禁止散落 HTTP 调用。

- OpenAICompatClient：纯 urllib 调 OpenAI 兼容 ``/chat/completions``，
  配置走环境变量 ``LLM_BASE_URL`` / ``LLM_API_KEY`` / ``LLM_MODEL`` / ``TEACHER_MODEL``，
  额外关键字参数（含 vLLM 的 ``prompt_logprobs`` 扩展）原样透传进请求体。
- MockLLM：脚本化规则响应，确定性，供离线测试与 demo。
  按 system 消息中的 ``[MARKER]`` 标记路由到内置规则处理器，
  并支持 ``overrides`` 注入自定义响应队列（FIFO 消费）。
"""
from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from typing import Any, Callable, Protocol


class LLMError(RuntimeError):
    """LLM 调用失败（网络错误 / 非 2xx 响应 / 响应结构异常）。"""


class LLMClient(Protocol):
    """统一的 LLM 调用协议。

    chat(messages, **kw) -> str
    chat_with_logprobs(messages, top_logprobs) -> (str, logprobs)
    """

    def chat(self, messages: list[dict], **kw: Any) -> str:  # pragma: no cover - 协议声明
        ...

    def chat_with_logprobs(
        self, messages: list[dict], top_logprobs: int = 5, **kw: Any
    ) -> tuple[str, Any]:  # pragma: no cover - 协议声明
        ...


# ---------------------------------------------------------------------------
# OpenAI 兼容客户端
# ---------------------------------------------------------------------------


class OpenAICompatClient:
    """OpenAI 兼容 /chat/completions 客户端（纯 urllib，零第三方依赖）。

    role="teacher" 时优先取 TEACHER_MODEL，否则取 LLM_MODEL；
    role="student" 取 LLM_MODEL。其余配置读 LLM_BASE_URL / LLM_API_KEY。
    **kw 中的额外参数（temperature、response_format、logprobs、
    top_logprobs、prompt_logprobs 等）全部透传进请求体。
    """

    def __init__(
        self,
        role: str = "teacher",
        base_url: str | None = None,
        api_key: str | None = None,
        model: str | None = None,
        timeout: float = 120.0,
    ) -> None:
        self.base_url = (base_url or os.environ.get("LLM_BASE_URL") or "https://api.openai.com/v1").rstrip("/")
        self.api_key = api_key if api_key is not None else os.environ.get("LLM_API_KEY", "")
        if model:
            self.model = model
        elif role == "teacher":
            self.model = os.environ.get("TEACHER_MODEL") or os.environ.get("LLM_MODEL", "")
        else:
            self.model = os.environ.get("LLM_MODEL", "")
        if not self.model:
            raise LLMError("未配置模型名：请设置 LLM_MODEL / TEACHER_MODEL 或显式传 model")
        self.role = role
        self.timeout = timeout

    # -- 内部 ---------------------------------------------------------------

    def _build_body(self, messages: list[dict], **kw: Any) -> dict:
        body = {"model": self.model, "messages": messages}
        body.update(kw)  # vLLM prompt_logprobs 等扩展参数在此透传
        return body

    def _post(self, body: dict) -> dict:
        req = urllib.request.Request(
            url=f"{self.base_url}/chat/completions",
            data=json.dumps(body).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.api_key}",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:  # 服务端返回非 2xx
            snippet = ""
            try:
                snippet = exc.read().decode("utf-8")[:300]
            except Exception:  # pragma: no cover - 防御性
                pass
            raise LLMError(f"HTTP {exc.code}: {snippet}") from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise LLMError(f"网络错误: {exc}") from exc

    # -- 协议实现 -----------------------------------------------------------

    def chat(self, messages: list[dict], **kw: Any) -> str:
        data = self._post(self._build_body(messages, **kw))
        try:
            return data["choices"][0]["message"]["content"] or ""
        except (KeyError, IndexError, TypeError) as exc:
            raise LLMError(f"响应结构异常: {str(data)[:300]}") from exc

    def chat_with_logprobs(
        self, messages: list[dict], top_logprobs: int = 5, **kw: Any
    ) -> tuple[str, Any]:
        # OpenAI 风格：logprobs=True + top_logprobs=N；
        # vLLM 风格：调用方可在 kw 里传 prompt_logprobs=N，原样透传。
        kw.setdefault("logprobs", True)
        kw.setdefault("top_logprobs", top_logprobs)
        data = self._post(self._build_body(messages, **kw))
        try:
            choice = data["choices"][0]
            content = choice["message"]["content"] or ""
        except (KeyError, IndexError, TypeError) as exc:
            raise LLMError(f"响应结构异常: {str(data)[:300]}") from exc
        logprobs = {
            "content": choice.get("logprobs"),
            "prompt_logprobs": choice.get("prompt_logprobs"),
        }
        return content, logprobs


# ---------------------------------------------------------------------------
# MockLLM：确定性脚本化响应
# ---------------------------------------------------------------------------

_MARKER_RE = re.compile(r"\[([A-Z_]+)([^\]]*)\]")
_PARAM_RE = re.compile(r"(\w+)=(\S+)")


def _block(text: str, name: str) -> str | None:
    """从消息文本中提取 <<<NAME ... >>> 包裹的内容块。"""
    m = re.search(r"<<<" + re.escape(name) + r"\n(.*?)\n>>>", text, re.S)
    return m.group(1) if m else None


def _json_block(text: str, name: str) -> Any:
    raw = _block(text, name)
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


class MockLLM:
    """确定性 Mock LLM：按 system 消息中的 [MARKER] 路由到规则处理器。

    - overrides: {marker: [resp1, resp2, ...]}，命中时按 FIFO 弹出，优先于内置规则。
    - call_counts: 各 marker 被调用次数（测试/演示用）。
    - 所有处理器均为纯函数式规则，相同输入必得相同输出。
    """

    def __init__(self, overrides: dict[str, list[str]] | None = None, seed: int = 0) -> None:
        self.overrides: dict[str, list[str]] = {k: list(v) for k, v in (overrides or {}).items()}
        self.seed = seed
        self.call_counts: dict[str, int] = {}
        self._handlers: dict[str, Callable[[str, str, dict[str, str]], str]] = {
            "ANALYZER": self._h_analyzer,
            "ANALYZER_META": self._h_analyzer_meta,
            "PROPOSER": self._h_proposer,
            "PROPOSER_META": self._h_proposer_meta,
            "EVOLVER": self._h_evolver,
            "ALLOCATOR": self._h_allocator,
            "SOP_EXTRACT": self._h_sop_extract,
            "SOP_REWRITE": self._h_sop_rewrite,
            "MERGER": self._h_merger,
            "REVIEWER": self._h_reviewer,
            "REPAIR": self._h_repair,
        }

    # -- 协议实现 -----------------------------------------------------------

    def chat(self, messages: list[dict], **kw: Any) -> str:
        system = next((m.get("content", "") for m in messages if m.get("role") == "system"), "")
        user = "\n".join(m.get("content", "") for m in messages if m.get("role") == "user")
        marker, params = self._route(system)
        self.call_counts[marker] = self.call_counts.get(marker, 0) + 1
        if marker in self.overrides and self.overrides[marker]:
            return self.overrides[marker].pop(0)
        handler = self._handlers.get(marker, self._h_default)
        return handler(system, user, params)

    def chat_with_logprobs(
        self, messages: list[dict], top_logprobs: int = 5, **kw: Any
    ) -> tuple[str, Any]:
        text = self.chat(messages, **kw)
        # 伪造确定性的 token 级 logprobs，仅用于接口联调
        fake = [
            {"token": tok, "logprob": -0.01, "top_logprobs": []}
            for tok in text.split()[:20]
        ]
        return text, {"content": {"content": fake}, "prompt_logprobs": None}

    # -- 路由 ---------------------------------------------------------------

    @staticmethod
    def _route(system: str) -> tuple[str, dict[str, str]]:
        m = _MARKER_RE.search(system or "")
        if not m:
            return "DEFAULT", {}
        params = dict(_PARAM_RE.findall(m.group(2) or ""))
        return m.group(1), params

    # -- 通用小工具 ----------------------------------------------------------

    @staticmethod
    def _extract_concept(failure: dict) -> str:
        """从失败样本中提取知识点标记（demo 任务集的样本自带 concept 字段）。"""
        if failure.get("concept"):
            return str(failure["concept"])
        q = str(failure.get("question", ""))
        m = re.search(r"知识点[:：]\s*([A-Za-z0-9_一-鿿]+)", q)
        return m.group(1) if m else "通用流程"

    # -- 内置规则处理器 ------------------------------------------------------

    def _h_default(self, system: str, user: str, params: dict[str, str]) -> str:
        return "{}"

    def _h_analyzer(self, system: str, user: str, params: dict[str, str]) -> str:
        """任务失败诊断：区分『skill 可解决失败』与『基座能力上限』。"""
        failure = _json_block(user, "FAILURE") or {}
        if not failure.get("solvable", True):
            return json.dumps(
                {
                    "tag": "基座能力上限：需要模型外部实时信息",
                    "analysis": "该失败要求获取基座模型不具备的外部信息，"
                    "修改 skill 文本无法解决，属于基座能力上限。",
                    "failure_class": "capability_limit",
                    "target_skill": "",
                    "concept": "",
                },
                ensure_ascii=False,
            )
        concept = self._extract_concept(failure)
        return json.dumps(
            {
                "tag": f"缺少{concept}处理流程",
                "analysis": f"失败样本显示 agent 未按标准步骤处理 {concept}，"
                "属于 skill 可解决的流程缺失问题。",
                "failure_class": "skill_fixable",
                "target_skill": "SKILL.md",
                "concept": concept,
            },
            ensure_ascii=False,
        )

    def _h_analyzer_meta(self, system: str, user: str, params: dict[str, str]) -> str:
        """meta 失败诊断：点名最受牵连的 meta 组件。"""
        trace = _json_block(user, "META_TRACE") or {}
        p_hat = float(trace.get("p_hat", 0.0))
        if p_hat <= 0.01:
            target, tag = "pi", "编辑提案停滞：近期编辑未产生正增益"
        else:
            target, tag = "psi", "诊断词表待更新：近期失败 tag 分布漂移"
        return json.dumps(
            {
                "tag": tag,
                "analysis": f"最近窗口 P̂={p_hat:.3f}，最受牵连组件判定为 {target}。",
                "failure_class": "skill_fixable",
                "target_component": target,
            },
            ensure_ascii=False,
        )

    def _h_proposer(self, system: str, user: str, params: dict[str, str]) -> str:
        """编辑提案：产出 (target_section, change, rationale, replacement)。"""
        analysis = _json_block(user, "ANALYSIS") or {}
        concept = analysis.get("concept") or "通用流程"
        k = int(params.get("k", "1"))
        if k > 1:
            replacement = (
                f"### {concept} 检查清单（备选角度）\n"
                f"- [ ] 识别输入中的 {concept} 要素；\n"
                f"- [ ] 按清单逐项处理 {concept}；\n"
                f"- [ ] 输出前复核 {concept} 结果。\n"
            )
            change = f"以检查清单形式补充 {concept} 处理要点（多样性角度 {k}）"
        else:
            replacement = (
                f"### {concept} 处理流程\n"
                f"1. 识别输入中的 {concept} 要素；\n"
                f"2. 按标准步骤处理 {concept}；\n"
                f"3. 输出前复核 {concept} 结果。\n"
            )
            change = f"新增 {concept} 的标准处理步骤"
        return json.dumps(
            {
                "target_section": "处理流程",
                "change": change,
                "rationale": f"诊断表明失败根因是缺少 {concept} 流程，补充该节可直接覆盖失败样本。",
                "replacement": replacement,
            },
            ensure_ascii=False,
        )

    def _h_proposer_meta(self, system: str, user: str, params: dict[str, str]) -> str:
        """meta-skill 编辑提案：whole-m 重写时逐组件给出修订。"""
        target = params.get("tgt", "psi")
        trace = _json_block(user, "META_TRACE") or {}
        tags = "、".join({w.get("tag", "") for w in trace.get("window", []) if w.get("tag")}) or "（无）"
        it = trace.get("iteration", 0)
        replacement = (
            f"（第 {it} 轮 slow loop 修订）近期失败 tag 集合：{tags}。"
            f"本组件（{target}）策略增补：诊断/检索/提案时优先对齐上述 tag 词表，"
            f"保持与其余四组件的一致性。"
        )
        return json.dumps(
            {
                "target_section": "策略要点",
                "change": f"根据 meta 诊断更新 {target} 组件策略",
                "rationale": "whole-m rewrite：保持跨组件一致性。",
                "replacement": replacement,
            },
            ensure_ascii=False,
        )

    def _h_evolver(self, system: str, user: str, params: dict[str, str]) -> str:
        """编辑落实：把提案的 replacement 拼接入当前文件（确定性 splice）。"""
        from .skillfile import replace_section  # 延迟导入避免环

        current = _block(user, "CURRENT") or ""
        proposal = _json_block(user, "PROPOSAL") or {}
        section = proposal.get("target_section", "")
        replacement = proposal.get("replacement", "")
        if not section or not replacement:
            return json.dumps({"new_content": current, "notes": "空提案，未改动"}, ensure_ascii=False)
        new_content = replace_section(current, section, replacement)
        return json.dumps({"new_content": new_content, "notes": "mock splice 完成"}, ensure_ascii=False)

    def _h_allocator(self, system: str, user: str, params: dict[str, str]) -> str:
        """Allocator 的 LLM 模式兜底（默认走规则，此处仅演示接口）。"""
        hist = _json_block(user, "HISTORY") or {}
        recent = [float(x) for x in hist.get("recent_delta_us", [])[-3:]]
        k_max = int(hist.get("k_max", 3))
        if not recent or (sum(recent) / len(recent)) <= 0.01:
            k = k_max
        else:
            k = 1
        return json.dumps({"K": k, "rationale": "mock 规则：停滞扩、产效缩"}, ensure_ascii=False)

    # ---- EvoSOP 相关处理器 -------------------------------------------------

    def _h_sop_extract(self, system: str, user: str, params: dict[str, str]) -> str:
        """日志选段：找 2-5 个连续且以 {prev} 数据流关联的 tool_call 段。"""
        traj = _json_block(user, "TRAJ") or []
        calls = [c for c in traj if isinstance(c, dict) and c.get("tool")]
        segments: list[list[int]] = []
        run: list[dict] = []
        for call in calls:
            linked = run and "{prev}" in json.dumps(call.get("arguments", {}), ensure_ascii=False)
            if not run or linked:
                run.append(call)
            else:
                if len(run) >= 2:
                    segments.append([c["message_number"] for c in run[:5]])
                run = [call]
        if len(run) >= 2:
            segments.append([c["message_number"] for c in run[:5]])
        segments = [s for s in segments if 2 <= len(s) <= 5][:2]
        return json.dumps(segments, ensure_ascii=False)

    def _h_sop_rewrite(self, system: str, user: str, params: dict[str, str]) -> str:
        """函数化改写：把选段改写为带分支/错误处理的 Python SOP。"""
        seg = _json_block(user, "SEGMENT") or {}
        calls = seg.get("calls", [])
        if len(calls) < 2:
            return "# 无有效选段"
        tools = [c["tool"] for c in calls]
        name = "_".join(tools)[:48] + "_sop"
        # 参数：首个调用中未引用 {prev} 的参数名
        first_args = calls[0].get("arguments", {})
        arg_names = [k for k, v in first_args.items() if "{prev}" not in str(v)] or ["payload"]
        sig = ", ".join(f"{a}: str" for a in arg_names)
        defect = "legacy_lookup" in tools  # 演示用：构造缺陷 SOP（异常逃逸 → Implementation Defect）

        steps_doc = "\n    ".join(f"{i + 1}. 调用 {t}；" for i, t in enumerate(tools))
        args_doc = "\n".join(f"        {a} (str): 输入参数。" for a in arg_names)
        body_lines: list[str] = []
        for i, call in enumerate(calls):
            tool = call["tool"]
            if defect and i == 0:
                tool = tool + "p"  # 缺陷：拼写错误的名字 → 调用时 NameError
            kwargs = []
            for k, v in call.get("arguments", {}).items():
                if "{prev}" in str(v) and i > 0:
                    kwargs.append(f"{k}=r{i}")
                elif k in arg_names:
                    kwargs.append(f"{k}={k}")
                else:
                    kwargs.append(f"{k}={v!r}")
            body_lines.append(f"r{i + 1} = {tool}({', '.join(kwargs)})")
        content_keys = ", ".join(f'"r{i + 1}": r{i + 1}' for i in range(len(calls)))
        ret = f'return {{"status": True, "content": {{{content_keys}}}}}'
        indent = "        " if not defect else "    "
        body = "\n".join(indent + line for line in body_lines)
        if defect:
            code = (
                f'def {name}({sig}) -> dict:\n'
                f'    """按序执行 {" → ".join(tools)} 的标准流程。\n\n'
                f'    This function performs the following steps:\n    {steps_doc}\n\n'
                f'    Args:\n{args_doc}\n\n'
                f'    Returns:\n        dict: {{"status": bool, "content": dict}}，'
                f'content 含中间结果 r1..r{len(calls)}。\n\n'
                f'    使用的 tool_call（按序）: {", ".join(tools)}\n    """\n'
                f'{body}\n'
                f'    {ret}\n'
            )
        else:
            code = (
                f'def {name}({sig}) -> dict:\n'
                f'    """按序执行 {" → ".join(tools)} 的标准流程。\n\n'
                f'    This function performs the following steps:\n    {steps_doc}\n\n'
                f'    Args:\n{args_doc}\n\n'
                f'    Returns:\n        dict: {{"status": bool, "content": dict}}，'
                f'content 含中间结果 r1..r{len(calls)}；异常时 status=False 且 content 含 error。\n\n'
                f'    使用的 tool_call（按序）: {", ".join(tools)}\n    """\n'
                f'    import traceback\n'
                f'    try:\n'
                f'{body}\n'
                f'        {ret}\n'
                f'    except Exception as exc:\n'
                f'        return {{"status": False, "content": {{"error": str(exc), '
                f'"traceback": traceback.format_exc()}}}}\n'
            )
        return code

    def _h_merger(self, system: str, user: str, params: dict[str, str]) -> str:
        """合并：共享 ≥2 个原子工具的 SOP 合成一个更泛化的复合 SOP。"""
        sops = _json_block(user, "SOPS") or []
        merges: list[dict] = []
        used: set[str] = set()
        for i in range(len(sops)):
            for j in range(i + 1, len(sops)):
                a, b = sops[i], sops[j]
                if a["name"] in used or b["name"] in used:
                    continue
                shared = set(a.get("tools", [])) & set(b.get("tools", []))
                if len(shared) >= 2:
                    union = list(dict.fromkeys(a.get("tools", []) + b.get("tools", [])))
                    merged_name = "merged_" + "_".join(sorted([a["name"], b["name"]]))[:40]
                    code = self._gen_merged_code(merged_name, union)
                    merges.append(
                        {
                            "members": [a["name"], b["name"]],
                            "sop": {
                                "name": merged_name,
                                "code": code,
                                "docstring": f"复合 SOP：合并 {a['name']} 与 {b['name']}，按序调用 {', '.join(union)}。",
                                "tools": union,
                            },
                            "rationale": f"共享原子工具 {sorted(shared)}，功能高度重叠。",
                        }
                    )
                    used.update([a["name"], b["name"]])
        return json.dumps({"merges": merges}, ensure_ascii=False)

    @staticmethod
    def _gen_merged_code(name: str, tools: list[str]) -> str:
        body = "\n".join(
            f"        r{i + 1} = {t}(payload=r{i})" if i else f"        r1 = {t}(payload=payload)"
            for i, t in enumerate(tools)
        )
        steps_doc = "\n    ".join(f"{i + 1}. 调用 {t}；" for i, t in enumerate(tools))
        content_keys = ", ".join(f'"r{i + 1}": r{i + 1}' for i in range(len(tools)))
        return (
            f'def {name}(payload: str) -> dict:\n'
            f'    """复合 SOP：按序执行 {" → ".join(tools)}。\n\n'
            f'    This function performs the following steps:\n    {steps_doc}\n\n'
            f'    Args:\n        payload (str): 输入内容。\n\n'
            f'    Returns:\n        dict: {{"status": bool, "content": dict}}。\n\n'
            f'    使用的 tool_call（按序）: {", ".join(tools)}\n    """\n'
            f'    import traceback\n'
            f'    try:\n'
            f'{body}\n'
            f'        return {{"status": True, "content": {{{content_keys}}}}}\n'
            f'    except Exception as exc:\n'
            f'        return {{"status": False, "content": {{"error": str(exc), '
            f'"traceback": traceback.format_exc()}}}}\n'
        )

    def _h_reviewer(self, system: str, user: str, params: dict[str, str]) -> str:
        """REVIEWER 的 LLM 兜底：规则无法裁决时默认保留。"""
        return json.dumps({"decision": "retain", "reason": "mock 兜底：指标未见异常"}, ensure_ascii=False)

    def _h_repair(self, system: str, user: str, params: dict[str, str]) -> str:
        """JSON 修复：从坏文本中截取第一个 {...} 或 [...] 块。"""
        broken = _block(user, "BROKEN") or user
        for open_c, close_c in (("{", "}"), ("[", "]")):
            i, j = broken.find(open_c), broken.rfind(close_c)
            if i != -1 and j > i:
                candidate = broken[i : j + 1]
                try:
                    json.loads(candidate)
                    return candidate
                except json.JSONDecodeError:
                    continue
        return "{}"
