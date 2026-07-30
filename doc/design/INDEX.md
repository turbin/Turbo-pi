# design 目录索引（INDEX）

维护说明：本索引概述 `doc/design/`（目录名带前导空格）下每份文档的内容，并记录从 agent-server P0 起各阶段决策的变化时间线。**新增设计文档时请同步更新本索引。**
最后更新：2026-07-25（覆盖 E1 决策记录）。

阅读指引：
- **通用约束 canonical 版本**（工程内改动、omlx 不可动、提交格式、git 纪律）：`2026-07-22-agent-server-p3-candidate-tasks.md` 的"通用约束"一节，后续任务书均为引用。
- 每个阶段的入口文档：阶段 spec/plan → 任务决策记录 → live 验证 → closeout/验收报告。

---

## 一、文件索引（按阶段分组）

### 阶段 0：agent-gateway（2026-07-14 ~ 07-18，背景层）

| 文件 | 内容 |
|---|---|
| 2026-07-14-agent-gateway-team-review.md | 架构评审判原方案 No-Go，给 P0 修订清单（证据门控、egress 默认关、CAS 状态机、规则学习退出 V1） |
| 2026-07-14-local-agent-model-gateway-design.md | 网关唯一规范源（Conditional Go）：V1-R01~R10 约束、A01~A11 验收、端口/模型、延迟流式 |
| 2026-07-17-agent-gateway-implementation-plan.md | 新增独立 Python 包的可行性评估与 5 天切片实施计划 |
| 2026-07-17-agent-gateway-changes-and-decisions.md | gateway 实施决策记录：TDD、砍 rules/memory 模块、密钥哈希落盘、延迟 SSE |
| 2026-07-18-agent-gateway-v1-finalization-plan.md | V1 收尾计划：live 验证 A05-A10 + Phase 2 修 minor 1-4 |
| 2026-07-18-agent-gateway-live-verification.md | A01-A11 全部现场验证通过（167 测试）；omlx 实际在 8367 且要鉴权；客户端从 LobsterAI 换 Kimi Code |
| 2026-07-18-agent-gateway-live-decisions-summary.md | 截至 07-18 的 gateway 全部关键决策长期记忆汇总（D-01~D-07 + 17 条历史决策表） |

### 阶段 1：agent-server P0（2026-07-18 ~ 07-19）

| 文件 | 内容 |
|---|---|
| 2026-07-18-agent-server-experience-replay-spec.md | 方案 C 分层架构 spec：TS agent-server 经验代理层 + Python gateway 模型路由层；检索/注入/SOP 上限定义 |
| 2026-07-18-agent-server-v1.1-p0-plan.md | P0 实施计划（10 Task）：Fastify + better-sqlite3；skill/SOP 注入明确推迟 P1 |
| 2026-07-19-agent-server-task1-bootstrap-changes-and-decisions.md | 包引导：依赖锁精确版本、vitest 4、`.ts` 后缀相对导入 |
| 2026-07-19-agent-server-task3-retrieval-changes-and-decisions.md | 检索：FTS bm25 + 标准集合余弦重排（修正计划草图公式）、CJK 前缀查询 |
| 2026-07-19-agent-server-task4-injection-changes-and-decisions.md | 注入组装：EVIDENCE/Method/Guard 合成 user 消息插最后真实 user 前；注入层过滤 removed |
| 2026-07-19-agent-server-task5-openai-compat-changes-and-decisions.md | pi-ai→OpenAI 映射：自包含映射器（否定 spec 的"复用 packages/ai"） |
| 2026-07-19-agent-server-task6-gateway-client-changes-and-decisions.md | gateway 客户端：类型化请求体、key 解析顺序（参数 > env > 默认） |
| 2026-07-19-agent-server-task8-proxy-handler-changes-and-decisions.md | proxy 全管线：tee 保证 writer 恰好关一次、session 文件名加 UUID、依赖注入 |
| 2026-07-19-agent-server-task9-toolcall-validation-changes-and-decisions.md | toolCall 出站校验 + SSE 事件转换合并一程；length 整批拒绝；未知工具拒绝 |
| 2026-07-19-agent-server-task10-mock-benchmark-changes-and-decisions.md | mock benchmark runner：真实管线跑指标（recall@12、token 开销、toolcall 通过率） |

### 阶段 2：agent-server P1（2026-07-19 spec → 07-21 closeout）

