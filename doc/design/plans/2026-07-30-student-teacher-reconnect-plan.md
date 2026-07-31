# 学生-老师链路接回（B 方案）：agent-server → agent-gateway → omlx + DeepSeek 升级——修改方案

日期：2026-07-30
决策（用户拍板）：选 B——把 omlx 学生模型接回数据面，恢复 v1 设计的"学生优先 + 老师升级"架构。**决策将保存为本地决策记录**（执行步骤 1）。

## 0. 勘察结论（explore 已验证到代码行级）

- 当前直连 DeepSeek 是 `.env`/启动 env 覆盖，**代码默认本就是 `GATEWAY_URL=http://127.0.0.1:8787`**——接回以配置为主
- agent-gateway 代码 07-18 后未动（159 pytest 历史全绿），全链路（→8787→omlx）07-22/23 两次 live 验证 PASS；**DeepSeek 作升级 target 是纯配置**（providers/kimi.py 通用 adapter，config.py 已含 Literal["kimi","deepseek"]）
- 当初弃用 gateway 的理由是离线 verifier 需要 logprobs（离线管线本就走 `LLM_BASE_URL` 直连，不受影响）——**gateway 链路本身无缺陷**
- 硬 blocker 仅 2 个：C1 模型名 allowlist（纯配置）、C2 `thinking` 字段被 envelope 400（需小代码改动）
- omlx（gemma-4-12B-it-4bit）在线且要 key（config.toml:18 已配），其 `stop` 支持为唯一未验证项

## 1. 实验设计修正（关键）：三腿对照

若实验臂走 8789→8787→omlx(+升级) 而控制臂保持直连 DeepSeek，会**混淆两个变量**（模型管线 × 经验注入）。正确设计：

| 腿 | 路径 | 作用 |
|---|---|---|
| L1 teacher 参考 | agent → 8899 中继 → DeepSeek 直连 | 老师天花板上限（**当前 ALFWorld control-full 即此腿，继续跑不中断**） |
| L2 学生基线（新控制臂） | agent → 8787 → omlx（+门控升级 DeepSeek） | 学生管线无注入基线 |
| L3 实验臂 | agent → 8789（经验注入）→ 8787 → omlx（+升级） | 学生管线 + 注入 |

**L2 vs L3 = 注入效果（成功判据①）；L1 作参考；飞轮（E5）用 L3 路径。** 两臂客户端请求参数完全一致（含 `thinking: disabled`）。

## 2. 执行步骤

### S1 决策记录落盘（用户要求）
新建 `doc/design/2026-07-30-agent-server-student-teacher-reconnect-changes-and-decisions.md`：B 决策、三腿设计、依据（本方案全部内容）；INDEX/progress 同步。

### S2 omlx 探针（两项未验证）
1. key 有效性：`curl -H "Authorization: Bearer <config.toml:18 key>" http://127.0.0.1:8000/v1/models`
2. `stop` 支持探针：带 `stop:["\n"]` 的计数请求，验证 omlx 是否截断（影响 ReAct 协议保真度，结果记录进决策记录——**即使不支持也不阻塞**：动作无效→"Nothing happens"恰是学生能力的度量；但需声明）

### S3 agent-gateway 改动（配置 + 1 处小代码，TDD）
1. `config.toml`：`[cloud.deepseek] enabled=true` + `base_url_env/api_key_env/model_env`；`routing.selected_cloud_provider="deepseek"`；`lobster-local-key` channel `cloud_egress_allowed=true` 且 `allowed_models` 加入客户端实际模型名（`deepseek-v4-flash` 等，修 C1）
2. **代码（修 C2）**：envelope 接受 `thinking` 字段——本地路径丢弃、升级云时透传（amend R04：显式声明新字段而非静默丢弃，测试覆盖：400→接受、本地不转发、云转发）；`uv run pytest` 全绿
3. 启动：`DEEPSEEK_BASE_URL=https://api.deepseek.com/v1 DEEPSEEK_API_KEY=<key> DEEPSEEK_MODEL=deepseek-v4-flash uv run python -m agent_gateway`
4. 验证：`/healthz`；`agent-auto` 中文请求（本地应答）；构造门控命中（forced tool 不调/空输出）→ 确认升级 DeepSeek 200 + trace sequence=2

### S4 agent-server 8789 重启（纯 env，零代码）
`GATEWAY_URL=http://127.0.0.1:8787 AGENT_GATEWAY_KEY=lobster-local-key` 重启 8789；curl 预检（stop/thinking 全链路：agent→8789→8787→DeepSeek 与 →omlx 各一条）。

### S5 ALFWorld 运行调整
- 当前 chained 任务（control-full → experiment-full 旧语义直连）**在控制臂完成前停止**，experiment 旧腿作废不启动；control-full（L1）若被中断用 `--start N` 续跑（JSONL append 已支持）
- 控制臂（L1）完成后：依次跑 L2（8787 直通）与 L3（8789）
- L3 实验臂 session 归档纪律不变

### S6 后续 benchmark（P2/P3）适配
QwenClawBench/Claw-Eval 实验臂同样指向 8789（已在它们臂切换配置内）；控制臂改指 8787（新增一个 provider/endpoint 配置项，零代码）。各自冒烟时验证。

### S7（可选，用户另行确认）生产 8788 接回
`.env` GATEWAY_URL 改 `http://host.docker.internal:8787` + compose 重建——让学生模型承担生产负荷。需 gateway `server.host=0.0.0.0`（容器→宿主已证 127.0.0.1 不通）。**本次不做，等评估结论。**

## 3. 风险与对策

| 风险 | 对策 |
|---|---|
| omlx 不支持 stop（C4） | S2 探针先行；不支持则记录偏差，评估按学生真实能力解读 |
| gemma-12B ALFWorld SR 过低（趋零）致 L2/L3 无区分度 | L1 参考腿保留；若全零，报告标注并升级学生模型选型（另行立项） |
| gateway 延迟回放（stream=整段生成后回放） | 评估客户端非流式为主，无影响 |
| 升级响应丢 reasoning_content | 客户端已 thinking=disabled，无 reasoning 产生 |
| DLP 误伤含密钥样例的会话 | by design，记录发生频率 |

## 4. 验收标准

1. gateway `uv run pytest` 全绿（含 thinking 新用例）；8787 三验证（healthz/本地应答/升级 trace）
2. 8789 重启后 stop+thinking 全链路 curl 预检通过
3. ALFWorld 三腿各完成 134 局，产出 L1/L2/L3 SR 对照 + 成本 + 失败分类
4. 决策记录/INDEX/progress 更新，commit 合规
