from pathlib import Path

import pytest

from agent_gateway.config import ConfigError, load_config

VALID_CONFIG = """
[server]
host = "127.0.0.1"
port = 8787
admin_key_env = "AGW_ADMIN_KEY"
single_worker_lock = "./var/agent-gateway.lock"

[database]
url = "sqlite+aiosqlite:///{db_path}"

[local_omlx]
base_url = "http://127.0.0.1:8000/v1"
model = "gemma-4-12b-it-4bit"
timeout_seconds = 120
concurrency = 1

[cloud.kimi]
enabled = true
base_url_env = "KIMI_BASE_URL"
api_key_env = "KIMI_API_KEY"
model_env = "KIMI_MODEL"

[cloud.deepseek]
enabled = false

[routing]
cloud_egress_default = false
selected_cloud_provider = "kimi"
automatic_transport_retries = 0

[memory_index]
provider = "local"
enabled = true
write_async = true
read_timeout_ms = 300
max_hits = 5

[[channels]]
key = "test-key-1"
client_id = "lobsterai"
workspace_id = "ws-a"
channel_id = "ch-a"
allowed_models = ["agent-auto", "agent-local"]
cloud_egress_allowed = false

[[channels]]
key = "test-key-2"
client_id = "lobsterai"
workspace_id = "ws-b"
channel_id = "ch-b"
allowed_models = ["agent-cloud"]
cloud_egress_allowed = true
"""


def write_config(tmp_path: Path, body: str) -> Path:
    path = tmp_path / "config.toml"
    path.write_text(body.format(db_path=tmp_path / "gw.db"), encoding="utf-8")
    return path


def test_load_valid_config(tmp_path: Path) -> None:
    config = load_config(write_config(tmp_path, VALID_CONFIG))
    assert config.server.port == 8787
    assert config.database.url.endswith("gw.db")
    assert config.local_omlx.model == "gemma-4-12b-it-4bit"
    assert config.cloud.kimi.enabled is True
    assert config.cloud.deepseek.enabled is False
    assert config.routing.selected_cloud_provider == "kimi"
    assert config.memory_index.provider == "local"
    assert len(config.channels) == 2
    assert config.channels[0].allowed_models == ["agent-auto", "agent-local"]
    assert config.channels[1].cloud_egress_allowed is True


def test_missing_section_fails(tmp_path: Path) -> None:
    body = VALID_CONFIG.replace('[database]\nurl = "sqlite+aiosqlite:///{db_path}"\n', "")
    with pytest.raises(ConfigError, match="database"):
        load_config(write_config(tmp_path, body))


def test_unknown_field_fails(tmp_path: Path) -> None:
    body = VALID_CONFIG.replace("[server]\n", "[server]\nbogus = 1\n")
    with pytest.raises(ConfigError, match="bogus"):
        load_config(write_config(tmp_path, body))


def test_missing_required_field_fails(tmp_path: Path) -> None:
    body = VALID_CONFIG.replace("port = 8787\n", "")
    with pytest.raises(ConfigError, match="port"):
        load_config(write_config(tmp_path, body))


def test_invalid_memory_provider_fails(tmp_path: Path) -> None:
    body = VALID_CONFIG.replace('provider = "local"', 'provider = "gbrain-plus"')
    with pytest.raises(ConfigError, match="provider"):
        load_config(write_config(tmp_path, body))


def test_invalid_selected_cloud_provider_fails(tmp_path: Path) -> None:
    body = VALID_CONFIG.replace('selected_cloud_provider = "kimi"', 'selected_cloud_provider = "openai"')
    with pytest.raises(ConfigError, match="selected_cloud_provider"):
        load_config(write_config(tmp_path, body))


def test_missing_channels_fails(tmp_path: Path) -> None:
    body = VALID_CONFIG.split("[[channels]]")[0]
    with pytest.raises(ConfigError, match="channels"):
        load_config(write_config(tmp_path, body))