| 文件 | 内容 |
|---|---|
| 2026-07-19-agent-server-p1-spec.md | P1 工程规格：SKILL/SOP 注入、离线进化闭环（ETL→三管线→verifier≥0.5→checkpoint）、pi v3 session JSONL |
| 2026-07-19-agent-server-p1-plan.md | P1 实施计划（10 Task）：Python 子进程离线管线（spawn）、session 格式替换 P0 自定义格式 |
| 2026-07-20-agent-server-task1-skill-catalog-changes-and-decisions.md | SKILL catalog `<available_skills>` 注入；新增 `listActive()` 取代空 FTS 查询 |
| 2026-07-20-agent-server-task2-sop-schema-changes-and-decisions.md | SOP 经验组装为 OpenAI function schema |
| 2026-07-20-agent-server-task3-injection-integration-changes-and-decisions.md | buildInjection 集成 skill/SOP：async 化、上限 10/15、冲突时客户端 tool 优先 |
| 2026-07-21-agent-server-task6-offline-pipeline-changes-and-decisions.md | 离线管线子进程调用器：可注入 spawnFn、vendored Python 入库、真实 e2e 测试 |
| 2026-07-21-agent-server-task7-verifier-canonicalize-changes-and-decisions.md | TS 晋升门控：阈值 0.5、SOP 固定 quality=1、**cards 五元组统一存 EVIDENCE**（C 任务修正此决策）、contentHash 三层判定 |
| 2026-07-21-agent-server-task8-session-jsonl-changes-and-decisions.md | SessionWriter 重写为 pi 原生 v3；评审修复：done 时重建 assistant message 条目 |
| 2026-07-21-agent-server-task9-scheduler-checkpoint-changes-and-decisions.md | runDailyEvolution + checkpoints 表；metric=晋升条目数；**触发外部化，server 不背定时职责** |
| 2026-07-21-agent-server-p1-live-verification.md | P1 live E2E 9 项全 PASS；live 修复 system 消息 400 bug；ETL 407 条 dormant |
| 2026-07-21-agent-server-p1-closeout-and-p2-followups.md | P1 收尾台账（116 测试）+ P2 立项 5 项 + 低优先级 follow-up 清单 |

### 阶段 3：agent-server P2（2026-07-22，本会话执行）

| 文件 | 内容 |
|---|---|
| 2026-07-22-agent-server-p2-plan.md | P2 八任务分解方案存档（token 评估、依赖顺序、实际执行偏差记录） |
| 2026-07-22-agent-server-p2-task1-server-cleanup-changes-and-decisions.md | debug dump 开关化（AGENT_SERVER_DEBUG_DUMP）+ inline import 清零 |
| 2026-07-22-agent-server-p2-task2-retrieval-filter-changes-and-decisions.md | FTS 检索 SQL 层过滤 status='active'（P0 注入层过滤决策的下推修正）+ content_hash 索引 |
| 2026-07-22-agent-server-p2-task3-streaming-session-changes-and-decisions.md | 流式路径 session 落盘：raw SSE 透传不变，tee 解析重建 assistant message |
| 2026-07-22-agent-server-p2-task4-custom-message-changes-and-decisions.md | custom_message 记录注入后完整上下文，两条路径都接 |
| 2026-07-22-agent-server-p2-task5-benchmark-wiring-changes-and-decisions.md | benchmark 接线：pipelineOptions > option > env 优先级 + example 文件 |
| 2026-07-22-agent-server-p2-task6-dormant-loop-changes-and-decisions.md | dormant 完整闭环：Python --rescore（vs_reference 口径）+ 重评分晋升 + TTL/cap 清理；checkpoint metric 口径变化 |
| 2026-07-22-agent-server-p2-task7-followup-cleanup-changes-and-decisions.md | follow-up 批量清理 10 项（事务化、checkpoint 幂等、SessionWriter 加固等） |
| 2026-07-22-agent-server-p2-live-verification.md | P2 live E2E 8 项全 PASS（流式落盘/custom_message/dormant rescore/benchmark） |
| 2026-07-22-agent-server-p2-closeout.md | P2 收尾：P1 立项事项闭环对照 + P3 候选清单 |

### 阶段 4：agent-server P3（2026-07-22，分发执行）

