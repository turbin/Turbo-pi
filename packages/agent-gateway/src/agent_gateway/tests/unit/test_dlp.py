"""Day 5: structured DLP over the outbound envelope (review P0-04)."""

from agent_gateway.envelope import ChatCompletionEnvelopeV1
from agent_gateway.security.dlp import DEFAULT_DLP_PATTERNS, scan_envelope
from agent_gateway.security.redact import redacted_finding_payload


def make_envelope(**overrides: object) -> ChatCompletionEnvelopeV1:
    payload: dict = {
        "model": "agent-auto",
        "messages": [{"role": "user", "content": "你好"}],
    }
    payload.update(overrides)
    return ChatCompletionEnvelopeV1.model_validate(payload)


def test_clean_envelope_has_no_findings() -> None:
    assert scan_envelope(make_envelope(), DEFAULT_DLP_PATTERNS) == []


def test_aws_key_in_user_message_found_with_location() -> None:
    envelope = make_envelope(
        messages=[{"role": "user", "content": "我的 key 是 AKIAIOSFODNN7EXAMPLE 请保管"}]
    )
    findings = scan_envelope(envelope, DEFAULT_DLP_PATTERNS)
    assert [(f.pattern, f.location) for f in findings] == [
        ("aws_access_key_id", "messages[0].content")
    ]


def test_private_key_pem_in_system_message_found() -> None:
    envelope = make_envelope(
        messages=[
            {"role": "system", "content": "-----BEGIN RSA PRIVATE KEY-----\nMIIBOg..."},
            {"role": "user", "content": "hi"},
        ]
    )
    findings = scan_envelope(envelope, DEFAULT_DLP_PATTERNS)
    assert [(f.pattern, f.location) for f in findings] == [
        ("private_key_pem", "messages[0].content")
    ]


def test_api_key_assignment_in_tool_message_found() -> None:
    envelope = make_envelope(
        messages=[
            {"role": "user", "content": "hi"},
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {"name": "get_weather", "arguments": '{"city":"北京"}'},
                    }
                ],
            },
            {
                "role": "tool",
                "tool_call_id": "call_1",
                "content": 'api_key = "sk-abcdefghij1234567890"',
            },
        ]
    )
    findings = scan_envelope(envelope, DEFAULT_DLP_PATTERNS)
    assert [(f.pattern, f.location) for f in findings] == [
        ("api_key_assignment", "messages[2].content")
    ]


def test_secret_in_assistant_tool_call_arguments_found() -> None:
    envelope = make_envelope(
        messages=[
            {"role": "user", "content": "hi"},
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {
                            "name": "get_weather",
                            "arguments": '{"key": "AKIAIOSFODNN7EXAMPLE"}',
                        },
                    }
                ],
            },
        ]
    )
    findings = scan_envelope(envelope, DEFAULT_DLP_PATTERNS)
    assert [(f.pattern, f.location) for f in findings] == [
        ("aws_access_key_id", "messages[1].tool_calls[0].arguments")
    ]


def test_config_patterns_extend_and_override_defaults() -> None:
    envelope = make_envelope(messages=[{"role": "user", "content": "订单号 ORD-998877"}])
    patterns = {**DEFAULT_DLP_PATTERNS, "order_id": r"ORD-[0-9]{6}"}
    findings = scan_envelope(envelope, patterns)
    assert [(f.pattern, f.location) for f in findings] == [
        ("order_id", "messages[0].content")
    ]
    # Defaults still apply alongside config patterns.
    envelope2 = make_envelope(
        messages=[{"role": "user", "content": "AKIAIOSFODNN7EXAMPLE"}]
    )
    assert scan_envelope(envelope2, patterns)[0].pattern == "aws_access_key_id"


def test_redacted_payload_contains_no_matched_text() -> None:
    secret = "AKIAIOSFODNN7EXAMPLE"
    envelope = make_envelope(messages=[{"role": "user", "content": f"key: {secret}"}])
    findings = scan_envelope(envelope, DEFAULT_DLP_PATTERNS)
    payload = redacted_finding_payload(findings)
    assert payload == [{"pattern": "aws_access_key_id", "location": "messages[0].content"}]
    assert secret not in repr(payload)
