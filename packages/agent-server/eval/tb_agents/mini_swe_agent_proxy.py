"""E2 Terminal-Bench custom agent: MiniSweAgent with configurable endpoint.

Inherits from Terminal-Bench's built-in MiniSweAgent. Overrides _env to:
- Set OPENAI_BASE_URL (driven by host env var OPENAI_BASE_URL — this is how
  the control/experiment arm switch works)
- Set MSWEA_SILENT_STARTUP / MSWEA_COST_TRACKING (E0 non-interactive fixes)
- Pass through HTTPS_PROXY from host (needed for pip/apt in container)

Also overrides perform_task to copy the offline wheelhouse (eval/wheelhouse/)
into the container at /wheelhouse, and overrides the installation script
template (mini-swe-setup.sh.j2 in the same directory) to install offline from
/wheelhouse first, falling back to the Tsinghua PyPI mirror over the network.

Usage:
    # Control arm (agent-server :8790, AGENT_SERVER_INJECTION=off, M8)
    OPENAI_BASE_URL=http://host.docker.internal:8790/v1 OPENAI_API_KEY=<key> \
    tb run -d terminal-bench-core --agent-import-path eval.tb_agents.mini_swe_agent_proxy:MiniSweAgentProxy \
      -m openai/deepseek-v4-flash

    # Experiment arm (via agent-server :8789, injection on)
    OPENAI_BASE_URL=http://host.docker.internal:8789/v1 OPENAI_API_KEY=dummy \
    tb run -d terminal-bench-core --agent-import-path eval.tb_agents.mini_swe_agent_proxy:MiniSweAgentProxy \
      -m openai/deepseek-v4-flash
"""

import logging
import os
from pathlib import Path

from terminal_bench.agents.base_agent import AgentResult
from terminal_bench.agents.installed_agents.mini_swe_agent.mini_swe_agent import MiniSweAgent
from terminal_bench.terminal.tmux_session import TmuxSession

logger = logging.getLogger(__name__)

WHEELHOUSE_DIR = Path(__file__).parent.parent / "wheelhouse"
CONTAINER_WHEELHOUSE_DIR = "/wheelhouse"


class MiniSweAgentProxy(MiniSweAgent):
    """MiniSweAgent with configurable OPENAI_BASE_URL and proxy support."""

    @staticmethod
    def name() -> str:
        return "mini-swe-agent-proxy"

    @property
    def _env(self) -> dict[str, str]:
        # Start with parent's env (MSWEA_CONFIGURED + API key resolution)
        env = super()._env

        # OPENAI_BASE_URL — the arm switch
        base_url = os.environ.get("OPENAI_BASE_URL", "")
        if base_url:
            env["OPENAI_BASE_URL"] = base_url

        # Non-interactive mode fixes (E0 decisions)
        env["MSWEA_SILENT_STARTUP"] = "1"
        env["MSWEA_COST_TRACKING"] = "ignore_errors"

        # Proxy passthrough for container-side pip/apt/LLM calls.
        # NOTE: litellm auto-loads packages/agent-server/.env on import, so
        # HTTPS_PROXY=http://host.docker.internal:7897 leaks into this process
        # even when the shell has proxies unset. That proxy is NOT reachable
        # from inside colima containers (connection refused), while direct
        # egress works. Set TB_CONTAINER_NO_PROXY=1 to skip the passthrough.
        https_proxy = os.environ.get("HTTPS_PROXY", "")
        if https_proxy and os.environ.get("TB_CONTAINER_NO_PROXY", "") != "1":
            env["HTTPS_PROXY"] = https_proxy

        return env

    @property
    def _install_agent_script_path(self) -> Path:
        # Use custom template from this directory (offline wheelhouse first)
        return self._get_templated_script_path("mini-swe-setup.sh.j2")

    def perform_task(
        self,
        instruction: str,
        session: TmuxSession,
        logging_dir: Path | None = None,
    ) -> AgentResult:
        # Copy the offline wheelhouse before the install script runs. The
        # setup script installs mini-swe-agent with --no-index from it, so no
        # container-side network access to PyPI is needed. If the wheelhouse
        # is missing, fall back to network install inside the script.
        if WHEELHOUSE_DIR.is_dir():
            session.copy_to_container(
                WHEELHOUSE_DIR,
                container_dir=CONTAINER_WHEELHOUSE_DIR,
            )
        else:
            logger.warning(
                "Wheelhouse not found at %s; falling back to network install",
                WHEELHOUSE_DIR,
            )
        return super().perform_task(instruction, session, logging_dir)