| 文件 | 内容 |
|---|---|
| 2026-07-22-agent-server-p3-candidate-tasks.md | **P3 任务书 + 全项目通用约束 canonical 版本**（工程内改动、omlx 不可动等） |
| 2026-07-22-agent-server-p3-task1-real-llm-verification.md | 真实 LLM 验证 3 条 CLI；修复 P2 回归（teacher_from_env 误用改回 role=）+ verifier logprobs 文本回退 |
| 2026-07-22-agent-server-p3-task2-benchmark-derivation-changes-and-decisions.md | benchmark 从 session 规则化派生（零 LLM）：去重/上限/solvable 判定 |
| 2026-07-22-agent-server-p3-task3-toolcall-validation-changes-and-decisions.md | 流式 toolCall 校验 observe-only：共享核心 validateAccumulatedToolCalls + toolcall_validation 条目 |
| 2026-07-22-agent-server-p3-task4-tsconfig-changes-and-decisions.md | 删除包级 tsconfig 统一根配置；含执行约束留档 |
| 2026-07-22-agent-server-p3-closeout.md | P3 收尾（注意：其中测试统计数字曾失真，已被验收报告修正） |
| 2026-07-22-agent-server-p3-acceptance-report.md | P3 两次验收全记录：初验有条件不通过（P3-3 缺测试）→ 返工 → 复验通过；含 P2 回归发现 |

### 阶段 5：A2/B3 与 C（2026-07-22，当前）

| 文件 | 内容 |
|---|---|
| 2026-07-22-agent-server-a2-b3-tasks.md | A2（verifier 回退单测）+ B3（离线调度定时化方案 A+）任务书 |
| 2026-07-22-agent-server-a2-verifier-fallback-tests-changes-and-decisions.md | A2 决策记录：27 个 pytest case 覆盖回退路径；Python 测试不进 CI |
| 2026-07-22-agent-server-b3-evolution-scheduling-changes-and-decisions.md | B3 决策记录：CLI 三模式、失败 checkpoint 三态语义、安装助手红线、P1 外部化决策维持 |
| 2026-07-22-agent-server-c-ability-distillation-design-and-tasks.md | **C 方案（当前最新）**：ABILITY 提炼 5 项决策（全部暂定待迭代）+ 方案设计 + C1/C2/C3 TODO 任务清单（含强制 TDD 流程、C1/C2 具体测试用例表、C3 BDD 验收场景、已知限制：type 变更并存行） |
| 2026-07-22-agent-server-c1-cards-role-routing-changes-and-decisions.md | C1 决策记录：cards 按 role 精确等值分流 ABILITY/EVIDENCE；10 条用例逐条对应；scheduler/verifier 3 处既有断言修正说明 |
| 2026-07-22-agent-server-c2-injection-limits-changes-and-decisions.md | C2 决策记录：注入端 METHOD/GUARD_LIMIT=5；过滤→降序→截断固定顺序；9 条用例逐条对应 |
| 2026-07-22-agent-server-infra-node-pinning-and-container-changes-and-decisions.md | 基础设施决策：Node 25.9.0 仓库内固定（.tools + with-node25.sh）、agent-server 容器化（Dockerfile/compose/loop 调度）、tm/temp 入 gitignore |
| 2026-07-23-agent-server-c3-live-verification.md | C3 live 验证：3 BDD 场景执行记录（进化管线、SQL 审计、注入路径验证、截断观察）；管线只产 Workflow cards（MockLLM 关键词门控，session 轨迹未命中 Method/Guard 关键词）——代码路由正确，数据面未触发分流（根因表述经 07-23 验收修正） |
| 2026-07-23-agent-server-c3-observation-baseline.md | C3 观察基线：库存全景、quality 分布、并存行统计（当前 0）、截断状态、checkpoint 历史、会话特征——"上线运行后迭代"对照起点 |
| 2026-07-23-agent-server-c3-acceptance-report.md | C3 验收报告：**通过**（213 测试全绿、DB 数字独立复核一致；修正 MockLLM 根因误述——关键词门控而非固定 Workflow；场景 2 走临时注入服务为已记录偏差；场景 1 条件性 PASS 已被同日 follow-up 升级为完整 PASS） |
| 2026-07-23-agent-server-c3-followup-natural-method-changes-and-decisions.md | C3 follow-up：构造含 retry/backoff 关键词 session 重跑进化，自然 Method ABILITY 入库（场景 1 升级为完整 PASS）；基线全量刷新；新发现 FTS 拉丁正文不可检索（仅记录，建议单独立项） |

