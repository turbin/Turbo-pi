"""Redaction helpers for trace and log output.

DLP findings are recorded as pattern name + structural location only; the
matched secret never enters the trace store or logs.
"""

from agent_gateway.security.dlp import DlpFinding


def redacted_finding_payload(findings: list[DlpFinding]) -> list[dict[str, str]]:
    """Trace/log-safe view of DLP findings: pattern name + location only."""
    return [{"pattern": finding.pattern, "location": finding.location} for finding in findings]
