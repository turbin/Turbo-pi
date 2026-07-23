# Agent-Server N3：上线观察期启动——决策记录

日期：2026-07-23
任务书：` design/2026-07-23-agent-server-post-c-tasks.md` N3 节
进度：` design/progress/2026-07-23-post-c-operations.md`

---

## 1. dry-run 审查

三条命令均从 `packages/agent-server` 执行，走 `scripts/with-node25.sh`（Node 25.9.0）。

### 1.1 `schedule.ts doctor --dry-run`

```
installed: false
issues:
  - LaunchAgent plist not installed
  - EXPERIENCE_STORE_PATH not set (default ./var/experience.db will be used)
  - AGENT_SERVER_BENCHMARK not set — evolution will skip skill training stage
fix commands:
  $ npx tsx src/offline/schedule.ts install
  $ export AGENT_SERVER_BENCHMARK=/path/to/benchmark.json
```

**审查结论**：

- LaunchAgent 未安装——预期，尚未执行 install。
- `EXPERIENCE_STORE_PATH` 未设置——**非问题**：代码默认 `./var/experience.db`（相对 cwd），plist 中 `cd` 指向 `packages/agent-server`，路径正确。
- `AGENT_SERVER_BENCHMARK` 未设置——**需注意**：缺失时 `skill_evolution` 管线阶段被跳过（只跑 ETL + verification_selection 两管线）。doctor 正确标记了此问题。

### 1.2 `schedule.ts install --dry-run`

```
install: platform=macos home=/Users/turbineyan dryRun=true
[dry-run] would write plist to /Users/turbineyan/Library/LaunchAgents/com.agent-server.evolution.plist
[dry-run] content:
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>com.agent-server.evolution</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/sh</string>
		<string>-c</string>
		<string>cd /Volumes/extern-1T-hardisk/workspace/01-repo/03-agents/Turbo-pi/packages/agent-server && npx tsx src/offline/run-evolution.ts</string>
	</array>
	<key>StartInterval</key>
	<integer>86400</integer>
	<key>RunAtLoad</key>
	<false/>
	<key>StandardOutPath</key>
	<string>/Volumes/extern-1T-hardisk/workspace/01-repo/03-agents/Turbo-pi/packages/agent-server/var/evolution-launchd.log</string>
	<key>StandardErrorPath</key>
	<string>/Volumes/extern-1T-hardisk/workspace/01-repo/03-agents/Turbo-pi/packages/agent-server/var/evolution-launchd.err</string>
</dict>
</plist>
```

### 1.3 `schedule.ts uninstall --dry-run`

```
uninstall: platform=macos home=/Users/turbineyan dryRun=true
no plist at /Users/turbineyan/Library/LaunchAgents/com.agent-server.evolution.plist (idempotent — nothing to remove)
```

**审查结论**：plist 不存在，幂等，无副作用。

---

## 2. 重点审查项：调度环境下的 env 与命令

任务书指定的重点审查项："env 是否含 EXPERIENCE_STORE_PATH / AGENT_SERVER_BENCHMARK / PYTHONPATH——调度环境下没有交互 shell 的 env"。逐项结论：

### 2.1 EXPERIENCE_STORE_PATH ——无需设置

代码默认 `./var/experience.db`（`run-evolution.ts:46`），plist 命令以 `cd packages/agent-server` 开头，相对路径解析正确。

### 2.2 AGENT_SERVER_BENCHMARK ——需用户手动设置

plist 中未包含 `EnvironmentVariables` 字典，`AGENT_SERVER_BENCHMARK` 在 LaunchAgent 环境中为空。后果：`skill_evolution` 管线被跳过，只跑 ETL + verification_selection。

- 当前 `benchmark.example.json` 在 `packages/agent-server/benchmark/`。
- 用户安装后若需完整三管线运行，须在 plist 中添加 `EnvironmentVariables` 或在 shell profile 中 export（但 LaunchAgent 不读 shell profile——**必须写入 plist**）。
- 本决策记录在"安装指令"一节给出含 `EnvironmentVariables` 的手动 plist 补丁方法。
- **如果暂不需要 skill_evolution 管线**（例如没有真实 benchmark 数据），当前配置也可正常运行，只是产出中不含 SKILL 更新。

### 2.3 PYTHONPATH ——无需设置