### 阶段 6：Post-C 运维化（2026-07-23 立项，进行中）

| 文件 | 内容 |
|---|---|
| 2026-07-23-agent-server-post-c-tasks.md | **N1/N2/N3 任务书（当前最新）**：N1 FTS tokenizer 修正（拉丁整词 + CJK bigram + 重建 CLI，含 10 条 TDD 用例表）、N2 Docker 镜像首次构建验证（colima 红线）、N3 上线观察期启动（dry-run 审查 + 安装指令 + 观察 runbook） |
| 2026-07-23-agent-server-n1-fts-tokenizer-changes-and-decisions.md | N1 决策记录：tokenizeForFts 重写（拉丁整词 + CJK char/bigram 对齐 retrieval.ts）、FTS 重建 DROP+CREATE 方案（外部内容表 DELETE 不可用）、rebuild-fts CLI（--dry-run）、不自动迁移；10 条 TDD 用例全绿 + live sanity（jitter 0→2 命中） |
| 2026-07-23-agent-server-n2-docker-build-changes-and-decisions.md | N2 构建验证：首次成功构建 agent-server:local（145MB）；Dockerfile 3 处修改（移除 npm run build、npm ci 不跳 scripts、NPM_REGISTRY/NODE_DISTURL/HOST 参数）+ server.ts HOST 环境变量；单容器冒烟 + compose 双服务 checkpoint 确认 |
| 2026-07-23-agent-server-n3-go-live-changes-and-decisions.md | N3 上线观察期启动：dry-run 审查（doctor/install/uninstall 三命令）；重点审查项——plist 无 env 变量（EXPERIENCE_STORE_PATH 无需设置、AGENT_SERVER_BENCHMARK 需手动添加、PYTHONPATH 由代码自行设置）+ Node PATH 问题（LaunchAgent 环境 PATH 受限，推荐 with-node25.sh 方案）；安装/卸载/自查指令（agent 未执行 install）；观察 runbook 交付 |
| 2026-07-23-agent-server-observation-runbook.md | 观察 Runbook：每周对照基线 SQL 集（§1 库存/§3 quality/§4 并存行/§5 截断/§6 checkpoint）、触发评审动作表（C 方案 5 项决策观察项）、客户端接线说明（Kimi Code → 8788 → 8787 → 8000）、周报模板（附录 A） |
| progress/README.md | progress 目录规范：里程碑单文件方案、状态值、更新纪律（认领即写/完成即写/中断必写/随工作提交） |
| progress/2026-07-23-post-c-operations.md | Post-C 里程碑进度与交接：N1-N3 状态表、跨 agent 共享环境事实、断点恢复指引 |
| 2026-07-24-agent-server-n2-closeout-deepseek-teacher-changes-and-decisions.md | N2 收尾（容器 DeepSeek 进化 metric=11 验证通过）+ N3 安装（TCC 外置卷阻塞实证 + 用户拍板 compose sidecar）+ DeepSeek teacher 切换（verifier 回退链修复、session 目录 env 修复、CA 证书、管线超时 env、compose 代理透传）；测试基线 229 vitest + 29 pytest |
| 2026-07-24-agent-server-weekly-report-changes-and-decisions.md | 观察周报自动化：weekly-report sidecar（168h 循环，机械汇总 + 触发判定，不含解读）；compose 新服务；runbook §1.1 同步；236 vitest 全绿 |

### 阶段 7：E 评估里程碑（2026-07-24 立项，进行中）

