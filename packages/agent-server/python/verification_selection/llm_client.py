"""LLM 抽象层。

所有 LLM 调用必须经由此层，禁止在业务代码中散落 HTTP 调用。

提供：
- ``LLMClient`` 协议：``chat(messages, **kw) -> str`` 与
  ``chat_with_logprobs(messages, top_logprobs) -> (text, logprobs)``；
- ``OpenAICompatClient``：纯 urllib 调 OpenAI 兼容 /chat/completions，
  配置走环境变量 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL / TEACHER_MODEL，
  支持 vLLM 扩展参数（如 prompt_logprobs）顶层透传；
- ``MockLLM``：脚本化规则响应，确定性，供离线测试与 demo。

logprobs 统一为 OpenAI 风格的 per-token 列表：
``[{"token": str, "logprob": float, "top_logprobs": [{"token", "logprob"}, ...]}, ...]``
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable, Protocol, runtime_checkable


class LLMError(RuntimeError):
    """LLM 调用失败（网络错误 / HTTP 错误 / 响应格式不符）。"""


@runtime_checkable
class LLMClient(Protocol):
    """LLM 客户端协议。messages 为 OpenAI chat 格式 [{"role":..., "content":...}]。"""

    def chat(self, messages: list[dict], **kw: Any) -> str:
        """普通对话，返回文本。"""
        ...

    def chat_with_logprobs(self, messages: list[dict], top_logprobs: int = 20,
                           **kw: Any) -> tuple[str, list[dict]]:
        """对话并要求 token 级 logprobs，返回 (文本, logprobs 列表)。"""
        ...


# ---------------------------------------------------------------------------
# OpenAI 兼容客户端（纯 urllib，无第三方依赖）
# ---------------------------------------------------------------------------

class OpenAICompatClient:
    """OpenAI 兼容 /chat/completions 客户端。

    配置优先级：构造参数 > 环境变量 > 默认值。
    环境变量：LLM_BASE_URL、LLM_API_KEY、LLM_MODEL（teacher 用 TEACHER_MODEL）。

    ``**kw`` 中的额外参数（temperature、max_tokens、stop 以及 vLLM 的
    prompt_logprobs 等扩展字段）直接并入请求体顶层；也可用
    ``extra_body={...}`` 批量透传。
    """

    def __init__(self, base_url: str | None = None, api_key: str | None = None,
                 model: str | None = None, *, timeout: float = 120.0):
        self.base_url = (base_url or os.environ.get("LLM_BASE_URL")
                         or "http://localhost:8000/v1").rstrip("/")
        self.api_key = api_key if api_key is not None else os.environ.get("LLM_API_KEY", "")
        self.model = model or os.environ.get("LLM_MODEL") or "default-model"
        self.timeout = timeout

    @classmethod
    def teacher_from_env(cls, **kw: Any) -> "OpenAICompatClient":
        """按 TEACHER_MODEL 环境变量构造大模型客户端（缺省回退 LLM_MODEL）。"""
        kw.setdefault("model", os.environ.get("TEACHER_MODEL") or os.environ.get("LLM_MODEL"))
        return cls(**kw)

    # -- 请求构造 -----------------------------------------------------------
    def build_payload(self, messages: list[dict], **kw: Any) -> dict:
        """构造请求体；extra_body 与其余 kw 均顶层透传（兼容 vLLM 扩展参数）。"""
        payload: dict[str, Any] = {"model": self.model, "messages": messages}
        extra = dict(kw)
        extra_body = extra.pop("extra_body", None)
        payload.update(extra)
        if isinstance(extra_body, dict):
            payload.update(extra_body)
        return payload

    def _post(self, payload: dict) -> dict:
        req = urllib.request.Request(
            self.base_url + "/chat/completions",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.api_key}",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:  # 服务端返回错误状态码
            body = e.read().decode("utf-8", errors="replace")[:500]
            raise LLMError(f"LLM HTTP {e.code}: {body}") from e
        except urllib.error.URLError as e:  # 连接失败
            raise LLMError(f"LLM 连接失败: {e.reason}") from e

    # -- 协议实现 -----------------------------------------------------------
    def chat(self, messages: list[dict], **kw: Any) -> str:
        data = self._post(self.build_payload(messages, **kw))
        return data["choices"][0]["message"].get("content") or ""

    def chat_with_logprobs(self, messages: list[dict], top_logprobs: int = 20,
                           **kw: Any) -> tuple[str, list[dict]]:
        kw["logprobs"] = True
        kw["top_logprobs"] = top_logprobs
        data = self._post(self.build_payload(messages, **kw))
        choice = data["choices"][0]
        text = choice["message"].get("content") or ""
        logprobs = (choice.get("logprobs") or {}).get("content") or []
        return text, logprobs


# ---------------------------------------------------------------------------
# MockLLM：脚本化规则响应（确定性，供离线测试 / demo）
# ---------------------------------------------------------------------------

@dataclass
class MockResponse:
    """Mock 响应：text 必填；logprobs 缺省时由 MockLLM 合成朴素 top-1。"""

    text: str
    logprobs: list[dict] | None = None


# 规则类型：predicate(messages, **kw) -> bool；handler(messages, **kw) -> str | MockResponse
Predicate = Callable[..., bool]
Handler = Callable[..., "str | MockResponse"]


def messages_text(messages: list[dict]) -> str:
    """把 messages 拼成纯文本，供规则匹配。"""
    return "\n".join(f"{m.get('role', '')}: {m.get('content', '')}" for m in messages)


def contains(*subs: str) -> Predicate:
    """构造一个"全部子串命中"的规则断言。"""
    def _pred(messages: list[dict], **kw: Any) -> bool:
        text = messages_text(messages)
        return all(s in text for s in subs)
    return _pred


def _fake_logprobs(text: str) -> list[dict]:
    """为无脚本 logprobs 的 Mock 响应合成朴素 top-1 logprobs（4 字符一个伪 token）。"""
    if not text:
        return [{"token": "", "logprob": 0.0, "top_logprobs": [{"token": "", "logprob": 0.0}]}]
    return [
        {"token": text[i:i + 4], "logprob": -0.001,
         "top_logprobs": [{"token": text[i:i + 4], "logprob": -0.001}]}
        for i in range(0, len(text), 4)
    ]


class MockLLM:
    """脚本化 Mock：按注册顺序匹配规则，全部未命中时返回 default_text。

    完全确定性、零网络，供单元测试与离线 demo 使用。``calls`` 记录全部调用，
    便于断言调用次数（如 reasoning 缓存命中后 teacher 调用数不再增长）。
    """

    def __init__(self, rules: list[tuple[Predicate, Handler]] | None = None,
                 default_text: str = "MOCK", name: str = "mock"):
        self.rules: list[tuple[Predicate, Handler]] = list(rules or [])
        self.default_text = default_text
        self.name = name
        self.calls: list[dict] = []  # {"kind", "messages", "kw"}

    def add_rule(self, predicate: Predicate, handler: Handler) -> "MockLLM":
        self.rules.append((predicate, handler))
        return self

    def _respond(self, kind: str, messages: list[dict], **kw: Any) -> MockResponse:
        self.calls.append({"kind": kind, "messages": messages, "kw": kw})
        for pred, handler in self.rules:
            if pred(messages, **kw):
                out = handler(messages, **kw)
                return out if isinstance(out, MockResponse) else MockResponse(str(out))
        return MockResponse(self.default_text)

    def chat(self, messages: list[dict], **kw: Any) -> str:
        return self._respond("chat", messages, **kw).text

    def chat_with_logprobs(self, messages: list[dict], top_logprobs: int = 20,
                           **kw: Any) -> tuple[str, list[dict]]:
        resp = self._respond("chat_with_logprobs", messages, top_logprobs=top_logprobs, **kw)
        logprobs = resp.logprobs if resp.logprobs is not None else _fake_logprobs(resp.text)
        return resp.text, logprobs
