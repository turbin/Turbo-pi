# design 目录索引（INDEX）

维护说明：本索引概述 `doc/design/`（目录名带前导空格）下每份文档的内容，并记录从 agent-server P0 起各阶段决策的变化时间线。**新增设计文档时请同步更新本索引。**
最后更新：2026-08-28（阶段 14 自我进化工程蓝图更新至 V3——Kimi × Codex 对抗审核补齐可执行信任边界、验证隔离、签名审计、四层状态模型与受限源码 ABI；不授权实施或跑批）。

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

### 阶段 9：E 评估改道（2026-07-30，进行中）

| 文件 | 内容 |
|---|---|
| 2026-07-30-agent-server-eval-benchmark-pivot-changes-and-decisions.md | **E 里程碑 benchmark 替换【用户拍板】**：Terminal-Bench/SWE-bench 弃用（TB 全量中止，8 trial 数据归档）；E2'=ALFWorld（134 局，自写 ReAct loop）、E3'=QwenClawBench（100 任务，OpenClaw harness）、E4'=Claw-Eval 文本子集（199 任务）；judge=deepseek-v4-pro；三 benchmark 臂切换均零代码（端点配置）；预估总成本 $20-35 |
| 2026-07-30-agent-server-student-teacher-reconnect-changes-and-decisions.md | **学生-老师链路接回【用户拍板选 B】**：omlx 学生模型零负荷问题——agent-gateway 开 DeepSeek 云升级 + channel 出云 + envelope 显式接受 thinking（本地弃/云透传）；8789 env 改指 8787；**三腿实验设计**（L1 DeepSeek 直连参考 / L2 学生管线基线 / L3 学生管线+注入）；omlx 双探针过（key/stop）；生产 8788 接回推迟 |
| 2026-08-03-agent-server-data-appendix.md | **论文用数据附录**：全量数据表（三腿总表/分类型 SR/E5 冷热对照/经验库形态/根因实验三表/原始数据清单与复算路径/方法论限定 5 条）+ 机读 CSV（alfworld-trials 536 行逐局、escalation-stats）——论文写作数据留存 |
| 2026-08-03-agent-server-evolution-pipeline-timeout-analysis.md | **进化管线失败根因分析**：输入规模失配（一请求一文件 × 一文件一轨迹 = 6372 轨迹 × 25-40 LLM 调用/轨迹 → 数天）；第 2 次 SIGKILL 超时证伪（27m45s<120min，消息格式只是拼接）+OOM 证伪（64GB 无 jetsam），来源未定论但随规模修正消失；证据链 mermaid + 代码行级证据；根治=agent-server 会话亲和（入 M5） |
| 2026-08-04-agent-server-c3-amendment-and-r2-evolution-input-changes-and-decisions.md | **C 决策 3 修正【用户批准】**：失败经验三层化（原始文本不入库/败局作归因输入/蒸馏验证 Guard 卡入库）+ R2 进料三路合并（学生+老师胜局+败局对照）+ 触发器门控→局级胜负迁移（27B 升级率 0% 使门控断粮）+ 教训卡必须程序化提取禁自由诊断（2605.29463 红线） |
| 2026-08-05-agent-server-injection-toggle-and-eval-preflight-changes-and-decisions.md | **注入开关 + preflight 门禁【用户重申目标驱动】**：`AGENT_SERVER_INJECTION=off` + 请求级 `injection` 覆盖，关时跳注入但 session/trace 照录（`disabled:true` 区分关与未命中）；**控制臂跑法变更=8789+injection off 同路径对照取代物理旁路**（基线轨迹进学习回路）；eval/preflight.py 按端口推导依赖链探活+nohup 自动拉起 8789/8787/8899 |
| 2026-08-14-agent-server-c-campaign-final-report.md | **C 阶段收口报告【预注册数值阈值机械通过；2026-08-21 自主性解释降级】**：①重复任务协议级升级率 D7 0%≤5% ②新任务 0%<20%；七日 U 型曲线（0.567→0.378→0.532）；归因 +10.3pp（对照臂自发劣化 -0.138 vs 实验臂 -0.035，记忆以抗劣化形态首次获对照级正证据）；issue-019 修订：0% 不能单独证明无需教师/模型自主性，须联合漏升级与明显失败指标，C 相关表述降级为历史探索性结论 |
| 2026-08-14-fix-batch-user-rulings-changes-and-decisions.md | **C 后统一修改方案用户五项裁决决策记录**：①27B 重跑取消转 9B 全量重跑 + 实验顺序决策点（office 先行→报告→确认→ALFWorld）②断点持久化翻转立项（最小断点）③SOP/SKILL 不做双轨、机制完善统一（F4）④交叉评估臂补 plan 立项 ⑤DLP 默认敏感列表（身份证号+密钥类，可扩充） |
| 2026-08-14-m1-t0-t1-changes-and-decisions.md | **M1（T0+T1）开发决策记录【实施完成，测试全绿】**：T0=F0 归因数据通道（requestId→randomUUID、injected_ids 实际注入集落库（SKILL/SOP 显式排除）、task_id 透传（campaign.py 必选 kwarg→session 头→trace）、/api/stream 定案**纳入 trace 落库**、旧库 PRAGMA+ALTER 迁移、upsert NULL 哨兵防阶段覆写）；T1=最小断点（打分按任务组增量落盘+fsync、输入哈希=轨迹内容+prompt 指纹防脏复用、`--resume <run_dir>` 幂等跳过、双副本收敛于 checkpoint 模块）；issue-013 转 fixed |
| 2026-08-14-m2-t2-changes-and-decisions.md | **M2（T2）开发决策记录【实施完成，测试全绿】**：F1 卡片交付物维度（issue-010 主体）——EXTRACTION_PROMPT/CARD_SCHEMA/cardsToStaged schema 三处加 deliverables（非空字符串数组）；交付检查双闸（Python 打分侧无交付轨迹 quality 封顶 0.49 且 accepted 强制 False、TS 闸门 Method/Guard 非空校验）；SOP/SKILL/EVIDENCE 显式豁免；检测器保守启发式（C 语料实证 4/98 误封顶安全方向）；DELIVERY_CAP_VERSION 入打分指纹；存量卡重蒸脚本 restill 交付（断点复用 ScoreJournal，冒烟 83 卡全链路通过，**全量重蒸待用户排期**）；issue-010 转 fixed（待观察） |
| 2026-08-14-m3-t3-changes-and-decisions.md | **M3（T3）开发决策记录【实施完成，测试全绿】**：F2 实战归因奖惩——eval/attribution.py 离线归因（样本单位=任务日、多卡共注入仅记数、≥3 失败任务日降权 min(c*0.5,0.3)、成功加分封顶 1.0、常量全部预注册）；experiences 增 confidence/rescore_excluded_batches 列（M1 迁移模式 + user_version 版本化 + 旧快照 readonly 兼容）；检索排序加权 cosine×confidence（quality 不动）；复升排除 N=3 批（阻断自评复升循环）；降级人工确认通道（--demote 清单）；PPT 混合组修复（m2 finding ①：无交付轨迹不参与锦标赛，DELIVERY_CAP_VERSION v2）；C 回放显式清单 + 逐行证据 provenance，后验标出 issue-010 致降分卡（confidence 0.5→0.25） |
| 2026-08-14-m4-t4-t5-changes-and-decisions.md | **M4（T4+T5）开发决策记录【实施完成，测试全绿】**：T4=F3 情景标签（issue-012 采纳项 5 落地）——payload 加 domain/task_pattern（可选，无标签不过滤）；写入双路径（蒸馏：合成器元数据透传 + 注册表回退；ETL：session task_id → 注册表打域）；在线 domain 通道（campaign.py/alfworld 必选 domain → session 元数据 + 检索过滤）；检索 bm25 后跨域排除、无标签放行；T5=F4 晋升统一——SKILL 定案**暂缓入库**（utility 无验证对象）、SOP quality=1 语义=预验证通过标记（SOP_PREVETTED_QUALITY）、红线 3 修订为"晋升统一过验证闸" + §3.3 局限声明更新（台账 5 闭环）；五类卡过闸/拦截/豁免回归 |
| D阶段实验设计补充评审_指标与条件检查.md | **GPT 补充评审：机制分解指标（2026-08-19 17:24 落盘）**：核心论点——现指标能判“有没有变好”但不能定位“坏在教师计划/Memory/检索/理解/执行/停止/Gate 哪环”；19 节新增建议全部作 Analysis Addendum v2——①Oracle Teacher Plan 诊断条件（A/B/C/D 四条件分解 MemoryGain/RetrievalLoss/ExecutionGap，最重要缺口）②命中拆命中/命中正确（UsefulHit/FalseHit/NegativeTransferRate）③Plan Adherence 族（Adoption/StepCompletion/Deviation/Replan）④Success@K 分布 ⑤Judge vs Functional Success ⑥Gate 混淆矩阵（FP 侧）⑦教师计划质量评估 ⑧Memory 生命周期（Utility/Reuse/Staleness/Conflict）⑨Context Budget（MemoryTokenRatio）⑩Treatment Compliance=100%（snapshot/hash 校验）⑪难度分层 ⑫失败迁移矩阵+RecoveryConversionRate ⑬回归/负迁移率 ⑭held-out 泄漏检查 ⑮重跑稳定性审计 ⑯教师成本摊销 ⑰七层指标体系 ⑱优先 8 项 ⑲“突破 30 轮”机制组合判定 |
| preview.html | **D 阶段 9B 实验设计增强版（HTML，生成 2026-08-19 15:43）**：主判据①-⑤预注册不变（D1 已起跑不后改），新增 Analysis Addendum——Q8 held-out transfer（Replay/Transfer Gain 分离）/Q9 bm25 deferred；假独立防护三指标（AutonomousSuccess/MissedEscalation/EscalatedSuccess）；D2 重定位为零差校准日（D2 时 current=frozen 同库）、D7 为库演进主因果日；2×2 全差分+交互效应；DiD；trajectory 指标族（CapHit=termination_reason==max_turns，不得以 requests==30 替代）；Memory 检索可观测字段表；写入隔离（X1/X3/X4 默认不进 evolution，eligible_for_evolution）；环境隔离（Base Env Snapshot 确定性克隆）；快照锁+task-block 随机臂序（反时间漂移）；Teacher/Judge 同源 audit；决策矩阵；解释红线 10 条 |
| 2026-08-19-9b-campaign-experiment-design.md | **D 阶段 9B 全量重跑批实验设计【判据预注册，D1 已起跑】**：D 阶段唯一整合设计稿（此前要素散落 §108 裁决/交叉臂 plan/任务书）；待验证问题 Q1-Q8（记忆增益复现/库演进×即时注入分解/9B 触顶率/F1-F4 实战有效性/升级率判据/length 持续性/bm25 deferred）；判据①-⑤预注册（升级率阈值沿 C + 记忆增益存在性 + C 式劣化不复现新增）；任务集/划分与 C 全同（D/C 可比）；交叉臂定案（用户 08-19 方案 A：四臂仅 D2/D7，冻结库=D1 夜间进化后快照）；9B 基线 0.327/length 0%/工期 4-5 天；风险登记 6 项 |
| 2026-08-19-d-stage-addendum-implementation-changes-and-decisions.md | **D 阶段增强设计落地（T1-T4）决策记录+主会话验收报告【验收通过】**：pi-dev-1/2 并行+pi-test 复核+主会话门禁（eval 149/vitest 346/gateway 195/check 链全过）；D-1~D-8——task-block sha256 臂序/termination 三态/held-out 8 选取（D1 切片显式剔除）/写入隔离 eligible-arms/假独立三指标/轨迹六指标启发式/request_traces retrieved_scores+injected_tokens（SCHEMA 1→2）/cross×held_out 污染修复（TransferGain 单列）；T5 文档对齐（md 标注取代+清单 H 节+交叉日 runbook+Kimi audit 协议）；遗留 5 项 |
| 2026-08-19-d-stage-cross-day-runbook.md | **D2/D7 交叉日 runbook【生效中】**：前置双快照+冻结实例→四臂跑批（启动式）→先对账再进化（snapshot lock）→Kimi audit 协议（抽样 6 任务/一致性双判据/不回写不替代）→异常处置表（sanity 超差停批/冻结实例挂当日作废） |
| 2026-08-23-d2-adversarial-review-and-amendments.md | **D2 对抗审查档案+设计修订【用户 08-23 批准四项】**：三甲乙丙两轮收敛——D2 数值 Grade A/无操作性混淆/零信息校准日；x4 零分真因=penalized hybrid 清零；修订①sanity 分级哨兵 0.10 注记/0.18 停机+置换 p<0.05 双条件（D7 前瞻生效不回溯）；修订②D7 判定规则预注册（主检验/复制判定/合并 α=0.10/敏感性/实例偏置 ABC 三级/禁止 D2 减法校正）；修订③D7 实例交叉（冻结库挂双实例 8790+8791 对半分任务）；D2 按机制校验通过定档继续收尾；E1 judge 缺失行登记 |
| 2026-08-19-d-stage-addendum-v2-main-review-and-decisions.md | **Addendum v2 主会话整体 review：GPT 19 节逐节对账【验收通过】**：17/19 全落地 + §六 FP 侧 deferred（升级样本触发 audit subset）+ §九 context_budget 补漏；Oracle/PlanAdherence/Success@K/Functional/Compliance/迁移矩阵/泄漏检查/重跑审计/成本摊销全清单对照；主会话补充裁决 3 项（D7 泄漏检查为 TransferGain 前置门禁、FP deferred 触发条件、§九补漏）；eval 262/python 89/gateway 195 独立复跑 |
| plans/2026-08-19-d-stage-addendum-v2-dev-tasks.md | **Addendum v2（GPT 评审）指标设计+任务书【用户 08-19 批准：Oracle 必须添加+完全遵循 GPT】**：T6 离线分析包 v2（Success@K/迁移矩阵+RecoveryConversion/回归+负迁移 δ=0.1/UsefulHit/Functional 分层/难度分层/TreatmentCompliance）/ T7 PlanAdherence+泄漏检查 0.6 阈值+Memory 生命周期 / T8 Oracle 四条件诊断 harness（D7 后一次性，oracle 臂天然隔离）/ T9 重跑审计 5×3 / T10 教师成本摊销台账；验收口径 5 条 |
| 2026-08-19-d-stage-addendum-v2-t7-t8-t9-changes-and-decisions.md | **Addendum v2 落地（T7+T8+T9）开发决策记录【实施完成，eval 全量 242 绿】**：T7 三离线分析器——plan_adherence（Adoption/Deviation，动作 token 启发式预注册）/ leakage_check（3-gram Jaccard>0.6 + future-task 提前入库）/ memory_lifecycle（Reuse/SuccessAfterReuse/Utility/Age/Duplicate）；T8 oracle_diagnostic（四条件 harness，子集 sha256("oracle-diag")，蒸馏模板写死，oracle 前缀隔离目录）；T9 rerun_audit（5×3，sha256("rerun-audit")）；真实数据冒烟发现 c-d4 快照 4/8 held-out 有 exact 卡（提请主会话裁决冻结库）；63 新测试全 mock |
| plans/2026-08-19-d-stage-addendum-dev-tasks.md | **D 阶段增强设计落地任务拆分【用户 08-19 批准】**：T1 四臂 task-block 随机臂序+termination_reason / T2 held-out 8 冻结+写入隔离 eligible_arms / T3 假独立三指标+trajectory 指标族 / T4 memory 可观测最小集（retrieved_scores+injected_tokens）/ T5 文档对齐（主会话）；held-out=8 与人工 judge audit 裁决登记；验收口径 5 条 |
| 2026-08-19-run-batch-preflight-checklist.md | **跑批环境与条件清单【生效中，工程约束】**：跑批/测试前必须逐项核验七类 27 项——A 模型层（omlx 可达/9B 已加载/指纹 env/真实探针）、B gateway（唯一进程/进程晚于配置/9B 配置/env 齐备/探针 trace 进 Langfuse 且 model 字段=目标模型）、C agent-server 双臂（指纹/Node25/经验库状态用户确认）、D judge（relay/env/真实探针）、E Langfuse（容器/.env 三行/数据流入）、F 跑批进程（venv/env 全套/-u 无缓冲/磁盘/干跑核对）、G 判据门（测试全绿/check/length<5% 门控）；每项附验证命令与事故来源；启动式参考；约束本体入 p3 通用约束 canonical 节 |
| 2026-08-19-langfuse-monitoring-changes-and-decisions.md | **Langfuse 跑批监视部署+接入决策记录【实施完成，测试全绿+端到端冒烟 PASS】**：官方 v4 compose 栈落 eval/langfuse/（项目 exp-9b-campaign，密钥 gitignore）；colima 代理失效修复（8898→7890 备份可回滚）；gateway observability.py provider 包装单点埋点（[langfuse] 缺省关闭，密钥 env 引用）；对账键=create_trace_id(seed=chatcmpl id) 与 model_runs/run.jsonl/session marker 1:1 join；campaign 任务级 span+qcb_score 上报（不用 langfuse.openai drop-in）；可观测性绝不炸批（建 span 失败回落不重跑/update 吞掉/env 缺省全链 no-op）；v4 读口径=v2/observations（旧 traces API 404）；macOS 系统代理不回 bypass 回环陷阱登记（NO_PROXY） |
| 2026-08-21-d1-zero-cloud-escalation-diagnostic-report.md | **D1 0% 云升级门控有效性诊断【完成】**：52 个任务/1,369 个唯一 trace 与 gateway `model_runs` 100% 对账，确认 escalation run=0 不是标注假绿；同时明显失败 23/23 未升级，MissedEscalationRate=100%，定性为请求级门控看不到任务级失败的构念有效性缺陷；升级率改称协议级升级率并须联合报告 AutonomousSuccessRate/MissedEscalationRate/明显失败数；D1-D7 不改线上门控，只做 Oracle/shadow 诊断，正式改造 deferred 到 D 收口后 |
| 2026-08-21-d1-zero-cloud-escalation-changes-and-decisions.md | **D1 零云升级诊断决策记录**：D-1~D-5 固化 gateway 真值判定、构念缺陷定性、D1-D7 门控冻结、联合指标解释口径、正式门控改造延后条件；同步 issue-019 与 Kimi/pi/Claude 跨 agent 交接纪律；本批只改文档未改运行代码 |
| 2026-08-21-kimi-subagent-mcp-relocation-changes-and-decisions.md | **Kimi MCP 独立项目迁移【完成】**：服务实现、测试、配置、启动脚本与原实施档案迁至同级 `../kimi-subagent-mcp`；改用独立 pyproject/.venv，Turbo-pi 不再承担其运行依赖；四工具只读边界维持 |
| 2026-08-14-m5-t6-t7-changes-and-decisions.md | **M5（T6+T7）开发决策记录【实施完成，测试全绿】**：T6=台账 quick wins 四项——GatewayMarker 增 trace_id 跨库对账键 + agent-server handleStream 路径补 gateway_marker 会话条目（台账 2）；ETL 摄入前完整性校验（流闭合标记，半截 session 整体隔离 + 快照 etlIsolated 计数，台账 7）；DLP 扩扫 tools[] schema + 身份证号默认模式（裁决 5，config 追加即生效，台账 3）；snapshot_store 每日快照模式（--snapshots-dir 保留 N=7）+ 回滚 runbook（台账 4）；T7=交叉臂 harness——campaign.py --arms x1-x4（库版本×注入 2×2，冻结臂走 --frozen-base-url）+ campaign_cross.py 差分核算（库演进 X2−X1/注入 X1−X4/sanity X3−X4，n=20 功效声明 + sanity 容差 0.05 预注册）；只交付能力+冒烟，真实跑批待 9B pilot 确认 |
| 2026-08-13-agent-server-high-level-design-v2.md | **概要设计 v2（当前最新总纲）**：设计目标（含判据口径与混淆因子声明）/总体架构四视角图/核心机制六节按模块构成·运行方式·有效作用展开（现役/待建状态标注制）/关键数据流/六份演进方案（C 后逐案请示）/EWC 采纳边界/设计红线/台账摘要（含 2026-08-13 对抗式审查新增 10 项） |
| 2026-08-13-high-level-design-v2-diagram-split-changes-and-decisions.md | **v2 架构图拆分决策记录**：单图拆为分层/时序/数据流/call graph 四视角；图中函数名与阈值均对照现役代码核实；双库分离入图；核心机制按模块构成·运行方式·有效作用三要素展开；图预渲染 2x PNG 嵌入正文（assets/2026-08-13-high-level-design-v2/，SVG 副本同目录），mermaid 源码折叠保留 |
| 2026-08-13-high-level-design-v2-adversarial-review-changes-and-decisions.md | **v2 对抗式审查决策记录**：三 pi 审查员（实现一致性/学习机制/工程风险）+ 主会话答辩，3 轮收敛，36 条 finding 全部关闭；引入现役/待建状态标注制；新增演进方案 6（库版本交叉评估臂）与台账项 1-10；五图重渲染；SOP/SKILL 是否同过 0.5 闸留用户裁决。过程档案见 reviews/2026-08-13-v2-adversarial/ |
| 2026-08-13-agent-server-system-design-and-issue-inventory.md | **系统全量设计参照（多 agent 调研合成）**：分层架构图（L0-L4 含 C campaign 件）+ 双时序图（在线含 x-gateway 标记/离线含夜间循环五步法）+ 三条函数级 call graph（在线/gateway/进化）+ issue 台账 001-011（open: 003/010/002余留，标注待解决）+ 故障模式元教训 4 条 + 生效决议摘要 |
| 2026-08-09-agent-server-27b-b-round-findings-and-gate-length-flaw.md | **B 阶段结果+门控 length 缺陷【重大修正】**：冷/热均 21/134（Δ=0 噪声带，注入无净效应）；**核心发现：两臂 84-87% 请求经 finish_reason_length 门控升级到 DeepSeek（max_tokens=200×27B 叙述风格误杀），从未测过纯 27B**——“升级率 0%/本地独立/云端归零”等结论撤回；补救方案 A/B/C 待用户拍板 |
| 2026-08-09-adversarial-review-experiment-validity.md | **实验有效性对抗性审查【3 路并行，代码行级验证】**：length 缺陷同类 bug 全链路排查，39 项发现（4 critical/21 major/14 minor）——C1 campaign runner 不可运行、C2 判据结构性永绿（escalated 硬编码）、C3 alfworld 134 硬编码致历史控制臂 17 局重放错位、C4 升级结果不过闸且 max_tokens 原样上云；方案 A 两处修正（agent-local 绕门控不成立、pilot 校准+升级率<5% 门槛）；P0/P1/P2 修复分批待拍板；issue-003 登记 |
| 2026-08-09-gate-length-issue-and-adversarial-review-changes-and-decisions.md | issue-003 登记 + 对抗审查决策记录：agent-local 绕门控否定（routing.py 忽略 model 名）、pilot 校准+升级率门槛、39 项不分拆 issue、不动 quality.py、历史数据不回溯 |
| 2026-08-09-p0-fixes-changes-and-decisions.md | **P0 修复批次实施【全部落地，测试全绿】**：gateway x-gateway 升级标记（M1）/云端结果观测（C4）/thinking 透传（M9）；campaign runner（C1）与判据 fail-loud（C2）；alfworld 池上界/去重/提取正则/init_prompt（C3/M14-M16/M18）；控制臂 8789/8790（M8）；preflight 指纹（M11）；快照（M10）；流式 include_usage（M2）；system 合并（M5）；issue-003 回归测试两件 + issue-002 补测转正；quality.py 未动；重跑方案 A/B/C 仍待用户拍板 |
| 2026-08-07-agent-server-experience-production-line.md | **经验生产线标准参照**：分层架构图（L0 模型/L1 路由/L2 经验/L3 进化/L4 运维）+ 双时序图（在线检索注入/离线 ETL-蒸馏-验证-晋升）+ 四条红线 + 实证状态表（27B 进化破零：41 Method+62 Guard） |
| 2026-08-05-agent-server-c-campaign-design.md | **C 阶段 campaign 设计【判据预注册】**：重复集 20 每日跑 + 新任务 79 七日切片（QwenClawBench 99 任务，seed=42 分层）；判据①重复任务升级率 D7≤5% ②新任务 <20%；D1/D7 同路径对照臂（injection off）；脚手架已交付（plan/metrics/runner + 9 pytest）；启动时机=B 热库出数后 |
| 2026-08-05-agent-server-web-monitor-changes-and-decisions.md | **Web 监控面板**：`/dashboard` 单页（链路状态/命中率/日志 tail，5s 自刷）+ `/api/status/chain`（self/gateway/omlx/evolution，任何 HTTP 响应即活）+ `/api/logs?lines=N`（logTrace 文件 sink，默认 var/log/agent-server.log）；`AGENT_SERVER_WEB=off` 关三端点（默认 on，数据 API 不 gate）；pkill 误杀 8789 事故入教训 |
| 2026-08-03-agent-server-e5-flywheel-changes-and-decisions.md | **E5 飞轮实验**：冷 7.5% → 热 8.2%（判据②方向成立、效应量噪声级）；强次级信号：升级率 -18.2pp（72.6%→54.4%）、云端 token -18%、检索命中 100%；进化 metric=238（合成 134 干净轨迹解决管线超时）；决策：不宣告强胜利，建议进化 2-3 轮看复利 |
| 2026-07-31-development-roadmap.md | **开发路线（当前最新）**：近期 E 收口（E5 飞轮决定性实验/S1 换型/usage 修复/P2/P3）→ 中期学生成色（置信路由/S4 蒸馏/卡片聚类去重+入库验证/S7 生产接回/技术债）→ 远期 spec 遗留 Go Gates（规则学习/反馈分类/scope/New API/双云/零外泄）；Go/No-Go 门决策图；不变量 4 条 |
| 2026-07-31-student-teacher-implementation-report.md | **学生-老师实现结果详细报告**：工程变更明细（gateway thinking/agent-server stop 透传/ALFWorld infra）、逐层验证记录（含时序图）、三腿结果与判据、根因研究、9 篇文献 grounding、5 项已知限制、后续路线优先级；commit 序列与测试基线 |
| 2026-07-31-agent-server-alfworld-three-leg-report.md | **ALFWorld 三腿 A/B 报告**：L1 DeepSeek 9/134（6.7%）/ L2 学生基线 8（6.0%）/ L3 学生+注入 10（7.5%）——判据①注入无害成立；腿间差在噪声内（诚实声明）；L3 期间评估库经验=0（注入为空块，有益性待 E5）；升级率 73-74%、云端 token 学生腿省 21% 但墙钟 5-6 倍；12,744 session 已归档为 E5 原料；usage 透传缺陷待修 |
| 2026-07-31-agent-model-selection-and-planner-executor-literature.md | **文献综述**（5 篇论文下载本地解析，`doc/research/papers/`）：instruct 增益是 prompt 模板依赖（zero-shot 差 30pp+）、Harness-Bench 分数=model×harness、COPE 置信路由 ALFWorld 省 29%、ReWOO/PEACE 静态规划在探索环境失效（论文点名）；**planner-executor 不能防数据外泄**（有效形态云端仍需见执行状态）——正解=本地执行+脱敏摘要+DLP；路线修正：门控扩展为置信路由、否决静态规划、评估须按 model×harness 配置报告 |
| 2026-07-31-agent-server-student-empty-output-analysis.md | **empty_output 根因分析报告**：L2 升级率 74%（99.5% empty_output）——7 个假设逐一排除（stop/长 prompt/换载/reasoning 丢弃/gateway bug/历史诱导/rapid-fire），决定性实验直连 omlx 证实 **gemma-4-12B 对 ReAct 范例+长历史 prompt 立即吐 EOS/空白**（content 缺失，completion_tokens≈2）；门控兜底零感知但 token 反超直连；建议学生换 Qwen3.5-27B-Distilled（S1）；含架构图与时序图 |

