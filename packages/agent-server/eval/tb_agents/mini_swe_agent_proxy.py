"""E2 Terminal-Bench custom agent: MiniSweAgent with configurable endpoint.

Inherits from Terminal-Bench's built-in MiniSweAgent. Overrides _env to:
- Set OPENAI_BASE_URL (driven by host env var OPENAI_BASE_URL — this is how
  the control/experiment arm switch works)
- Set MSWEA_SILENT_STARTUP / MSWEA_COST_TRACKING (E0 non-interactive fixes)
- Pass through HTTPS_PROXY from host (needed for pip/apt in container)

Also overrides the installation script template (mini-swe-setup.sh.j2 in the
same directory) to use the Tsinghua PyPI mirror.

Usage:
    # Control arm (direct DeepSeek)
    OPENAI_BASE_URL=https://api.deepseek.com/v1 OPENAI_API_KEY=<key> \
    tb run -d terminal-bench-core --agent-import-path eval.tb_agents.mini_swe_agent_proxy:MiniSweAgentProxy \
      -m openai/deepseek-v4-flash

    # Experiment arm (via agent-server)
    OPENAI_BASE_URL=http://host.docker.internal:8789/v1 OPENAI_API_KEY=dummy \
    tb run -d terminal-bench-core --agent-import-path eval.tb_agents.mini_swe_agent_proxy:MiniSweAgentProxy \
      -m openai/deepseek-v4-flash
"""

import os
from pathlib import Path

from terminal_bench.agents.installed_agents.mini_swe_agent.mini_swe_agent import MiniSweAgent


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

        # Proxy for pip/apt (needed inside colima VM)
        https_proxy = os.environ.get("HTTPS_PROXY", "")
        if https_proxy:
            env["HTTPS_PROXY"] = https_proxy

        return env

    @property
    def _install_agent_script_path(self) -> Path:
        # Use custom template from this directory (Tsinghua mirror)
        return self._get_templated_script_path("mini-swe-setup.sh.j2")
