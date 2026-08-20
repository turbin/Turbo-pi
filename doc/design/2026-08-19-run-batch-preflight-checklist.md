# 跑批环境与条件清单（9B pilot / 全量跑批前置核验）

日期：2026-08-19 ｜ 状态：**生效中（工程约束，跑批前必须逐项核验）**
依据：用户 2026-08-19 指令（启动测试前必须检查所有测试环境与条件）；本清单每一项都来自真实事故/教训（标注来源）。

核验纪律：每项给出验证命令；**探针类项目必须看真实响应/真实数据，不接受"进程在"作为证据**（27B/9B 错位教训：进程活着≠配置生效）。全部通过才允许开跑；任何一项不过，停下来报告用户。

## A. 模型层（omlx）

| # | 条件 | 验证 |
|---|---|---|
| A1 | omlx 运行且带鉴权可达 | `curl -H "Authorization: Bearer $OMLX_KEY" http://127.0.0.1:8000/v1/models` → 200 |
| A2 | 目标模型在已加载列表 | 上条响应含 `Qwen3.5-9B-4bit` |
| A3 | 模型指纹 env 已设 | `AGENT_EVAL_EXPECTED_OMLX_MODEL=Qwen3.5-9B-4bit`（M11，preflight 强制核对） |
| A4 | **真实探针**：一次 chat completion 出 200 | 直连 omlx POST /v1/chat/completions（max_tokens 给足，防 length 误杀） |

## B. gateway（:8787）

| # | 条件 | 验证 |
|---|---|---|
| B1 | **唯一进程**监听 8787（无残留旧进程） | `lsof -iTCP:8787 -sTCP:LISTEN` 仅 1 行；`ps aux \| grep agent_gateway` 仅 1 组（27B 错位事故） |
| B2 | **进程晚于配置**：启动时间 > config.toml mtime | `ps -o lstart -p <pid>` vs `ls -l config.toml`（配置/进程错位事故） |
| B3 | config.toml 内容：`local_omlx.model` = 目标模型；`[langfuse] enabled=true`、`environment="exp-9b"` | `grep` config.toml |
| B4 | 进程 env 齐备：`DEEPSEEK_API_KEY`（升级腿）、`LANGFUSE_PUBLIC_KEY/SECRET_KEY`、`NO_PROXY=127.0.0.1,localhost` | 启动命令即注入（preflight 自动拉起已固化透传+NO_PROXY；手工启动用 set -a 过滤导出） |
| B5 | /v1/models 200 | `curl -H "Authorization: Bearer lobster-local-key" http://127.0.0.1:8787/v1/models` |
| B6 | **探针 trace 进 Langfuse**：经 8787 发真实请求 → v2/observations 出现该 generation 且 **model 字段 = 目标模型** | `GET /api/public/v2/observations?limit=1&fields=core,model`（27B 错位就是靠这项抓住的） |
| B7 | 云端升级腿配置符合实验设计（9B 是否允许升级 DeepSeek；length<5% 门控不变） | config.toml `[cloud.*]` + `routing.selected_cloud_provider`；与用户确认 |

## C. agent-server（:8789 实验臂 / :8790 对照臂）

| # | 条件 | 验证 |
|---|---|---|
| C1 | 8789 LISTEN 且指纹 OK | `curl http://127.0.0.1:8789/api/status/chain`（M11；injection on） |
| C2 | 8790 LISTEN（对照臂 injection off） | 同上；T7 四臂模式另需冻结快照实例 + `--frozen-base-url` 显式指定 |
| C3 | Node 25.9.0 工具链可用 | `scripts/with-node25.sh node -v`；better-sqlite3 已 rebuild |
| C4 | **经验库状态经用户确认**（空库/归档/快照加载——27B 经验已裁决不适用，9B 起跑库态必须显式定） | `var/` 下 experience store 文件 + 快照清单；用户拍板记录 |
| C5 | session 落盘目录可写 | `var/sessions` 存在且可写 |

## D. judge / 云端评分

| # | 条件 | 验证 |
|---|---|---|
| D1 | deepseek relay :8899 LISTEN | `lsof -iTCP:8899 -sTCP:LISTEN`（preflight 可自动拉起） |
| D2 | 跑批进程 env：`JUDGE_BASE_URL=http://127.0.0.1:8899/v1`、`JUDGE_API_KEY=$DEEPSEEK_API_KEY`（pilot 首轮 judge 全灭教训：手工 env 未沉淀） | 启动命令即注入 |
| D3 | **真实探针**：一次 judge 调用成功 | `_call_llm_judge_api("Reply with exactly: ok")` → "ok"（401/超时即不过） |
| D4 | `JUDGE_MODEL` 缺省 deepseek-v4-pro（P-D6 口径） | env 或缺省 |

## E. Langfuse 监视

