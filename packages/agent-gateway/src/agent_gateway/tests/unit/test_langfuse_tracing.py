"""Langfuse tracing (2026-08-19, 9B 跑批监视).

Contract: disabled by default (zero behavior change); when enabled, every
provider call exports one generation whose trace id derives deterministically
from the gateway trace_id (create_trace_id seed), and no Langfuse SDK failure
may break or double-run the provider call.
"""

from pathlib import Path

import pytest

from agent_gateway.config import load_config
from agent_gateway.envelope import ChatCompletionEnvelopeV1
from agent_gateway.errors import GatewayError
from agent_gateway.observability import (
    LangfuseTracedProvider,
    current_trace_id,
    init_langfuse,
)
from agent_gateway.providers.base import ModelResult
from agent_gateway.providers.fake import FakeProvider

from .test_config import VALID_CONFIG, write_config

ENVELOPE = ChatCompletionEnvelopeV1.model_validate(
    {"model": "agent-auto", "messages": [{"role": "user", "content": "hi"}]}
)
RESULT = ModelResult(content="hello", finish_reason="stop", tool_calls=[], prompt_tokens=3, completion_tokens=5, total_tokens=8)


class StubGeneration:
    def __init__(self, *, fail_update: bool = False) -> None:
        self.updates: list[dict] = []
        self._fail_update = fail_update

    def update(self, **fields: object) -> None:
        if self._fail_update:
            raise RuntimeError("sdk update exploded")
        self.updates.append(fields)


class StubSpanCM:
    def __init__(self, generation: StubGeneration) -> None:
        self._generation = generation

    def __enter__(self) -> StubGeneration:
        return self._generation

    def __exit__(self, *exc: object) -> bool:
        return False


class StubClient:
    """Langfuse SDK 同形 stub：记录 start 参数，可注入建 span 失败。"""

    def __init__(self, *, fail_start: bool = False, fail_update: bool = False) -> None:
        self.started: list[dict] = []
        self.seeds: list[str] = []
        self.generation = StubGeneration(fail_update=fail_update)
        self._fail_start = fail_start

    def create_trace_id(self, *, seed: str) -> str:
        self.seeds.append(seed)
        return f"lf-{seed}"

    def start_as_current_observation(self, **kwargs: object) -> StubSpanCM:
        if self._fail_start:
            raise RuntimeError("sdk start exploded")
        self.started.append(kwargs)
        return StubSpanCM(self.generation)


def test_config_langfuse_section_parses(tmp_path: Path) -> None:
    body = VALID_CONFIG + (
        '\n[langfuse]\nenabled = true\nhost = "http://localhost:3000"\n'
        'public_key_env = "LF_PK"\nsecret_key_env = "LF_SK"\nenvironment = "exp-9b"\n'
    )
    config = load_config(write_config(tmp_path, body))
    assert config.langfuse.enabled is True
    assert config.langfuse.host == "http://localhost:3000"
    assert config.langfuse.public_key_env == "LF_PK"
    assert config.langfuse.secret_key_env == "LF_SK"
    assert config.langfuse.environment == "exp-9b"


def test_config_langfuse_defaults_disabled(tmp_path: Path) -> None:
    config = load_config(write_config(tmp_path, VALID_CONFIG))
    assert config.langfuse.enabled is False
    assert config.langfuse.public_key_env == "LANGFUSE_PUBLIC_KEY"


def test_init_langfuse_disabled_by_default() -> None:
    from agent_gateway.config import LangfuseConfig

    # enabled=False -> None 且不读 env
    assert init_langfuse(LangfuseConfig(), environ={}) is None


def test_init_langfuse_enabled_missing_keys_disables() -> None:
    from agent_gateway.config import LangfuseConfig

    cfg = LangfuseConfig(enabled=True)
    assert init_langfuse(cfg, environ={}) is None
    assert init_langfuse(cfg, environ={"LANGFUSE_PUBLIC_KEY": "pk-lf-x"}) is None


def test_init_langfuse_enabled_with_keys() -> None:
    from langfuse import Langfuse

    from agent_gateway.config import LangfuseConfig

    cfg = LangfuseConfig(enabled=True, host="http://localhost:3000")
    client = init_langfuse(
        cfg, environ={"LANGFUSE_PUBLIC_KEY": "pk-lf-x", "LANGFUSE_SECRET_KEY": "sk-lf-x"}
    )
    assert isinstance(client, Langfuse)
    client.shutdown()


async def test_traced_provider_records_generation() -> None:
    inner = FakeProvider([RESULT])
    client = StubClient()
    provider = LangfuseTracedProvider(inner, client=client, provider_name="omlx", model="m-9b")
    current_trace_id.set("chatcmpl-abc")
    try:
        result = await provider.complete(ENVELOPE)
    finally:
        current_trace_id.set(None)
    assert result is RESULT
    assert client.seeds == ["chatcmpl-abc"]
    assert len(client.started) == 1
    start = client.started[0]
    assert start["name"] == "omlx"
    assert start["as_type"] == "generation"
    assert start["model"] == "m-9b"
    assert start["trace_context"]["trace_id"] == "lf-chatcmpl-abc"
    assert start["metadata"]["gateway_trace_id"] == "chatcmpl-abc"
    success_update = client.generation.updates[-1]
    assert success_update["usage_details"] == {"input": 3, "output": 5, "total": 8}
    assert success_update["output"]["finish_reason"] == "stop"


async def test_traced_provider_marks_gateway_error_and_reraises() -> None:
    inner = FakeProvider([GatewayError("upstream_unavailable", "boom")])
    client = StubClient()
    provider = LangfuseTracedProvider(inner, client=client, provider_name="omlx", model="m-9b")
    current_trace_id.set("chatcmpl-err")
    try:
        with pytest.raises(GatewayError, match="boom"):
            await provider.complete(ENVELOPE)
    finally:
        current_trace_id.set(None)
    assert client.generation.updates[-1] == {"level": "ERROR", "status_message": "upstream_unavailable"}


async def test_traced_provider_sdk_start_failure_falls_back_untraced() -> None:
    inner = FakeProvider([RESULT])
    client = StubClient(fail_start=True)
    provider = LangfuseTracedProvider(inner, client=client, provider_name="omlx", model="m-9b")
    current_trace_id.set("chatcmpl-fallback")
    try:
        result = await provider.complete(ENVELOPE)
    finally:
        current_trace_id.set(None)
    assert result is RESULT
    assert len(inner.received) == 1  # 只调一次，不重跑


async def test_traced_provider_without_trace_id_passes_through() -> None:
    inner = FakeProvider([RESULT])
    client = StubClient()
    provider = LangfuseTracedProvider(inner, client=client, provider_name="omlx", model="m-9b")
    current_trace_id.set(None)
    result = await provider.complete(ENVELOPE)
    assert result is RESULT
    assert client.started == []


async def test_traced_provider_update_failure_does_not_break_result() -> None:
    inner = FakeProvider([RESULT])
    client = StubClient(fail_update=True)
    provider = LangfuseTracedProvider(inner, client=client, provider_name="omlx", model="m-9b")
    current_trace_id.set("chatcmpl-update-fail")
    try:
        result = await provider.complete(ENVELOPE)
    finally:
        current_trace_id.set(None)
    assert result is RESULT