### 阶段 7：R 真实化（2026-07-23 立项，同日收口）

| 文件 | 内容 |
|---|---|
| 2026-07-23-agent-server-r-real-teacher-tasks.md | **R 任务书（当前最新）**：R1 真实 LLM teacher 全链路 E2E（含 rescore 超时治理）、R2 Mock vs 真实对照评估与切换建议、R3 C-重 Go/No-Go 评审 |
| 2026-07-23-agent-server-r1-real-teacher-e2e-changes-and-decisions.md | R1 决策记录：真实 teacher 全链路 2m31s 通过（4 张新 Method、quality 脱离 Mock 关键词档）；rescore 因 dormant=0 未触发，超时暂不治理（触发条件记录） |
| 2026-07-23-agent-server-r2-mock-vs-real-evaluation.md | R2 对照评估：role 偏倚为 Mock 门控产物（真实单轮 4 Method 0 Workflow）；截断与并存行两触发条件命中但均评审无需动作；切换真实 teacher 的 plist 指令（用户动作）+ 成本估算（增量派生观察项）；基线已刷新为真实 teacher 版 |
| 2026-07-23-agent-server-r3-c-heavy-review.md | R3 评审：**C-重 No-Go**（真实 teacher 下 C-轻成立，重启条件明确）；两触发评审正式结论（截断不可惜上限维持、并存行非重复不清理）；runbook §3 判读规则修订 |
| progress/2026-07-23-r-real-teacher.md | R 里程碑进度与交接：R1-R3 状态表、LLM 切换机制等共享环境事实、断点恢复指引 |