`pipeline.ts:76-93` 在 spawn Python 子进程时**程序化设置** `PYTHONPATH`（默认 `<pkg>/python`，追加到已有 `PYTHONPATH`），不依赖调度环境。plist 中无此变量不影响管线执行。

### 2.4 Node / npx PATH ——潜在问题

plist 的 `ProgramArguments` 通过 `/bin/sh -c` 执行 `npx tsx ...`。LaunchAgent 进程的 PATH 极为有限（通常 `/usr/bin:/bin:/usr/sbin:/sbin`），`npx` 若安装在 Homebrew 路径（`/opt/homebrew/bin/npx` 或 `/usr/local/bin/npx`）或 `.tools/` 下，**在 LaunchAgent 环境中不可达**。

- 当前 `scripts/with-node25.sh` 使用仓库内 `.tools/node-v25.9.0-*/bin/node`，不依赖系统 PATH。
- 修复方案（二选一，在安装指令中给出）：
  - **方案 A（推荐）**：将 plist 命令改为 `cd <cwd> && ../../scripts/with-node25.sh npx tsx src/offline/run-evolution.ts`——走仓库内固定 Node，不受 PATH 限制。
  - **方案 B**：在 plist 中添加 `<key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>`。

**结论**：`schedule.ts` 生成的默认 plist 在 LaunchAgent 环境下可能因 PATH 问题无法执行。安装指令中已给出修正方法。此问题不阻塞 N3 交付——实际安装是用户动作，用户可按指令修正后再 install。

---

## 3. 安装指令（用户执行，agent 不执行）

以下所有命令从仓库根目录执行。

### 3.1 前置检查

```bash
# 确认 Node 25 可用
scripts/with-node25.sh node --version
# 预期输出：v25.9.0

# 确认 agent-server 目录存在
ls packages/agent-server/src/offline/schedule.ts
# 预期输出：packages/agent-server/src/offline/schedule.ts

# dry-run 检查当前状态
cd packages/agent-server
../../scripts/with-node25.sh npx tsx src/offline/schedule.ts doctor --dry-run
# 预期输出：
#   installed: false
#   issues:
#     - LaunchAgent plist not installed
#     - EXPERIENCE_STORE_PATH not set (default ./var/experience.db will be used)
#     - AGENT_SERVER_BENCHMARK not set — evolution will skip skill training stage
cd ../..
```

### 3.2 安装 LaunchAgent（方案 A：with-node25.sh）

由于默认 plist 使用裸 `npx tsx`（PATH 问题见 §2.4），推荐手动安装修正后的 plist：

```bash
# 创建 LaunchAgent 目录（如不存在）
mkdir -p ~/Library/LaunchAgents

# 写入修正后的 plist（使用 with-node25.sh 保证 Node 版本）
cat > ~/Library/LaunchAgents/com.agent-server.evolution.plist << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>com.agent-server.evolution</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/sh</string>
		<string>-c</string>
		<string>cd /Volumes/extern-1T-hardisk/workspace/01-repo/03-agents/Turbo-pi/packages/agent-server &amp;&amp; ../../scripts/with-node25.sh npx tsx src/offline/run-evolution.ts</string>
	</array>
	<key>StartInterval</key>
	<integer>86400</integer>
	<key>RunAtLoad</key>
	<false/>
	<key>StandardOutPath</key>
	<string>/Volumes/extern-1T-hardisk/workspace/01-repo/03-agents/Turbo-pi/packages/agent-server/var/evolution-launchd.log</string>
	<key>StandardErrorPath</key>
	<string>/Volumes/extern-1T-hardisk/workspace/01-repo/03-agents/Turbo-pi/packages/agent-server/var/evolution-launchd.err</string>
</dict>
</plist>
PLIST

# 加载 LaunchAgent
launchctl load ~/Library/LaunchAgents/com.agent-server.evolution.plist

# 验证已安装
cd packages/agent-server
../../scripts/with-node25.sh npx tsx src/offline/schedule.ts doctor --dry-run
# 预期输出：
#   installed: true
#   issues:
#     - EXPERIENCE_STORE_PATH not set (default ./var/experience.db will be used)
#     - AGENT_SERVER_BENCHMARK not set — evolution will skip skill training stage
cd ../..
```

> **注意**：plist XML 中 `&&` 必须写成 `&amp;&amp;`（XML 转义）。上面的 heredoc 已正确处理。

