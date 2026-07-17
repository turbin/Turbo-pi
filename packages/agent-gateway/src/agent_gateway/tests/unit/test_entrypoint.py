"""Console entry point (`python -m agent_gateway`): config loading, the
single-worker file lock, and uvicorn wiring.

uvicorn itself is never started; `agent_gateway.__main__.uvicorn.Server` is
replaced with a recorder so the test asserts host/port wiring only.
"""

from pathlib import Path

import pytest

from agent_gateway.__main__ import LockHeldError, acquire_single_worker_lock, main

from .test_config import VALID_CONFIG, write_config


def test_second_lock_acquire_fails_cleanly(tmp_path: Path) -> None:
    lock_path = tmp_path / "gw.lock"
    held = acquire_single_worker_lock(lock_path)
    with pytest.raises(LockHeldError, match="already held"):
        acquire_single_worker_lock(lock_path)
    held.close()


def test_lock_released_when_handle_closed(tmp_path: Path) -> None:
    lock_path = tmp_path / "gw.lock"
    acquire_single_worker_lock(lock_path).close()
    reacquired = acquire_single_worker_lock(lock_path)
    reacquired.close()


def test_main_missing_config_returns_2(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["--config", str(tmp_path / "nope.toml")]) == 2
    assert "config file not found" in capsys.readouterr().err


class FakeServer:
    """Records the uvicorn.Config instead of binding a socket."""

    config: object | None = None

    def __init__(self, config: object) -> None:
        FakeServer.config = config

    async def serve(self) -> None:
        pass


def test_main_loads_config_and_wires_host_port(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    body = VALID_CONFIG.replace(
        'single_worker_lock = "./var/agent-gateway.lock"',
        f'single_worker_lock = "{tmp_path}/gw.lock"',
    )
    config_path = write_config(tmp_path, body)
    monkeypatch.setattr("agent_gateway.__main__.uvicorn.Server", FakeServer)

    assert main(["--config", str(config_path)]) == 0
    server_config = FakeServer.config
    assert server_config is not None
    assert server_config.host == "127.0.0.1"  # type: ignore[attr-defined]
    assert server_config.port == 8787  # type: ignore[attr-defined]
    # The single-worker lock file was taken (and is released on process exit).
    assert (tmp_path / "gw.lock").exists()
