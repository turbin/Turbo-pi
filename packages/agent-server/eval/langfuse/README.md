# Langfuse 自托管（9B 跑批监视）

部署日期：2026-08-19 ｜ 版本：Langfuse 4.13.0（compose 栈：web + worker + Postgres 17 + ClickHouse 25.12 + Redis 7 + MinIO）

## 访问

- Web UI：http://localhost:3000 （admin@example.com / 密码见 `.env` 的 `LANGFUSE_INIT_USER_PASSWORD`）
- 项目：`exp-9b-campaign`（org `Turbo-Pi`），API 密钥见 `.env` 的 `LANGFUSE_INIT_PROJECT_PUBLIC_KEY / SECRET_KEY`（`pk-lf-…` / `sk-lf-…`）
- 数据卷：docker volumes `langfuse_*`（Postgres/ClickHouse/MinIO/Redis 持久化）

## 操作

```bash
cd packages/agent-server/eval/langfuse
docker compose up -d      # 启动
docker compose down       # 停止（数据保留）
docker compose ps         # 状态
```

`.env` 含全部密钥，已 gitignore，勿提交。`docker-compose.yml` 为官方 v4 自托管模板（未改）。

## 端口

3000（web，对外）、9090/9091（MinIO）、127.0.0.1:5432/6379/8123/9000（内部组件仅绑回环）。与跑批链路端口（8000/8787/8788/8789/8790/8899）无冲突。

## 环境修复记录（2026-08-19）

colima VM 代理原为失效地址 `http://192.168.5.2:8898`（docker pull 全部 Bad Gateway / TLS 错误），已改 `~/.colima/default/colima.yaml` env 为 `http://192.168.5.2:7890`（= macOS 宿主机 ApexCore 代理 127.0.0.1:7890，slirp 网关 192.168.5.2 从 VM 可达）并 `colima restart`。原配置备份 `/tmp/colima.yaml.bak`。代理抖动时逐镜像重试 `docker pull` 可续传。

## 接入状态（2026-08-19 已实施，测试全绿 + 端到端冒烟 PASS）

- **gateway 侧**（`packages/agent-gateway`）：`observability.py` — `[langfuse]` 配置段（config.toml 已 enabled=true，密钥走 env `LANGFUSE_PUBLIC_KEY/SECRET_KEY`，不入文件）；main.py 包装双 provider（omlx=主腿 / kimi|deepseek=升级腿），每次上游调用导出一条 generation；trace id = `create_trace_id(seed=chatcmpl响应id)` 确定性对账键，与 run.jsonl.trace_ids / model_runs / agent-server session marker 1:1 join。SDK 异常不炸请求（建 span 失败回落无跟踪调用，update 失败吞掉）。测试 `tests/unit/test_langfuse_tracing.py` 10 例。
- **campaign 侧**（`eval/campaign.py`）：`init_langfuse()`（env 缺省→None no-op）；任务级 trace `create_trace_id(seed=f"{run_id}-d{day}-{arm}-{task_id}")` + QCB 分数 `create_score(name="qcb_score")`；任何异常只告警不炸批。测试 `eval/tests/test_campaign_langfuse.py` 8 例。
- **preflight.py**：env 透传白名单加 `LANGFUSE_*`（自动拉起 gateway 时从 `packages/agent-server/.env` 读取）。
- **启用步骤**：把本目录 `.env` 中的 `LANGFUSE_INIT_PROJECT_PUBLIC_KEY`/`SECRET_KEY` 两行作为 `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY` 加入 `packages/agent-server/.env`（另加 `LANGFUSE_HOST=http://localhost:3000`），之后 campaign 自动 preflight 拉起的 gateway 与 campaign 本体均开始上报。
- **v4 读写口径**：SDK 4.14.4 走 OTLP 实时摄入；读 API 用 `GET /api/public/v2/observations`（旧 `/api/public/traces` 在 events_only 模式 404）。
- **端到端冒烟**：`uv run --project packages/agent-gateway python packages/agent-server/eval/langfuse/smoke_gateway.py`（stub omlx → gateway → Langfuse 校验对账键，输出 SMOKE PASS）。
- **macOS 陷阱**：系统代理（ApexCore）会被 httpx/urllib trust_env 拾取且不 bypass 回环——任何回环 HTTP（gateway→omlx、冒烟脚本）进程需 `NO_PROXY=127.0.0.1,localhost`（生产 gateway→omlx :8000 依赖 ApexCore 规则放行，冒烟脚本已内置）。
