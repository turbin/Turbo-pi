"""TOML configuration loading with fail-fast validation.

Unknown fields and missing required fields raise ConfigError at startup.
"""

import re
import tomllib
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

DEFAULT_OMLX_BASE_URL = "http://127.0.0.1:8000/v1"


class ConfigError(Exception):
    """Raised when the configuration file is invalid."""


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ServerConfig(StrictModel):
    host: str
    port: int
    admin_key_env: str
    single_worker_lock: str
    # SSE comment heartbeat interval while waiting for the upstream result.
    sse_heartbeat_seconds: float = Field(default=15.0, gt=0)


class DatabaseConfig(StrictModel):
    url: str


class LocalOmlxConfig(StrictModel):
    base_url: str = DEFAULT_OMLX_BASE_URL
    model: str
    timeout_seconds: int = Field(default=120, gt=0)
    concurrency: int = Field(default=1, ge=1)


class CloudProviderConfig(StrictModel):
    enabled: bool
    base_url_env: str | None = None
    api_key_env: str | None = None
    model_env: str | None = None


class CloudConfig(StrictModel):
    kimi: CloudProviderConfig
    deepseek: CloudProviderConfig
    # Estimated cost reserved before any cloud egress; reconciled to actual
    # usage after the run (plan 5.4).
    reserve_micro_usd: int = Field(default=100_000, gt=0)


class RoutingConfig(StrictModel):
    cloud_egress_default: bool = False
    selected_cloud_provider: Literal["kimi", "deepseek"]
    automatic_transport_retries: int = 0


class MemoryIndexConfig(StrictModel):
    provider: Literal["disabled", "local", "mem0", "gbrain"]
    enabled: bool
    write_async: bool
    read_timeout_ms: int
    max_hits: int


class ChannelConfig(StrictModel):
    key: str
    client_id: str
    workspace_id: str
    channel_id: str
    allowed_models: list[str]
    cloud_egress_allowed: bool = False
    # Per-(channel, month) cloud spend cap; None means uncapped.
    monthly_budget_micro_usd: int | None = None


class SecurityConfig(StrictModel):
    # Extra DLP secret patterns (name -> regex) merged over the built-in
    # defaults; scanned over the outbound envelope before any cloud egress.
    dlp_patterns: dict[str, str] = Field(default_factory=dict)

    @field_validator("dlp_patterns")
    @classmethod
    def _compile_patterns(cls, value: dict[str, str]) -> dict[str, str]:
        for name, pattern in value.items():
            try:
                re.compile(pattern)
            except re.error as exc:
                raise ValueError(f"invalid dlp pattern '{name}': {exc}") from exc
        return value


class GatewayConfig(StrictModel):
    server: ServerConfig
    database: DatabaseConfig
    local_omlx: LocalOmlxConfig
    cloud: CloudConfig
    routing: RoutingConfig
    memory_index: MemoryIndexConfig
    security: SecurityConfig = Field(default_factory=SecurityConfig)
    channels: list[ChannelConfig]


def load_config(path: str | Path) -> GatewayConfig:
    """Load and validate a TOML config file, failing fast on any error."""
    config_path = Path(path)
    try:
        raw = tomllib.loads(config_path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise ConfigError(f"cannot read config file {config_path}: {exc}") from exc
    except tomllib.TOMLDecodeError as exc:
        raise ConfigError(f"invalid TOML in {config_path}: {exc}") from exc
    try:
        return GatewayConfig.model_validate(raw)
    except ValidationError as exc:
        details = "; ".join(
            f"{'.'.join(str(part) for part in err['loc'])}: {err['msg']}" for err in exc.errors()
        )
        raise ConfigError(f"invalid config {config_path}: {details}") from exc