### 3.3 可选：启用 skill_evolution 管线

如需完整三管线运行，在 plist 的 `<dict>` 内添加：

```xml
	<key>EnvironmentVariables</key>
	<dict>
		<key>AGENT_SERVER_BENCHMARK</key>
		<string>/Volumes/extern-1T-hardisk/workspace/01-repo/03-agents/Turbo-pi/packages/agent-server/benchmark/benchmark.example.json</string>
	</dict>
```

添加后重新加载：

```bash
launchctl unload ~/Library/LaunchAgents/com.agent-server.evolution.plist
launchctl load ~/Library/LaunchAgents/com.agent-server.evolution.plist
```

### 3.4 手动触发首次进化（验证安装正确）

LaunchAgent 的 `RunAtLoad` 为 false，首次进化需等 24 小时或手动触发：

```bash
cd packages/agent-server
../../scripts/with-node25.sh npx tsx src/offline/run-evolution.ts
# 预期输出（正常情况）：
#   evolution checkpoint: ckpt-<hex>
# 或（如果 gateway/omlx 未运行）：
#   evolution failed: <错误信息>
#   failure checkpoint: ckpt-<hex>
#   （两种情况都有 checkpoint 产生，B3 设计"失败也写 checkpoint"）

# 查看最近 checkpoint
../../scripts/with-node25.sh npx tsx src/offline/run-evolution.ts --status
# 预期输出：JSON 格式的 checkpoint 信息
cd ../..
```

### 3.5 日常自查

```bash
cd packages/agent-server

# 查看进化调度状态
../../scripts/with-node25.sh npx tsx src/offline/schedule.ts doctor
# 预期输出：installed: true + 已知 issues（env 变量提示）

# 查看最近 checkpoint
../../scripts/with-node25.sh npx tsx src/offline/run-evolution.ts --status

# 查看进化日志（最近 20 行）
tail -20 var/evolution-launchd.log
tail -20 var/evolution-launchd.err

cd ../..
```

### 3.6 卸载

```bash
cd packages/agent-server
../../scripts/with-node25.sh npx tsx src/offline/schedule.ts uninstall
# 预期输出：
#   uninstall: platform=macos home=/Users/turbineyan dryRun=false
#   plist removed from /Users/turbineyan/Library/LaunchAgents/com.agent-server.evolution.plist
cd ../..

# 验证已卸载
launchctl list | grep agent-server
# 预期输出：（无输出 = 已卸载）
```

**或使用 launchctl 直接卸载**（效果等同）：

```bash
launchctl unload ~/Library/LaunchAgents/com.agent-server.evolution.plist
rm ~/Library/LaunchAgents/com.agent-server.evolution.plist
```

---

## 4. 未执行 install 的说明

依据 B3 红线（`schedule.ts:14-18`）与任务书要求："agent 不执行实际 install，由用户运行或明确授权"。本任务仅交付：

1. 三条 dry-run 命令的输出与审查（§1-§2）；
2. 逐条可复制的安装/卸载/自查命令（§3）；
3. 观察 runbook（` design/2026-07-23-agent-server-observation-runbook.md`）。

**所有 plist 写入、launchctl 加载、crontab 修改均为工程外系统状态变更**，由用户按上述指令自行执行。

---

## 5. 观察 runbook 交付

观察 runbook 已落盘 ` design/2026-07-23-agent-server-observation-runbook.md`，内容：

- 观察周期与评审节奏（每周一次对照基线，4 周出首份迭代评估）；
- 对照 SQL 集（引用基线 §1/§3/§4/§5/§6，逐条注明关注什么变化）；
- 触发评审的动作表（对应 C 方案 5 项决策的观察项）；
- 日常使用接线说明（客户端指向 agent-server 8788）；
- 周报模板（附录 A）。

---

## 6. 与既有代码/文档的一致性

- 安装指令中的路径、端口、env 变量名均以代码为准（`server.ts`、`run-evolution.ts`、`pipeline.ts`、`schedule.ts`），未臆造配置项。
- 客户端接线说明引用 P1/P2 live 验证文档中已验证的 Kimi Code 配置方式（`type=openai_legacy`，`base_url=http://127.0.0.1:8788/v1`）。
- 进化 CLI 命令引用 `run-evolution.ts` 头部注释的用法说明。
