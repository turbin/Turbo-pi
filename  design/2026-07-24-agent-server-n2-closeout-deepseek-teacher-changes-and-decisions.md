# Agent-Server：N2 收尾 + N3 安装 + DeepSeek teacher 切换——变更与决策记录

日期：2026-07-24
来源：用户四项指示（DeepSeek key 存 .env；N2 自动起 gateway 收尾；N3 安装；teacher 切换 DeepSeek）。
通用约束：见 ` design/2026-07-22-agent-server-p3-candidate-tasks.md`"通用约束"。
进度：` design/progress/2026-07-23-post-c-operations.md`

---

## 1. DeepSeek key 存储与模型选择

- `packages/agent-server/.env`（新增，gitignored，root `.gitignore:15` 的 `.env` 规则覆盖，已用 `git check-ignore -v` 验证）：`DEEPSEEK_API_KEY` + teacher 切换四变量（`LLM_BASE_URL=https://api.deepseek.com/v1`、`LLM_API_KEY`、`LLM_MODEL`、`TEACHER_MODEL`）。
- **模型名实测**：该账户 `/v1/models` 仅返回 `deepseek-v4-pro` 与 `deepseek-v4-flash`（无 `deepseek-chat`）。决策：`TEACHER_MODEL=deepseek-v4-pro`（经验卡抽取，质量关键）、`LLM_MODEL=deepseek-v4-flash`（student 评分，调用量大，控成本）。
- 两模型均为 reasoning 模型（返回 `reasoning_content`），实测 `chat/completions` 可用。
- 安全备注：key 曾在对话中明文出现，建议用户轮换。

## 2. verifier 回退链修复（DeepSeek 接入的必需修复）

**现象**：DeepSeek 首轮进化在首个 `score_pair` 即抛 `ScoreExtractionError: top_logprobs 中没有任何评分 token（A-T 子集为空）`。

**根因**：DeepSeek tokenizer 把 `<score_A>` 拆成 `<` / `score` / `_A` / `>` 多 token（vLLM/omlx 是单 token），且某些轨迹的评分位 top_logprobs 不含字母 token。`extract_tag_distribution` 本身按字符偏移定位、兼容拆 token，但下游 `expected_from_top_logprobs` 遇到无字母子集时直接抛错，没有回退路径。实测 DeepSeek 文本输出格式完全规范（`<score_A> T </score_A>`）。

**修复**（`python/verification_selection/verifier.py` `_score_once`）：logprobs 期望化路径包 try/except `ScoreExtractionError` → 回退 `_extract_scores_from_text`（P3-1 既有文本通路）；文本也无标签时仍抛 `ScoreExtractionError`（不静默给默认分）。dict/list 两个分支都接。

**TDD**：`python/tests/test_verifier_fallback.py` 新增 2 条用例（logprobs 不可用+文本有标签→回退成功；logprobs 不可用+文本无标签→抛错），先红后绿；全量 29 pytest 通过（A2 基线 27 + 新增 2）。

## 3. N2 收尾：容器真实进化 metric>0 验证

### 3.1 发现的缺陷与修复

1. **离线调度不认 `AGENT_SERVER_SESSION_DIR`（缺陷修复）**：`server.ts:37` 读该 env，但 `scheduler.ts` 默认硬编码 `./var/sessions`——容器里 ETL 到空目录，两轮 checkpoint 全零（N2 的 metric=0 的**真实根因**，此前归因于"无 gateway"不准确）。修复：`run-evolution.ts` `cmdRun` 透传 `AGENT_SERVER_SESSION_DIR` 为 `inputDir`。TDD：`test/offline/run-evolution.test.ts` 新增 2 条（env 设置→传 inputDir；未设置→传空 options），先红后绿；包级 vitest 21 文件 / **227 测试**全绿（基线 225 + 2）。
2. **容器 Python 无 CA 证书包（缺陷修复）**：HTTPS LLM 端点报 `unable to get local issuer certificate`。修复：Dockerfile 两个 stage 的 apt-get 加 `ca-certificates`。
3. **compose LLM_* 透传（增强）**：`docker-compose.yml` 的 evolution sidecar 增加 `LLM_BASE_URL/LLM_API_KEY/LLM_MODEL/TEACHER_MODEL` 透传（默认空 → MockLLM 行为不变）。
4. **管线子进程超时可配置（增强）**：DeepSeek reasoning 模型每 call 生成 reasoning_content，经代理后单次评分 30-60s，verification_selection 主管线超过默认 300s 子进程超时被 SIGTERM。修复：`pipeline.ts` 新增 `AGENT_SERVER_PIPELINE_TIMEOUT_MS` env（优先级：options.timeoutMs > env > 默认 300s，主管线与 rescore 共用 `resolveTimeoutMs`）。TDD：`test/offline/pipeline.test.ts` 新增 2 条（env 生效；option 优先于 env），先红后绿；包级 vitest 21 文件 / **229 测试**全绿。