| # | 条件 | 验证 |
|---|---|---|
| E1 | colima + 6 容器 healthy | `docker compose -f eval/langfuse/docker-compose.yml ps` |
| E2 | web :3000 200 + 健康 OK | `curl http://localhost:3000/api/public/health` |
| E3 | `packages/agent-server/.env` 含 `LANGFUSE_PUBLIC_KEY/SECRET_KEY/HOST` 三行 | `grep -c "^LANGFUSE_" packages/agent-server/.env` = 3 |
| E4 | v2/observations 有新数据流入（B6 探针即证据） | 同 B6 |

## F. 跑批进程与数据面

| # | 条件 | 验证 |
|---|---|---|
| F1 | eval venv 依赖完整（含 langfuse 4.14.4） | `.venv/bin/python -c "import langfuse"`；requirements.lock.txt 同步 |
| F2 | 跑批 env 全套：`DEEPSEEK_API_KEY`、`LANGFUSE_*`、`JUDGE_*`、`NO_PROXY`、`AGENT_EVAL_EXPECTED_OMLX_MODEL` | 启动命令即注入（参考 pilot_9b 启动式） |
| F3 | `python -u`（无缓冲）+ nohup + 日志文件（首轮 pilot 日志全憋在缓冲区的教训） | 启动命令 |
| F4 | results 目录可写；run-id 明确（新跑 or 断点续跑，resume 键 (day,arm,task_id)） | `ls results/` |
| F5 | 外置盘挂载且磁盘余量充足（results/transcripts/sessions/快照） | `df -h /Volumes/extern-1T-hardisk` |
| F6 | 任务集/臂参数符合设计（--day / --arms / --frozen-base-url；先 --dry-run 打印批次核对） | campaign --dry-run 输出 |

## G. 判据与质量门

| # | 条件 | 验证 |
|---|---|---|
| G1 | 既有测试全绿 | `./test.sh` 口径（agent-server/agent-gateway/eval） |
| G2 | `npm run check` 无新增失败（pre-existing pinned-deps=eval/results 工件口径不变） | 完整输出核对 |
| G3 | length 升级率 <5% 门控脚本可用 | `eval/gate_length_escalation.py`（pilot 校准结论先入档） |
| G4 | Langfuse 侧可观测核对口径已明确：model 字段=服务模型、gateway_trace_id=对账键、qcb_score=任务分数 | 本清单 B6/E4 |

## H. 四臂交叉日专项（D2/D7，preview.html §10-§12）

| # | 条件 | 验证 |
|---|---|---|
| H1 | 冻结实例运行且锁库（加载 D1-post 快照，全程不换载） | 冻结实例 /api/status/chain + EXPERIENCE_STORE_PATH 指向快照副本；`--frozen-base-url` 显式传 |
| H2 | 快照锁：四臂开始前 frozen+current 双快照落盘；四臂完成前禁止 hot-library swap / 当日 evolution | snapshot_store 落盘记录；交叉日 runbook 顺序（§12.1） |
| H3 | 臂序为 task-block 确定性随机（禁止臂块顺序） | `--dry-run --day N --arms x1,x2,x3,x4` 输出为逐任务臂序排列；同 run-id 重跑 diff 为空 |
| H4 | held-out 摘除确认：held_out_tasks() 恰 8 个、与 D1 切片零交集、不出现在非四臂日 | `--dry-run` 各日切片 grep held-out 无命中；四臂日 x2/x3 含、x1/x4 无 |
| H5 | 写入隔离：夜间进化合成器带 `--eligible-arms`（四臂日默认 experiment,x2），held-out transcripts 排除 | 合成器日志 excluded 计数；交叉日先对账再进化 |
| H6 | 环境隔离：四臂 workspace 按 `dayN/<arm>/task` 独立克隆（base assets 确定性复制） | 目录结构抽检；side-effect 任务无前臂残留 |

## 启动式参考（9B pilot 实测可用）

```bash
cd packages/agent-server/eval
set -a; eval "$(grep -E '^(DEEPSEEK_|LANGFUSE_)' ../.env | sed 's/^/export /')"; set +a
export JUDGE_BASE_URL="http://127.0.0.1:8899/v1" JUDGE_API_KEY="$DEEPSEEK_API_KEY"
export NO_PROXY="127.0.0.1,localhost" AGENT_EVAL_EXPECTED_OMLX_MODEL="Qwen3.5-9B-4bit"
nohup ./.venv/bin/python -u pilot_9b.py --tasks 3 > /tmp/pilot-9b.log 2>&1 &
```

Refer Spec：plans/2026-08-14-post-c-unified-fix-batch-plan.md v5（§108 9B 起跑前置）；doc/design/2026-08-19-langfuse-monitoring-changes-and-decisions.md（§4 环境陷阱）；doc/issues-snapshot/（issue-003/004/008/009/011/015）