### 阶段 10：plans 子目录（计划与任务书，2026-07-31 起规范设立）

**规范**：本工程产生的所有计划（plan）与任务书必须存放于 `doc/design/plans/`，命名 `<date>-<topic>-plan.md`（路线图等长期文档同目录），并在本 INDEX 登记（与文件同 commit 更新）。

| 文件 | 内容 |
|---|---|
| plans/2026-07-29-eval-e23-closeout-plan.md | E2.3 全量收口计划：spec 符合性审计（4 处合规缺口）+ Phase A-C（归档/报价/预算检查点/全量执行/收口） |
| plans/2026-07-30-eval-benchmark-pivot-plan.md | E 改道计划 v3：benchmark 替换为 ALFWorld+QwenClawBench+Claw-Eval（三 benchmark 调研结论、臂切换、成本表） |
| plans/2026-07-30-student-teacher-reconnect-plan.md | 学生-老师链路接回计划：勘察结论（代码行级）+ 三腿实验设计 + S1-S7 执行步骤 + 验收标准 |
| plans/2026-07-31-agent-self-evolution-roadmap.md | **自进化路线图【用户设计意图 + 已批准】**：四约束（不微调只外挂记忆/harness 自进化/门控→云→学习/相似轨迹合并）；R0 评估收口 → R1 轨迹合并+入库验证 → R2 升级轨迹学习闭环 → R3 harness 自进化（人工审批门） → R4 全本地化决策点；北极星=升级率下降+SR 升+云成本降 |
| plans/2026-08-09-gate-length-issue-and-adversarial-review-plan.md | issue-003 登记 + 对抗性审查计划【已批准：仅文档交付】：issue 模板与回归测试规划、三路审查方法、39 项发现汇总、P0-P2 修复优先级、执行步骤 |
| plans/2026-08-11-experience-schema-evolution-plan.md | 经验库 schema 演化【待评审】：SIA 论文符号表对照 → Experience 增加溯源三字段（scaffoldHash/supersedesId/verification）+ SQLite 增量迁移 + markStaleByScaffoldHash；对齐自进化路线图 R1/R3，排期待实验完成后定 |
| plans/2026-08-11-self-improve-skill-plan.md | self-improve 回路【待评审】：支架自改两层设计（S1 仅 SKILL.md 策略层可即行 / S2 extension 机制层 reflect 工具+验证闸+evolution-log）；自反思快环+teacher 慢环分层；对齐 R3 人工审批门 |
| plans/2026-08-13-plan-card-deliverable-fix.md | 【待启动】issue-010 主体修复：卡片 schema 加 deliverables 字段 + 验证闸门交付检查（无交付 quality 封顶 <0.5）+ 存量卡重蒸馏 + 回归测试；1-1.5 天 |
| plans/2026-08-13-plan-outcome-attribution-reward.md | 【待启动】实战归因奖惩：retrievedIds×任务分数关联、最小样本阈值、对照臂校准、quality/confidence 二元组；1-2 天 |
| plans/2026-08-13-plan-scenario-tags.md | 【待启动】经验卡情景维度：domain/task_pattern 标签 + 蒸馏自动打标 + 检索按域过滤；0.5-1 天，backlog 中优先 |
| plans/2026-08-13-plan-b-rerun-pure-27b.md | 【待启动】issue-003 收口 B' 重跑：pilot 校准 max_tokens + A/B/C 三选（A 推荐：冷+热双臂 134 局 ~4 天）；验收升级率 <5% |
| plans/2026-08-13-plan-pipeline-checkpointing.md | 【待启动】issue-002 余留：离线管线分阶段断点持久化 + --resume；附降级/关闭备选与决策数据（C 阶段 5 次进化 0 故障） |
| plans/2026-08-14-post-c-unified-fix-batch-plan.md | **C 后统一修改方案 v3【对抗审查 3 轮共识 + 用户五项裁决落盘，待实施批准】**：实态核实表（含 requestId 碰撞实证）+ F0（归因数据通道/issue-013）→最小断点→F1（卡片交付物）→F2（归因奖惩+保守降权）→F3（情景标签含 ETL 打标）→F4（晋升机制统一）+ 台账 quick wins；用户裁决：27B 重跑取消转 9B 全量重跑、实验顺序 office 先行→报告→用户确认→ALFWorld、DLP 默认敏感列表；审查档案 reviews/2026-08-14-fix-batch-adversarial/ |
| plans/2026-08-14-plan-library-version-cross-eval.md | 【已立项 08-14】演进方案 6 库版本交叉评估臂：冻结库/当日库 × 注入开/关 2×2 四臂，差分预注册分离库演进效应与即时注入效应（回应审查乙-F2）；与 9B 重跑批合并排期，受 office 先行顺序约束 |
| plans/2026-08-14-fix-batch-dev-tasks.md | **开发任务拆分与里程碑计划【用户 08-14 批准方向】**：T0-T7 八任务（单任务 ≤700 行，满足 ≤3000 行硬约束）、TDD 双人组协议（pi-dev 红先绿后 / pi-test 独立复核 / 主会话里程碑门禁）、token 估算 ~2.8-4.4M、M1-M5 里程碑与门禁五条、环境约束（Node25/test.sh/不 commit） |

