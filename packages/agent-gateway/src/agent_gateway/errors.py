"""Stable gateway error body and error-code table (review section 5.4).

Every error response has shape: {"error": {"code": ..., "message": ..., "param": ...?}}
"""

ERROR_HTTP_STATUS: dict[str, int] = {
    "unsupported_parameter": 400,
    "invalid_message_sequence": 400,
    "invalid_tool_schema": 400,
    "invalid_api_key": 401,
    "model_not_allowed": 403,
    "cloud_egress_forbidden": 403,
    "idempotency_conflict": 409,
    "request_in_progress": 409,
    "rule_version_conflict": 409,
    "local_quality_rejected": 422,
    "budget_exceeded": 429,
    "queue_overloaded": 429,
    "provider_invalid_response": 502,
    "upstream_unavailable": 502,
    "database_unavailable": 503,
    "not_ready": 503,
    "deadline_exceeded": 504,
}


class GatewayError(Exception):
    def __init__(self, code: str, message: str, param: str | None = None) -> None:
        super().__init__(message)
        if code not in ERROR_HTTP_STATUS:
            raise ValueError(f"unknown gateway error code: {code}")
        self.code = code
        self.message = message
        self.param = param

    @property
    def http_status(self) -> int:
        return ERROR_HTTP_STATUS[self.code]

    def body(self) -> dict:
        error: dict[str, str] = {"code": self.code, "message": self.message}
        if self.param is not None:
            error["param"] = self.param
        return {"error": error}
