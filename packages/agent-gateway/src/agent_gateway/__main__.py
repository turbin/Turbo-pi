"""Console entry point: `uv run python -m agent_gateway [--config PATH]`.

Loads the TOML config, takes the single-worker file lock (SQLite allows a
single writer, so a second gateway process must refuse to start), then runs
uvicorn on server.host/server.port.
"""

import argparse
import asyncio
import fcntl
import sys
from pathlib import Path
from typing import IO

import uvicorn

from agent_gateway.config import ConfigError, GatewayConfig, load_config
from agent_gateway.main import create_app

DEFAULT_CONFIG_PATH = "./config.toml"


class LockHeldError(Exception):
    """The single-worker lock file is held by another gateway process."""


def acquire_single_worker_lock(path: Path) -> IO[str]:
    """Take an exclusive non-blocking flock; returns the open lock file.

    The caller must keep the returned file open for the process lifetime;
    closing it (or process exit) releases the lock.
    """
    lock_file = path.open("a", encoding="utf-8")
    try:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as exc:
        lock_file.close()
        raise LockHeldError(f"single-worker lock already held: {path}") from exc
    return lock_file


async def _serve(config: GatewayConfig) -> None:
    app = await create_app(config)
    server = uvicorn.Server(uvicorn.Config(app, host=config.server.host, port=config.server.port))
    await server.serve()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="agent-gateway")
    parser.add_argument(
        "--config",
        default=DEFAULT_CONFIG_PATH,
        help=f"path to the TOML config file (default: {DEFAULT_CONFIG_PATH})",
    )
    args = parser.parse_args(argv)

    config_path = Path(args.config)
    if not config_path.is_file():
        print(f"config file not found: {config_path} (pass --config <path>)", file=sys.stderr)
        return 2
    try:
        config = load_config(config_path)
    except ConfigError as exc:
        print(exc, file=sys.stderr)
        return 2

    lock_path = Path(config.server.single_worker_lock)
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    # Kept open for the process lifetime; process exit releases the lock.
    try:
        _lock_file = acquire_single_worker_lock(lock_path)
    except LockHeldError as exc:
        print(exc, file=sys.stderr)
        return 2

    asyncio.run(_serve(config))
    return 0


if __name__ == "__main__":
    sys.exit(main())