进度跟踪目录 `doc/design/progress/`：每个里程碑一个进度文件，多 agent 交接 + 断点恢复用；规范见 `progress/README.md`。

### 阶段 11：D 阶段规划能力研究综述（2026-08-25）

| 文件 | 内容 |
|---|---|
| 2026-08-25-small-model-planning-review.html | **今日对话综述（HTML）**：七项疑问逐项引用与解释；结合 D1—D6 阶段数据，区分经验库收益与长程规划能力；评估现有协议级升级门；综述规划—执行分离、子目标蒸馏、过程监督、验证器、符号规划与隐私保护云规划；提出 D7→2×2→本地 27B/9B→shadow gate→脱敏云规划路线 |
| 2026-08-25-small-model-planning-review-changes-and-decisions.md | 综述交付决策：14 个一手来源、短引与解释分离、10 份原页面/PDF + 4 份明确标注检索快照、证据边界和后续实施前置条件 |
| ../research/2026-08-25-small-model-planning-review-sources/README.md | 引用资料清单：14 个在线地址、本地文件、下载类型与预印本/横向比较限制 |

### 阶段 12：D 阶段收口与终审（2026-08-26~27）

| 文件 | 内容 |
|---|---|
| 2026-08-27-9b-campaign-d-phase-final-report.md | **D 阶段七层最终报告（R3 conditional pass / 需 major revision）**：判据①② PASS、③④ FAIL；可确认当前记忆注入路径无正增益且存在少数任务灾难性脱轨，不能把总体差异唯一归因于记忆内容；T9 5×3 已补，但同任务三次共用 workspace，0.0067 仅代表该实现下 5 题表面稳定，不能外推为全局噪声 floor；arms 等价、取证链、功效与 ALFWorld 前置仍待闭环 |
| plans/2026-08-27-post-d-phase-next-steps-plan.md | **历史方案【已废止】**：原 A/B/C 路线与“先三教师再 v2”的串行建议，已被阶段 13 的对抗审查版实验计划取代 |

