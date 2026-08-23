# Kimi MCP 独立项目迁移——变更与决策记录

日期：2026-08-21
状态：完成

## 变更

- 将 Kimi MCP 服务实现、测试、启动脚本、配置、README 和原实施档案移出 Turbo-pi，建立同级独立目录 `../kimi-subagent-mcp`。
- 删除 Turbo-pi 内原实现路径，避免 agent-server eval 环境承担无关的 Kimi MCP 生命周期。
- 独立项目新增 `pyproject.toml`、自身 `.venv` 与 console script，固定 `mcp==1.28.1`、`pytest==9.1.1`、`hatchling==1.29.0`。
- 默认目标仍为同级 `Turbo-pi`，可通过 `KIMI_SUBAGENT_PROJECT_ROOT` 显式覆盖。

## 决策

1. **依赖隔离**：不再复用 `packages/agent-server/eval/.venv`，防止 eval 依赖更新或环境重建影响 Kimi MCP。
2. **功能边界不扩张**：本次仅迁移并独立打包，继续保持四个只读工具与一个 status resource，不新增 Kimi 执行、shell、写入、门控修改或跑批能力。
3. **配置不写全局**：独立项目保留 `mcp.json`，推荐从该目录用 `kimi --work-dir ../Turbo-pi --mcp-config-file mcp.json` 启动。
4. **Turbo-pi 只留迁移记录**：原计划和实现决策随项目迁移；Turbo-pi INDEX 改为登记本迁移记录，避免失效路径继续充当 canonical 入口。

## 验证

- `cd ../kimi-subagent-mcp && uv sync --dev`：独立 `.venv` 与 `uv.lock` 生成成功。
- `uv run pytest -q`：10 passed；依赖 `pydantic-settings` 报 1 条 unresolved forward-reference warning，不影响 MCP 行为。
- Kimi 1.49.0 FastMCP 配置模型验证 `mcp.json`：通过。
- stdio 冒烟覆盖 initialize、四工具发现、`get_project_status` 调用、resource 列举与读取：通过。
