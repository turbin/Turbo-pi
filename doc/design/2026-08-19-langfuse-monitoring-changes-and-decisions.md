# Langfuse 跑批监视：部署 + 全链路接入决策记录

日期：2026-08-19
状态：**已实施，测试全绿（gateway 195 + eval 92）+ 端到端冒烟 PASS；check 唯一失败项为 pre-existing pinned-deps（eval/results 工件，M1-M5 同口径）**
依据：用户 2026-08-19 指令（部署 Langfuse 监视 9B 跑批 + 按最小接入方案实施）；缺漏调查报告（主会话 explore，2026-08-19）

## 1. 部署（容器）

**D-1 官方 v4 compose 原样部署**：栈 = web 4.13.0 + worker + Postgres 17 + ClickHouse 25.12 + Redis 7 + MinIO，落 `packages/agent-server/eval/langfuse/`（compose 官方模板未改，密钥全部走 `.env`，已 gitignore）。预置 org `Turbo-Pi` / 项目 `exp-9b-campaign`（INIT_* env），端口 3000/9090 与跑批链路（8000/8787-8790/8899）零冲突。

**D-2 colima 代理修复（环境前置）**：colima VM env 原指失效代理 `192.168.5.2:8898`（docker pull 全灭：Bad Gateway / "HTTP response to HTTPS client"），改为 `192.168.5.2:7890`（= 宿主机 ApexCore 127.0.0.1:7890，slirp 网关映射）+ `colima restart`（备份 /tmp/colima.yaml.bak；5 个 unless-stopped 容器全部自愈）。代理抖动下逐镜像重试拉取（docker 层续传，langfuse:4 第 12 次成功）。

## 2. 接入（最小方案 A+B）

**D-3 gateway 埋点 = provider 包装单点（不改采集逻辑）**：新增 `agent_gateway/observability.py`——`LangfuseTracedProvider` 在 main.py 包装双 provider 一次，覆盖全部调用点（非流式 / SSE 回放 / 升级腿）；provider_name 天然区分主腿（omlx）与升级腿（cloud 只在升级路径被调）。`[langfuse]` 配置段 enabled=false 缺省（零行为变化），密钥走 env 名引用（同 cloud provider 惯例，不入配置文件）。chat 管线路径经 `current_trace_id` ContextVar 传递 trace_id（非流式路由 + SSE 生成器顶部各 set 一次；ensure_future 拷贝上下文）。

**D-4 对账键 = create_trace_id(seed) 确定性派生**：gateway 每请求 generation 的 Langfuse trace id = `create_trace_id(seed=chatcmpl响应id)`——与 run.jsonl.trace_ids / model_runs / agent-server session gateway_marker 同一键（台账 2 口径延伸）；campaign 任务级 trace = `create_trace_id(seed=f"{run_id}-d{day}-{arm}-{task_id}")`，QCB 分数走 `create_score(name="qcb_score")` 挂同 seed trace。全链路 join 无需新增字段。

**D-5 可观测性绝不炸批（issue-008/009/011 教训成文）**：gateway 侧建 span 失败→回落无跟踪调用（不重跑 provider）、update 失败→吞掉仅日志、shutdown 不抛；campaign 侧 env 缺失/包未装/init 失败→None 全链 no-op，score/flush 异常只告警。

**D-6 campaign 不用 langfuse.openai drop-in**：v4 SDK 的 openai 包装行为未核，改为显式任务级 span（as_type="agent"）+ score API——LLM 明细由 gateway 侧 generation 覆盖（含升级决策元数据，client 视角拿不到），campaign 只背任务维度与分数。

**D-7 preflight 透传白名单加 `LANGFUSE_*`**：自动拉起 gateway 时从 packages/agent-server/.env 继承（与 DEEPSEEK_ 同机制）；启用动作 = 用户把 langfuse/.env 的两行密钥以 LANGFUSE_PUBLIC_KEY/SECRET_KEY 名加入 packages/agent-server/.env（凭据文件 agent 不写）。

## 3. v4 读写口径（事实登记）

- SDK 4.14.4 走 OTLP 实时摄入（自带 x-langfuse-ingestion-version: 4）。
- **读 API**：`GET /api/public/v2/observations`（events_only 模式下旧 `/api/public/traces`、`/api/public/observations`、`/api/public/scores` 全 404）；scores 读走 v3、metrics 走 v2。
- 冒烟验证用 v2/observations 按 traceId 匹配。

## 4. 环境陷阱（登记）

macOS 系统代理（ApexCore 127.0.0.1:7890）被 httpx/urllib `trust_env` 经 `getproxies()` 拾取且**不 bypass 回环**——gateway→stub 冒烟首灭于 proxy 502；随后**生产 gateway 实锤同坑**（重启后首请求 omlx :8000 经代理 502，旧进程幸存纯属 ApexCore 历史规则）。回环 HTTP 进程必须显式 `NO_PROXY=127.0.0.1,localhost`：preflight.py 拉起 gateway 的 env 已固化 `setdefault("NO_PROXY", ...)`（2026-08-19 补），smoke 脚本内置，手工启动命令同加。

## 测试与冒烟

- gateway `uv run pytest` **195 通过**（新增 test_langfuse_tracing.py 10 例：配置段解析/缺省关闭/缺密钥降级/建 client/generation 记录字段/ERROR 标记/SDK 建 span 失败回落不重跑/无 trace_id 直通/update 失败不炸结果）。
- eval `pytest tests/` **92 通过**（新增 test_campaign_langfuse.py 8 例：env 门控/真实 client 构建/null obs no-op/score 异常吞掉/seed 对账键断言/真实 client span 生命周期）。
- 端到端冒烟 `eval/langfuse/smoke_gateway.py`：stub omlx → gateway(langfuse on) → Langfuse v2/observations 校验——generation 实时可见 + `create_trace_id(seed=chatcmpl-id) == traceId` 对账键一致，**SMOKE PASS**（脚本入库可重跑）。
- `npm run check`：biome 870 文件干净；唯一失败 check:pinned-deps 138 处全部位于 eval/results 工件（pre-existing，M1-M5 同口径）；TS 零改动。

## 边界与遗留

1. **agent-server（TS）跳未接**：检索/注入明细由 request_traces/session JSONL 落库，需要时事后补 ETL；gateway+campaign 两跳已覆盖模型行为与任务分数。
2. **启用待用户动作**：LANGFUSE_* 三行加入 packages/agent-server/.env 后下次跑批自动生效（gateway 由 preflight 拉起时继承）。
3. **prompt/response 全文入 Langfuse**：与 SQLite 存响应同信任级（本地实例）；如需脱敏可用 SDK mask 参数，未启用。
4. **colima 代理修复是全局环境变更**：原失效配置已备份；若 8898 代理恢复需手动回切。
5. 未 push（纪律：commit 随本记录，push 待用户指令）。

Refer Spec：doc/design/plans/2026-08-14-fix-batch-dev-tasks.md（M5 后 9B pilot 节点）；doc/design/2026-08-14-m5-t6-t7-changes-and-decisions.md（台账 2 trace_id 对账键）；doc/issues-snapshot/index.md（issue-008/009/011 炸批教训）