### 阶段 13：D 后实验重设计（2026-08-27）

| 文件 | 内容 |
|---|---|
| plans/2026-08-27-post-d-adversarial-experiment-redesign-plan.md | **现行实验入口 V1【设计通过、待实施批准】**：P0 基础设施→E0 机械臂等价/T9-R2→E1 裸基线+内容×剂量→按结果分支 E2/E3→E5a 冻结 detector→E4+E5b 前瞻 shadow→共同主效用/安全裁决；20 个未执行任务用 manifest+denylist 严格封存；本文件不授权跑批 |
| 2026-08-27-post-d-experiment-redesign-adversarial-review.md | **5 轮 Kimi×Codex 对抗审查记录**：核验 workspace/注入路径、任务池/统计、卡片 schema/evolution、gate/judge、全方案反例；接受工程阻断并纠正 Kimi 关于“无未见任务”、judge/cost、E2/E5 时序的错误判断 |
| 2026-08-27-post-d-experiment-redesign-changes-and-decisions.md | **重设计决策记录 D-01~D-12**：测量先行、内容×剂量可识别设计、E2/E3 条件触发、sidecar/派生库、确认集技术隔离、E4 双共同主指标、E5 前瞻时序及本轮授权边界 |

### 阶段 14：自我进化工程蓝图（2026-08-27）