### 3.2 路径排除记录（为什么不走 gateway / omlx）

- **gateway 路径**：omlx 经 gateway 报 `400 unsupported parameter: logprobs`（gateway 的参数校验拒绝 verifier 必需的 logprobs 请求）。离线管线只需要 OpenAI 兼容端点，gateway 无加成 → 弃用。
- **omlx 直连路径**：容器内实测两类失败——gemma-4-12B 评分文本偶发为空（`ScoreExtractionError`，R1 在宿主机成功带有运气成分）；7 分钟跑不完一轮（300s 子进程超时 SIGTERM，P3-1 已知问题）。→ 弃用。
- **DeepSeek 路径（采用）**：首次 SSL 失败两连——(a) colima VM 流量被宿主 PAC 代理（`127.0.0.1:7897`）增强模式 MITM（`self-signed certificate in certificate chain`）→ 容器设 `HTTPS_PROXY=http://host.docker.internal:7897` 走 CONNECT 隧道规避（注意：`docker compose run` 的 shell 环境变量不会自动进容器，必须用 `-e` 显式传）；(b) 容器缺 CA 包（§3.1.2 修复）。

### 3.3 最终验证（PASS）

- **容器内真实进化 metric>0**：checkpoint `ckpt-bd091b6a34c06a4f`，**metric=11**（snapshot `{etlInserted:0, cards:2, promoted:2, rescored:9, promotedFromDormant:9}`；dormant 行来自修复 session 目录后前几次失败运行的 ETL 积累，本轮 rescore 全部晋升）。容器库存：ABILITY 5 active（DeepSeek 派生 Method，quality 0.731 档）+ EVIDENCE 9。
- **在线路径**：server 容器 8788 `/api/evolution/status` 返回上述 checkpoint（双服务共享 /data 卷正常）。
- **常驻部署定型**：`docker-compose.yml` evolution sidecar 增补 `HTTPS_PROXY/https_proxy/NO_PROXY/AGENT_SERVER_PIPELINE_TIMEOUT_MS` 透传；`packages/agent-server/.env`（gitignored，compose 自动读取）写入 DeepSeek 四变量 + `HTTPS_PROXY=http://host.docker.internal:7897` + `AGENT_SERVER_PIPELINE_TIMEOUT_MS=900000`——**`docker compose up -d` 一条命令即完整部署**（B3 方案 A+ 的 compose 分支落地）。常驻 sidecar 首轮复验：checkpoint `ckpt-315dc5a9f010de68` metric=2（重派生新变体晋升，符合预期；同轨迹近似重复 Method 的堆积正是 C 决策 5 记录的 edges/合并立项观察项）。
- gateway/omlx 路径弃用原因见 §3.2；本机 PAC 代理（`127.0.0.1:7897`）MITM colima VM 流量是容器 HTTPS 失败的根源。

## 4. N3：LaunchAgent 安装与 TCC 外置卷阻塞