| 文件 | 内容 |
|---|---|
| 2026-07-24-agent-server-eval-benchmark-tasks.md | **E0-E4 任务书（当前最新）**：benchmark 自动化评估环境——SWE-bench Lite + Terminal-Bench 2.0 双臂 A/B（对照直连 DeepSeek vs 实验经 agent-server），成功判据预定义（注入无害 + 飞轮有效 + 成本同报），含 arm64/代理/DB 隔离/成本四坑对策 |
| progress/2026-07-24-eval-benchmark.md | E 里程碑进度与交接：E0-E4 状态表、环境事实（评估实例 8789、GATEWAY_URL 不带 /v1、代理/CA 对策） |
| 2026-07-24-agent-server-e0-eval-instance-changes-and-decisions.md | E0 决策记录：评估实例 8789 全链路验证；**修复非流式响应丢 tool_calls 阻塞性 bug**（finish_reason/usage 同步映射 OpenAI 形状）；harness 选型 mini-swe-agent（Kimi/pi 不做被测 agent 的三条理由）；venv 需 Python ≥3.12；mini 非交互三坑解法 |
| 2026-07-25-agent-server-e1-ab-harness-changes-and-decisions.md | E1 决策记录：litellm host bug（绕过方案：openai 直连最小 agent）；harness.py 双臂脚手架；smoke-02 两臂 5/5（kimi 验收修正：token delta 归因轨迹方差而非注入、日期修正） |
| 2026-07-24-agent-server-e2-terminal-bench-tasks.md | **E2 任务书**：TB 2.0 89 任务 A/B——E2.0 三项环境探针（Docker Hub 拉取/litellm 容器内/容器→8789 连通）→ E2.1 子类化 MiniSweAgent（OPENAI_BASE_URL 臂切换）→ 5 任务冒烟报价 → 89 全量；R1-R5 风险对策 |
| 2026-07-25-agent-server-e2-acceptance-report.md | E2 验收报告：**有条件不通过**——E2.2 双臂 6 次 trial agent 均未启动（broken-python 镜像 pip 故意破坏 + 安装脚本不 fail-fast），决策记录 3 处误报（含“pip 太慢”误诊断）；5 条返工清单；E2.0 探针/adapter 结构保留有效 |
| 2026-07-25-agent-server-tb-smoke-case-design.md | TB 冒烟用例设计：5 用例（盲迷宫/座位 CSP/文物破译/ACL 权限/日志分析）的内容、测试目的、测试方法与判读规则；选择原则（pip 可用验证、4 类覆盖、轻量、确定性判分） |
| 2026-07-25-agent-server-eval-report-design.md | **E4 总评估报告设计**：三层证据（L1 A/B / L2 飞轮 / L3 生产观察）、6 项指标固定口径（含注入命中明细）、判定规则预注册（成功/部分成功/失败 + 噪声级）、8 节报告模板——先于数据产生，防按结果改判据 |

### 阶段 8：O 可观测性（2026-07-27，已完成）

| 文件 | 内容 |
|---|---|
| 2026-07-27-agent-server-observability-spec.md | O SPEC：术语对齐（本地=经验库/远程=DeepSeek）、request_traces 表、/api/stats/hit-rate + /stats 页面、req= 结构化日志、request id 传播、8 条 TDD 用例表；保守路线（零新依赖） |
| 2026-07-27-agent-server-observability-changes-and-decisions.md | O 决策记录：trace 存 experience.db、两阶段 upsert、零框架页面；live 验证（命中/未命中各 1 请求，hitRate 0.5 页面可查，日志 req= 关联）；246 vitest 全绿；已知限制（stream 列恒 1、req-N 进程内单调） |
| 2026-07-25-agent-server-e2-terminal-bench-changes-and-decisions.md | E2 决策记录：E2.0 三项探针全通过（Docker Hub 需 colima 代理；litellm Linux 容器正常；8789 需 HOST=0.0.0.0）；E2.1 adapter 写毕（MiniSweAgentProxy）；E2.2 验收不通过→返工→**07-28 复验通过**（控制 1/3、实验 2/3，126 sessions 含真实 token；§8.4 复验记录） |
| 2026-07-28-agent-server-e2-wheelhouse-relay-changes-and-decisions.md | **E2.3 前置条件闭环**：离线 wheelhouse（96 wheel/178MB，cp312+cp313，容器内 `--no-index` 秒级安装）+ 宿主中继 deepseek_relay.mjs:8899（VM→DeepSeek 间歇断流，控制臂 LLM 流量改走宿主）；验证：blind-maze 控制臂 mini 真实跑 32 步 0 连接错误；252 vitest 全绿 |

### 阶段 7：R 真实化（2026-07-23 立项，同日收口）