| 文件 | 内容 |
|---|---|
| plans/2026-08-27-self-evolving-engineering-design-plan.md | **自我进化工程设计 V3【五轮对抗审核定稿，待 Phase 0b 参数预注册；不授权实施/跑批】**：在 V2 的 OpenRSI/DGM/autoresearch 方案上补齐独立 TEK 进程边界、search/selection/confirmation 隔离、artifact-attestation-deployment-runtime 四层模型、签名/WORM 审计、严格 shadow、scoped 模型门与 capability-limited 源码 ABI |
| 2026-08-28-self-evolving-engineering-design-adversarial-review.md | **Kimi × Codex 五轮上限对抗审核记录**：独立红队→统计/状态反驳→信任主体与数据模型→安全白名单与证据边界→V3 终审；记录收敛项、证据适用边界和 Phase 0 参数 |
| 2026-08-27-self-evolving-engineering-design-changes-and-decisions.md | **自举设计决策 SE-01~SE-28**：在 V2 基础上新增 TEK 独立进程边界、四层状态、签名分权、adaptive holdout 隔离、严格 shadow、稀有事件保守门、受限 ABI、数据保留、签名依赖例外与 Phase 0a/0b |
| 2026-08-27-p0-infrastructure-changes-and-decisions.md | **P0 基础设施实施决策 P0-01~P0-06**：judge 适配器、独立工作区断言、确认集 denylist、canonical request hash、arm/condition trace 标记、测试门控风险域分离 |
| 2026-08-28-m2-t6b-2-version-contract-wiring-changes-and-decisions.md | M2-T6b-2：将 version contract 接入 `AgentSession`，注入 system-prompt/extension 上下文，并在 `reload()` 记录 resolved manifest |
| 2026-08-28-m2-t6b-3-resolved-manifest-persistence-changes-and-decisions.md | M2-T6b-3：在 `AgentSession.reload()` 中将 resolved manifest 持久化到会话目录，字段校验 fail-closed，注入失败不影响会话继续 |
| 2026-08-28-phase3-completion-changes-and-decisions.md | **Phase 3 scaffold 配置进化实施完成**：T29–T34 全链落地、9 项设计决策、测试基线 247+61 全绿、遗留 Phase 0b 参数与下一 Go/No-Go 点 |
| plans/2026-08-28-phase3-orchestration-plan.md | Phase 3 任务分解与里程碑计划（T29–T34），已更新为全部完成 |
| plans/2026-08-28-phase4-detector-teacher-plan.md | Phase 4 任务级 detector 与 teacher 回流实施计划（已完成） |
| 2026-08-28-phase4-completion-changes-and-decisions.md | **Phase 4 实施完成**：P4-1~P4-4 全链落地、detector 只读 shadow、DLP/脱敏 teacher 回流、shadow 评估指标、测试基线 |
| 2026-08-28-p4-2-frozen-shadow-task-level-detector-changes-and-decisions.md | **P4-2 frozen shadow 任务级 detector v1 实施决策**：只读 shadow、v1 规则集合、版本门控、证据 artifact 嵌入、浏览器安全哈希与回归测试 |
| 2026-08-28-p4-4-integration-and-shadow-metrics-changes-and-decisions.md | **P4-4 集成测试与 shadow 评估指标**：composite artifact 扩展支持 detector snapshot、detector 召回/误报/漏报/升级成本/DLP 阻塞指标、端到端 faux 数据测试 |
| plans/2026-08-28-phase5-source-bootstrap-plan.md | Phase 5 受限源码级自举实施计划（已批准，P5-1 完成，P5-2 待启动） |
| progress/2026-08-28-phase5-source-bootstrap.md | Phase 5 受限源码级自举 — 进度与交接（进行中） |
| 2026-08-28-p5-1-candidate-abi-changes-and-decisions.md | **P5-1 candidate-extension ABI 与 capability-limited 白名单**：ABI v1、manifest fail-closed 校验、默认路径白名单、`source_patch` artifact 布局 |
| 2026-08-28-p5-2-source-candidate-generator-changes-and-decisions.md | **P5-2 源码候选 generator**：失败簇聚合、信号→声明式策略映射、模型-free patch 生成、lineage 记录 |

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
- 【废】E2 Terminal-Bench / E3 SWE-bench（2026-07-30 用户拍板）：benchmark 替换为 ALFWorld（E2'）+ QwenClawBench（E3'）+ Claw-Eval 文本子集（E4'）；TB 全量中止（控制臂 8 trial/2 resolved 归档）；wheelhouse/中继/正向代理基础设施保留复用 → 取代记录 `2026-07-30-agent-server-eval-benchmark-pivot-changes-and-decisions.md`
- 【立】评估 judge 口径：agent=deepseek-v4-flash、judge=deepseek-v4-pro（hybrid 评分对 judge 质量敏感，judge 成本 <$5）

