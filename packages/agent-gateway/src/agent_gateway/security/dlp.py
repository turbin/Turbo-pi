"""Structured DLP scanning of the outbound envelope (review P0-04).

The scan runs over message text content, tool call arguments, and the
**tool schemas** (T6/台账 3: SOP schemas ride on the tools list — the
parameters JSON they carry leaves the machine in a cloud call just like
message text). Findings identify the pattern name and the structural
location only; matched text is never kept.

默认敏感模式（用户 08-14 裁决 5）：密钥类（AWS key / PEM 私钥 / api_key
赋值）+ 身份证号（18 位）为内置默认；配置化扩充——config.security.dlp_patterns
（name -> regex）追加即生效，无需改码（SecurityConfig 已编译校验）。
"""

import json
import re
from collections.abc import Mapping
from dataclasses import dataclass

from agent_gateway.envelope import AssistantMessage, ChatCompletionEnvelopeV1

DEFAULT_DLP_PATTERNS: dict[str, str] = {
    "aws_access_key_id": r"AKIA[0-9A-Z]{16}",
    "private_key_pem": r"-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----",
    "api_key_assignment": r"(?i)\b(?:api[_-]?key|secret|access[_-]?token)\b\s*[:=]\s*['\"]?[A-Za-z0-9_\-]{20,}",
    # 用户 08-14 裁决 5：身份证号（18 位，末位可为 X）为内置默认敏感模式。
    "chinese_id_number": r"\b\d{17}[\dXx]\b",
}


@dataclass(frozen=True)
class DlpFinding:
    pattern: str
    location: str


def _scan_text(
    text: str, location: str, compiled: list[tuple[str, re.Pattern[str]]]
) -> list[DlpFinding]:
    return [
        DlpFinding(pattern=name, location=location)
        for name, regex in compiled
        if regex.search(text)
    ]


def scan_envelope(
    envelope: ChatCompletionEnvelopeV1, patterns: Mapping[str, str]
) -> list[DlpFinding]:
    """Find configured secret patterns in the outbound envelope.

    覆盖面：消息文本 + assistant tool_call 参数（原有）+ **tools[] schema**
    （T6：function description 与 parameters JSON 序列化文本）。
    """
    compiled = [(name, re.compile(pattern)) for name, pattern in patterns.items()]
    findings: list[DlpFinding] = []
    for index, message in enumerate(envelope.messages):
        content = message.content
        if isinstance(content, str):
            findings.extend(_scan_text(content, f"messages[{index}].content", compiled))
        if isinstance(message, AssistantMessage):
            for call_index, call in enumerate(message.tool_calls or ()):
                findings.extend(
                    _scan_text(
                        call.function.arguments,
                        f"messages[{index}].tool_calls[{call_index}].arguments",
                        compiled,
                    )
                )
    for tool_index, tool in enumerate(envelope.tools or ()):
        fn = tool.function
        if fn.description:
            findings.extend(
                _scan_text(fn.description, f"tools[{tool_index}].function.description", compiled)
            )
        if fn.parameters is not None:
            findings.extend(
                _scan_text(
                    json.dumps(fn.parameters, ensure_ascii=False),
                    f"tools[{tool_index}].function.parameters",
                    compiled,
                )
            )
    return findings