| 文件 | 内容 |
|---|---|
| 2026-07-23-agent-server-r-real-teacher-tasks.md | **R 任务书（当前最新）**：R1 真实 LLM teacher 全链路 E2E（含 rescore 超时治理）、R2 Mock vs 真实对照评估与切换建议、R3 C-重 Go/No-Go 评审 |
| 2026-07-23-agent-server-r1-real-teacher-e2e-changes-and-decisions.md | R1 决策记录：真实 teacher 全链路 2m31s 通过（4 张新 Method、quality 脱离 Mock 关键词档）；rescore 因 dormant=0 未触发，超时暂不治理（触发条件记录） |
| 2026-07-23-agent-server-r2-mock-vs-real-evaluation.md | R2 对照评估：role 偏倚为 Mock 门控产物（真实单轮 4 Method 0 Workflow）；截断与并存行两触发条件命中但均评审无需动作；切换真实 teacher 的 plist 指令（用户动作）+ 成本估算（增量派生观察项）；基线已刷新为真实 teacher 版 |
| 2026-07-23-agent-server-r3-c-heavy-review.md | R3 评审：**C-重 No-Go**（真实 teacher 下 C-轻成立，重启条件明确）；两触发评审正式结论（截断不可惜上限维持、并存行非重复不清理）；runbook §3 判读规则修订 |
| progress/2026-07-23-r-real-teacher.md | R 里程碑进度与交接：R1-R3 状态表、LLM 切换机制等共享环境事实、断点恢复指引 |

进度跟踪目录 `doc/design/progress/`：每个里程碑一个进度文件，多 agent 交接 + 断点恢复用；规范见 `progress/README.md`。

---

## 二、决策变化时间线（P0 起）

标注：【立】新决策 【改】修正/取代既有决策 【废】决策作废 【留】遗留待办 → 后续关闭情况

### P0（07-18 ~ 07-19）

- 【立】方案 C 分层：TS agent-server（经验代理）+ Python gateway（模型路由），gateway 167 测试不动
- 【立】检索：FTS bm25 top-24 → 余弦重排 top-8；SOP schema ≤15 上限
- 【立】P0 用自定义 JSONL 落盘，pi 格式对齐推迟 P1 → **P1 被替换**（见下）
- 【立】注入层过滤 `status="removed"` 作为最后防线 → **P2 下推为 SQL 层过滤**
- 【改】余弦公式：计划草图 intersection/sqrt(union) → 标准集合余弦（task3）
- 【改】openai-compat：spec 说复用 packages/ai → 自包含映射器（task5）
- 【改】SSE 处理：task8 原样透传 → task9 校验+事件转换合并一程
- 【立】toolCall 校验：length 整批拒绝、未知工具拒绝、缓冲到最后校验

### P1（07-19 ~ 07-21）

- 【改】session JSONL：P0 自定义格式 **作废**，替换为 pi 原生 v3（header + id/parentId 树 + custom entry）
- 【改】session 格式细节：p1 计划草图（version 1、数字时间戳、`name` 字段）不符合真实 pi 格式 → 以真实 v3 为准（ISO timestamp、`customType`）
- 【改】assistant 回复记录：初版只记 stream_event → 评审发现回放丢轮次 → done 时重建 assistant message 条目
- 【立】离线闭环：ETL → 三 Python 管线（子进程 spawn）→ verifier ≥0.5 → canonicalize → checkpoint；算法全留 Python，TS 只做门控
- 【立】SOP 无分数固定 quality=1.0（占位语义，待 Stage 3 抽检）——**至今仍为占位**
- 【立】cards 五元组统一存 EVIDENCE，role 留 payload → **C 任务修正为按 role 分流 ABILITY**
- 【立】无负面经验库：低分轨迹直接丢弃——**至今有效，C 决策 3 再次确认维持**
- 【立】checkpoint metric = 晋升条目数（改自计划的抽取计数和）→ **P2 再变**（见下）
- 【立】触发外部化：server 不背定时职责 → **B3 维持此决策**（方案 A+ 用 CLI + cron/k8s）
- 【改】空 FTS 查询作废：`search("")` 抛 fts5 语法错误 → 新增 `listActive()` SQL 查询
- 【留】P1 closeout 遗留 5 项 → **P2 全部关闭**

### P2（07-22）

- 【改】检索过滤：注入层过滤 removed → SQL 层 `status='active'` 过滤（dormant 也不再污染 bm25 top-24）；回归教训：测试误用 search 断言 dormant 行
- 【立】debug dump 开关化：/tmp 无条件落盘（server.ts + gateway-client.ts 两处）→ AGENT_SERVER_DEBUG_DUMP=1 默认关
- 【立】流式路径 session 落盘（P1 finding 22 关闭）：raw SSE 透传契约不变 + tee 解析记录
- 【立】custom_message（P1 finding 23 关闭）：注入后完整上下文随会话重放
- 【立】benchmark 接线：手动文件 + 三级优先级（pipelineOptions > option > env）
- 【立】dormant 闭环：--rescore vs_reference 口径重评分 + TTL 30 天/cap 10000 清理；**低分行不删、下轮重试**
- 【改】checkpoint metric：晋升条目数 → promoted + promotedFromDormant
- 【立】promotion 事务化 + checkpoint INSERT OR IGNORE 幂等
- 【改】OpenAICompatClient 构造：P2 Task7 误改 teacher_from_env（skill_evolution 客户端无此方法）→ **P3-1 改回 role="teacher"**（P2 引入的回归）
- 【留】P3 候选 4 项 → **P3 全部关闭**