### B 阶段门控 length 缺陷 + 对抗审查（08-09）

- 【废】A 阶段 bisect“27B 升级率 0/147=0%”结论：全量口径 84-87%，小样本不具代表性作废（issue-003）
- 【改】重跑方案 A 补充观察“冷库臂 agent-local 绕门控”被代码核查否定：routing.py V1 忽略 model 名 → 双臂统一 agent-auto + max_tokens pilot 校准（5 局定 800/1024）+ 验收门槛 model_runs length 升级率 <5%
- 【留】对抗性审查 39 项发现（4 critical/21 major/14 minor）→ P0/P1/P2 修复分批待用户拍板；历史数据影响：alfworld-20260730 控制臂 17/134 局重放错位（C3），引用需注明口径
- 【立】方法论纪律：度量必须与现象同源（C2 教训）；烟囱测试通过 ≠ 真实运行可信；A/B 审计清单=臂间差异恰好等于处理变量

### D1 零云升级门控有效性诊断（08-21）

- 【验】D1 0% 云升级为真实路由结果：1,369/1,369 trace 均为 omlx primary succeeded，escalation run=0，排除客户端标注假绿
- 【观】请求级门控召回盲区：明显失败 23/23 未升级，MissedEscalationRate=100%；合法 tool call 不等于任务取得进展
- 【改】“升级率”解释口径收窄为“协议级升级率”，必须与 AutonomousSuccessRate、MissedEscalationRate、明显失败数联合报告
- 【留】任务级线上门控改造 deferred：D1-D7 保持路由口径不变，只允许 Oracle/Teacher Direct Solve/shadow-only 诊断；正式实现待 D 收口后用户另批