- 已按决策记录方案 A 安装 `~/Library/LaunchAgents/com.agent-server.evolution.plist`（`with-node25.sh` 包装 + `EnvironmentVariables`：`AGENT_SERVER_BENCHMARK` + DeepSeek 四变量），`launchctl load` 成功，doctor `installed: true`（两条 issue 为 doctor 只查当前 shell env 的误报，plist 内 env 已含）。
- **TCC 阻塞（新发现）**：`launchctl start` 实测 xpcproxy exit(78)、9ms 退出。最小实验证实：launchd 子进程对外置卷 `/Volumes/extern-1T-hardisk` **读写均被 TCC 拒绝**（`Operation not permitted`，写 /tmp 正常）。仓库在外置卷上，因此 **launchd 形态的日调度在此机上不可行**，除非：
  - 方案 1：用户在 系统设置 → 隐私与安全性 → 完全磁盘访问 为 `/bin/sh`（或最终 node 二进制）授权（一次性 GUI 动作，授权面较大）；
  - 方案 2（推荐）：**日常调度改用 docker compose 的 evolution sidecar**（`--loop`，容器不受 TCC 限制，本次 N2 已验证容器内真实进化全链路）——这正是 B3 方案 A+ 的 compose 分支；
  - 方案 3：把仓库迁回内置盘（动作大，不推荐）。
- plist 日志路径已改到 `~/Library/Logs/agent-server-evolution.{log,err}`（外置卷路径正是 exit(78) 的直接原因）。
- **2026-07-24 用户拍板：选方案 2**——日常调度用 docker compose evolution sidecar（24h 循环，DeepSeek teacher，已在运行）。launchd plist 已 `launchctl unload` 并删除；`schedule.ts install` 的 launchd/cron 形态仅适用于仓库在内置盘的机器（TCC 不拦内置盘用户目录），代码保留不动。
- 测试 plist（tectest）已清理。

## 5. teacher 切换验证（宿主机）

```bash
cd packages/agent-server && set -a && . ./.env && set +a && \
EXPERIENCE_STORE_PATH=./var/experience.db AGENT_SERVER_BENCHMARK=./benchmark/benchmark.example.json \
PYTHONPATH=python ../../scripts/with-node25.sh npx tsx src/offline/run-evolution.ts
```

- 全程 **3m31s**，exit 0，checkpoint `ckpt-e73389d9244f184b`，**metric=4**（snapshot：`{etlInserted:0, pipeline:{skills:1,sops:0,cards:4}, promoted:4}`）。
- DeepSeek teacher 产出 4 张新卡：3 Method（如 `Idempotent Retry with Bounded Exponential Backoff`，quality 0.731058 档）+ 1 EVIDENCE；库存 ABILITY 7→10、EVIDENCE 25→26。
- 运行前备份：`var/experience.db.pre-deepseek-backup`。

## 6. 变更清单

| 文件 | 变更 |
|---|---|
| `packages/agent-server/.env` | 新增（gitignored）：DeepSeek key + teacher 四变量 |
| `python/verification_selection/verifier.py` | `_score_once` logprobs→文本回退链（§2） |
| `python/tests/test_verifier_fallback.py` | +2 用例（29 全绿） |
| `src/offline/run-evolution.ts` | `cmdRun` 透传 `AGENT_SERVER_SESSION_DIR`（§3.1.1） |
| `test/offline/run-evolution.test.ts` | +2 用例（vitest 227 全绿） |
| `Dockerfile` | 两 stage 加 `ca-certificates` |
| `docker-compose.yml` | evolution sidecar 增加 LLM_* / 代理 / 超时可配置透传 |
| `src/offline/pipeline.ts` | 新增 `AGENT_SERVER_PIPELINE_TIMEOUT_MS`（`resolveTimeoutMs`，主管线+rescore 共用） |
| `test/offline/pipeline.test.ts` | +2 用例（vitest 229 全绿） |
| `~/Library/LaunchAgents/com.agent-server.evolution.plist` | 安装（工程外，用户已授权）；日志路径在 home |

Refer Spec：` design/2026-07-23-agent-server-post-c-tasks.md`（N2/N3）；` design/2026-07-23-agent-server-n2-docker-build-changes-and-decisions.md`；` design/2026-07-23-agent-server-n3-go-live-changes-and-decisions.md`；` design/2026-07-23-agent-server-r2-mock-vs-real-evaluation.md`（teacher 切换指令，DeepSeek 取代其中的 omlx 方案）