### P3（07-22）

- 【立】真实 LLM 路径：verifier 无 logprobs 时文本回退（MLX 后端限制）
- 【立】benchmark 派生：**仅生成文件**（用户拍板），scheduler 不自动派生——上线后可重新评估
- 【立】流式 toolCall 校验：**observe-only**（不阻断），阻断式留作后续增强
- 【改】包级 tsconfig：删除，统一根 config
- 【立】通用约束成型：改动仅限工程内、omlx 不可动、需工程外配合先报告
- 【改】流程教训（非代码决策）：执行 agent 文档测试数字失真、提交缺 conventional 前缀 → 写入后续任务书约束

### A2/B3（07-22）

- 【立】失败也写 checkpoint："没跑过"与"跑挂了"可区分；/api/evolution/status 三态语义（404/200 成功/200+metric 0 失败）
- 【立】配置简化走 install 命令 + dry-run 红线，不做配置页面
- 【立】容器部署：k8s CronJob 推荐、compose sidecar 用 --loop；P1 触发外部化决策不变

### C（07-22，当前最新，全部暂定待上线后迭代）

- 【改】cards 按 role 分流：Method/Guard → ABILITY（修正 P1 task7 的"统一存 EVIDENCE"）
- 【立】Method/Guard 阈值暂沿用 0.5；注入端各限 quality 前 5 条
- 【立】维持无负面经验库；本期不做 edges/合并
- 【立】**元原则：所有决策为暂定，上线运行一段时间后按观察基线迭代**

### C3 live 验证（07-23）

- 【立】观察基线固化：零自然 Method/Guard 产出，库存 Stats + 迭代建议 → **同日 follow-up 刷新**（自然 Method 1 条入库，库存/分布更新）
- 【观】FTS5 content=experiences 同步：`ExperienceStore.insert()` 路径正常，直接 INSERT 不触发
- 【观】MockLLM 默认 role=Workflow：当前 session 数据 + benchmark 样本不足以触发真实 teacher 路径的 Method/Guard 分支 → **follow-up 证伪“不足以触发”：构造含关键词 session 即触发**

### R 真实化（07-23 立项）

- 【立】R 里程碑立项：真实 LLM teacher 全链路验证 + Mock/真实对照评估 + C-重提前评审；动因是基线 §8.1/§8.4 的 Mock 路径结构性失真（评分关键词驱动、role 偏 Workflow）
- 【留】P3-1 发现的 rescore 真实 LLM 超时（120s/12 次调用）→ R1 未复现（dormant=0 未触发），维持暂不治理，触发条件：dormant 积压后真实 run 超时
- 【验】R1 通过：真实 teacher 下同 5 session 产 4 张 Method（Mock 仅 1），role 分布失真解除；quality 0.724-0.731 脱离关键词档，但区分度有限待 R2 评估
- 【评】R2：切换真实 teacher 建议交付（plist env 指令，用户动作）；两触发评审形式命中——Method 库存 6 截断（被截不可惜，上限维持）、并存行 proxy 0→3（同轨迹不同 role 非重复，不立项清理）；新观察项：增量派生、rescore 规模化、verifier 回退粒度粗
- 【评】R3：**C-重 No-Go**——真实 teacher 下 C-轻单轮产 4 Method，C 决策 1 观察项评审关闭；重启条件：真实 teacher 连续 4 周产量 0 或 quality 聚集致排序失效。R 里程碑同日收口

### C3 follow-up（07-23）