### D 收口与后续实验重设计（08-27）

- 【改】D 最终报告从“R3 可交付”降为 **conditional pass / major revision**：T9 已补但三次重复共用 workspace，不能把 0.0067 当全局噪声 floor，也不能把两臂差异唯一归因于记忆内容
- 【废】原 post-D A/B/C 串行路线及“先三教师再 v2”默认顺序，由五轮 Kimi×Codex 对抗审查后的条件分支流程取代
- 【立】现行流程：P0 基础设施→E0 机械臂等价→E1 内容×剂量→按结果决定是否 E2/E3→E5a 冻结 detector→E4+E5b 前瞻 shadow→共同主效用/安全裁决
- 【立】20 个实际从未执行任务为严格确认集，使用 manifest + runner denylist 封存；跨日重复不增加独立任务样本量
- 【留】v1 记忆冻结且 ALFWorld 阻断；方案设计通过，但代码实施和真实跑批待用户逐阶段批准

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
| 注入对照 | 控制臂=8789+`injection:false` 同路径（不旁路），基线轨迹进学习回路；DeepSeek 直连臂（8899）例外 | 08-05 |
| 跑批门禁 | 跑批入口必过 eval/preflight.py（探活+自动拉起 8789/8787/8899） | 08-05 |
| 门控解释 | 升级率仅代表协议级门控触发率；必须联合报告 AutonomousSuccessRate、MissedEscalationRate 与明显失败数；D1-D7 不改线上任务级门控 | 08-21 D1 零云升级诊断 |
| D 后实验入口 | P0→E0→E1→结果分支 E2/E3→E5a→E4+E5b；共同主效用与主安全同时过门，才可进入 ALFWorld | 08-27 post-D 重设计 |
| 当前授权边界 | v1 记忆冻结、ALFWorld 阻断；现只完成设计与 5 轮审查，下一步须用户单独批准 P0+E0 实施 | 08-27 post-D 重设计 |
