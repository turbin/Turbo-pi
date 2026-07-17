"""Structured DLP scanning of the outbound envelope (review P0-04).

The scan runs over message text content and tool call arguments — the exact
bytes that would leave the machine in a cloud call. Findings identify the
pattern name and the structural location only; matched text is never kept.
"""

import re
from collections.abc import Mapping
from dataclasses import dataclass

from agent_gateway.envelope import AssistantMessage, ChatCompletionEnvelopeV1

DEFAULT_DLP_PATTERNS: dict[str, str] = {
    "aws_access_key_id": r"AKIA[0-9A-Z]{16}",
    "private_key_pem": r"-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----",
    "api_key_assignment": r"(?i)\b(?:api[_-]?key|secret|access[_-]?token)\b\s*[:=]\s*['\"]?[A-Za-z0-9_\-]{20,}",
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
    """Find configured secret patterns in the outbound envelope."""
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
    return findings