- 【立】场景 1 完整化：构造含 retry/backoff 关键词的最小 session（user+assistant 两条消息）重跑 runDailyEvolution，自然 Method ABILITY 入库（quality 0.652847），场景 1 由条件性 PASS 升级为完整 PASS
- 【立】增量重跑验证幂等：不清 DB 直接重跑，旧 cards contentHash 去重跳过、ETL 幂等，与 cron 日常运行形态一致
- 【观】FTS 拉丁正文不可检索：tokenizeForFts 对非 CJK 也逐字拆，词查询只命中未拆字的 title 列；中文靠 bigram 不受影响 → 写入基线迭代建议第 5 条，建议单独立项修正

### N2 收尾 + DeepSeek teacher 切换（07-24）

- 【立】teacher 切 DeepSeek：LLM_MODEL=deepseek-v4-flash（评分）/ TEACHER_MODEL=deepseek-v4-pro（抽取）；该账户无 deepseek-chat（实测 /v1/models 只有 v4-pro/v4-flash）
- 【立】verifier 回退链：logprobs 期望化失败 → 文本解析（DeepSeek 拆 tag 多 token、评分位可无字母）；仍失败才抛错，不静默给分
- 【改】N2 metric=0 真实根因：离线调度不认 AGENT_SERVER_SESSION_DIR（此前归因"无 gateway"不准确）→ run-evolution.ts 透传修复
- 【立】容器 HTTPS：宿主 PAC 代理 MITM colima VM 流量 → HTTPS_PROXY=host.docker.internal:7897；镜像补 ca-certificates；管线超时 env AGENT_SERVER_PIPELINE_TIMEOUT_MS
- 【立】N2 metric>0 验证通过：容器内 DeepSeek 进化 metric=11；compose + .env 一条命令部署（B3 compose 分支落地）
- 【观】TCC 外置卷阻塞：launchd 子进程对 /Volumes/extern-1T-hardisk 读写均被拒 → launchd 日调度在此机不可行；**用户拍板（07-24）：日常调度用 compose sidecar**（launchd plist 已卸载删除）
- 【废】gateway/omlx 作为离线进化 LLM 路径：gateway 拒 logprobs 参数；omlx 评分文本偶发为空 + 超时 → 离线管线直连 DeepSeek

### E 评估里程碑（07-24 ~ 07-25）

- 【立】E1 harness 绕过 litellm：eval/.venv 中 litellm 1.93.0 有连接 bug（`[Errno 8] nodename nor servname`），openai 直连正常；E1 改用 openai 客户端直连 + 最小 Bash agent，不依赖 mini-swe-agent
- 【立】E1 proxy 隔离：harness 启动时强制清除 HTTPS_PROXY/HTTP_PROXY 等（.env 中为 docker 设置的 host.docker.internal 代理在宿主机不解析）
- 【立】E1 防泄漏：实验臂每轮结束后将 var/eval/sessions/ 归档并清空，确保下一轮从空库起跑
- 【验】E1 smoke-02：两臂各 5/5 通过，实验臂 token +38%（注入开销，冷库注入为空块），session 归档机制验证通过

---

## 三、当前生效的关键决策速查（living decisions）

| 领域 | 现行决策 | 来源 |
|---|---|---|
| 架构分层 | TS agent-server（经验代理，8788）+ Python gateway（模型路由，8787）+ omlx（8000） | P0 spec |
| 检索 | FTS bm25 top-24（SQL 过滤 active）→ 余弦 top-8 | P2 task2 |
| 注入 | SKILL catalog ≤10、SOP schema ≤15、EVIDENCE/Method/Guard 合成消息、**Method/Guard 各限 5**（C2 已实现） | P1 + C |
| session 格式 | pi 原生 v3 + custom_message + 流式全量落盘 | P1 task8 + P2 task3/4 |
| 离线闭环 | ETL → 三管线 → ≥0.5 晋升 → dormant rescore → TTL/cap 清理 → checkpoint（含失败） | P1 + P2 task6 + B3 |
| 晋升阈值 | 0.5 统一（SOP 例外固定 1.0 占位） | P1 task7 |
| ABILITY | cards role 分流 Method/Guard（C-轻，C1 已实现；07-23 follow-up 验证自然 Method 入库） | C 决策 1 |
| 触发 | 外部化：run-evolution CLI + cron/launchd/k8s/--loop | B3 |
| 负面知识 | 不建负面库，低分丢弃，Guard 只来自验证通过的 cards | P1 + C 决策 3 |
| 工程约束 | 改动仅限工程内、omlx 不可动、提交格式 COMPLETED/TODO/Refer Spec + conventional 前缀 | P3 任务书 |
