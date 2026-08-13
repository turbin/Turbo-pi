# 对抗式审查报告 · 丙（工程风险 / 边界 / 运维）

- 审查对象：`doc/design/2026-08-13-agent-server-high-level-design-v2.md`（经验学习系统概要设计 v2）
- 背景参照：`doc/design/2026-08-13-agent-server-system-design-and-issue-inventory.md`
- 源码核实：`packages/agent-server/src/{proxy-handler,retrieval,injection,sop-schema,session-writer,experience-store,gateway-client,toolcall-validator,server}.ts`、`packages/agent-server/src/offline/{scheduler,pipeline,verifier,checkpoint}.ts`、`packages/agent-server/eval/{snapshot_store,preflight}.py`、`packages/agent-gateway/src/agent_gateway/{api/chat,quality,envelope,config}.py`、`security/dlp.py`、`store/{budget_ledger,trace_store}.py`
- 审查视角：可靠性、安全、运维。只提实质问题。

---

## 结论摘要

v2 设计在"记录不可关、快照冻结、checkpoint 幂等、升级前置"上已比 v1 收敛，但工程可靠性上存在三处**系统性单点/断链**：全链路唯一入口 gateway 无降级、双库"双印证"没有跨库关联键、"可回滚"在代码层并未实现。安全上 DLP 的默认覆盖远窄于"经验卡携带真实办公域数据出网"的风险面。以下是 10 条 finding。

---

## Findings

### F-01 · major · gateway 是全链路单点，无直连学生的降级路径

**文档位置**：v2 §2.2、§2.4（在线链路）、§5.7（运维）；inventory §2 层职责"学生可独立断云运行"。

**攻击论点**：L0 不变量声称"学生可独立断云运行"，但断云 ≠ 断 gateway。agent-server 唯一出网路径是 `GatewayClient.stream()` → `POST :8787/v1/chat/completions`；omlx :8000 只出现在 `/api/status/chain` 的探活里，没有任何直连学生的请求分支。gateway :8787 一旦崩溃（进程退出、SQLite 锁死、端口占用），本地学生 27B 与远端老师同时不可达——即"断网关"等价于"全链路瘫痪"。文档对 gateway 不可用时的降级路径只字未提。

**支撑证据**：
- `gateway-client.ts:post()` 只 `fetch` 到 `${baseUrl}/v1/chat/completions`，`!resp.ok` 直接 `throw`，无任何 secondary endpoint 或直连 omlx 逻辑。
- `proxy-handler.ts:handleStream()` 中 `await gateway.stream(gatewayReq)` 抛错即走 catch → `writer.close()` → rethrow，请求以错误告终。
- `server.ts:115-121` 对 omlx 的引用仅在 `probeService`（状态面板探活），非请求路径。
- `preflight.py` 只在**跑批前**探活并 `nohup` 拉起 gateway，运行中 gateway 崩溃无运行时自愈（无非 supervisor 循环、无 agent-server 侧重试/降级）。

**设计方可能的反驳**：eval/campaign 场景里 preflight 已把 gateway 当作常驻依赖并在批前自动拉起，批内崩溃属罕见；且"学生可独立断云"的语义是"不依赖云端老师"，不是"不依赖本地路由层"。

**审查者回应**：反驳成立一半——"断云可运行"确实指不依赖 DeepSeek；但这恰恰把 gateway 变成了比"云"更脆的单点：它既是本地路由又是唯一的云升级闸门，一处崩溃同时切断本地与云端两条路。若 v2 面向在线服务（§2.2 时序图即"在线请求全链路"），这必须显式回答：gateway 不可用时 agent-server 是直连 omlx 降级、还是允许 502 风暴。当前文档没有这个答案。

---

### F-02 · major · "双印证"缺跨库关联键，request_traces 与 model_runs 无法按键对账

**文档位置**：v2 §3.1（"x-gateway 标记与 model_runs 落库双印证"）、§6 红线 6（"以 model_runs 与 request_traces 全量为准"）、inventory §5.1（"互为印证，拒绝只信其一"）。

**攻击论点**：两库各写各的 ID，没有任何共享关联键。agent-server `request_traces.request_id` 是 pi 的 `request.id`（`server.ts:160`）；gateway 侧 `model_runs.trace_id` 是 gateway 自生成的 `chatcmpl-<uuid>`（`chat.py: trace_id = f"chatcmpl-{uuid.uuid4().hex}"`）。agent-server 转发时不携带 requestId（`toGatewayRequest()` 不传，`gateway-client.ts` 无此字段），gateway 下发的 x-gateway 标记（`GatewayMarker`）只含 `escalated/reason/provider/cloud_finish_reason`，**不含 trace_id**。因此：给定一条 agent-server 的 request_trace，无法定位它在 gateway 里对应哪条 trace / 哪两行 model_run（seq=1/2）；"拒绝只信其一"的对账实际上做不到，只能靠同一主机上的时间戳近似 join。

**支撑证据**：
- `proxy-handler.ts` 阶段一 `store.recordRequestTrace({ requestId: opts.requestId, ... })`；`opts.requestId = String(request.id)`（`server.ts:160`）。
- `chat.py` 独立生成 `trace_id`，`build_openai_response` 里 `id = trace_id`，但该 id 不回传 agent-server 的 trace；`GatewayMarker.as_dict()` 无 trace_id 字段。
- 两库时间戳来源不同：agent-server 用 `new Date().toISOString()`（`experience-store.ts:recordRequestTrace`），gateway 用 `datetime.now(UTC)`（`trace_store.py`）——跨进程无统一时钟，时间戳也非可靠关联键。

**设计方可能的反驳**：升级率 ground truth 取 model_runs 全量、命中率取 request_traces 全量，二者各自独立口径即可，未必需要逐请求 join；单机部署时钟漂移可忽略。

**审查者回应**：若两条口径**永不交叉**，那"互为印证、拒绝只信其一"就是口号——当 model_runs 显示 5% 升级率而 request_traces 侧 hit=0（或反之）时，没有任何键能定位是哪批请求对不上，只能靠日志 grep。issue-004 的教训正是"标记断裂造成假绿"，而这里连"断裂"都无法精确检测。至少应在 x-gateway 标记或请求头中回传 trace_id，或在 agent-server 侧透传 requestId 给 gateway 作为外键。

---

### F-03 · major · SSE tee 落盘在响应关键路径上，磁盘故障会中断/破坏在线响应

**文档位置**：v2 §2.2（"SSE tee 落盘 session JSONL + gateway_marker 条目"）、§2.4（`SessionWriter 全量落盘`）、inventory §5.4（"记录不可关"）。

**攻击论点**：落盘失败会传播为客户端可见的流错误。`SessionWriter.writeLine()` 在流已置错误态（磁盘满、EACCES、quota）时 `throw`；该 throw 发生在 `validateToolCallStream` 的 `emit`→`options.onEvent`（= `recordStreamEvent`→`writeCustomEntry`）路径上，随 `transform` 异常传出，进入 `start()` 的 catch 后**再次调用 emit**（再次写盘、再次 throw），最终使 `validated` ReadableStream error；`teeWithSessionClose` 的 `pull` 捕获后 `controller.error(err)`，客户端收到流中断。非流式路径同样：`server.ts` 在 `reply.send()` 之前 `await store.recordRequestTrace()`（阶段二），写库失败即抛错走 catch → 502。即"全量落盘"被当作正确性前置，而非 best-effort 旁路。

**支撑证据**：
- `session-writer.ts:writeLine()`：`if (this.streamError) throw this.streamError;`。
- `proxy-handler.ts:recordStreamEvent()` 由 `validateToolCallStream` 的 `onEvent` 在每个事件上调用；`teeWithSessionClose.pull()` catch 后 `controller.error(err)`。
- `toolcall-validator.ts` `emit` = `options.onEvent?.(event); controller.enqueue(...)`；`start()` 的 catch 里再次 `emit({type:"error"...})`（此时 writeLine 二次 throw，未被捕获，直接 error 掉整个流）。
- `server.ts:389-400` 非流式阶段二 `await store.recordRequestTrace(...)` 在 `reply.send` 之前。

**设计方可能的反驳**：eval 场景宁失败不漏录，与"记录不可关、注入可关"的设计红线一致；漏一条 session 会污染次日进化，不如让请求失败可重试。

**审查者回应**：对离线跑批这确实是合理取舍；但文档把它表述为在线服务路径（§2.2"在线请求全链路"）。在线语义下，一个 session 目录被写满不应使**所有在线请求**集体 502。至少应显式声明该耦合是刻意选择，或给出降级策略（如落盘失败仅告警+标记 `record_incomplete`，响应继续）。当前文档未展开，属未披露的可用性风险。

---

### F-04 · major · "可回滚"未实现：checkpoint 只存计数，快照每日覆盖、无留存、无 restore 流程

**文档位置**：v2 §2.1 L4（"可回滚"）、§3.3（checkpoint 幂等落账）、inventory §5.7（"每日快照冻结"）。

**攻击论点**：L4 声称"可回滚"，但代码里不存在任何回滚路径。`writeCheckpoint` 的 `snapshot` 字段是一个 JSON blob 记录 `{etlInserted, pipeline, promoted, rescored, ...}` 的**计数**（`scheduler.ts:return writeCheckpoint({snapshot: JSON.stringify({...})})`），不包含被晋升/降级/清理的卡片**内容**；`checkpoints` 表无法用于恢复 active 集。真正能回滚的载体是 `snapshot_store.py` 产出的全量快照，但它 `src.backup(dst)` **覆盖写同一个 snapshot.db**，没有按日期留存；"回滚到昨日快照"需要运维人员手工在覆盖前另存一份，文档与 runbook 均未写这一步骤，也没有任何 `restore` 命令/脚本。

**支撑证据**：
- `checkpoint.ts:writeCheckpoint`：`snapshot` 为调用方传入的 JSON 字符串（仅统计信息）；`insertCheckpoint` 只 `INSERT OR IGNORE` 进 `checkpoints` 表。
- `experience-store.ts` 无任何"按 checkpoint 恢复 active 集"的方法；`getLatestCheckpoint` 只读不写回。
- `snapshot_store.py:snapshot()`：`src.backup(dst)` + `dst.commit()`，同一 `snapshot.db` 路径次日被覆盖。

**设计方可能的反驳**：checkpoint 的定位是"批次失败可安全重跑"的幂等锚点，不是备份；"回滚"指的是靠每日快照文件 + 重启 8789 换载，属运维纪律而非代码机制。

**审查者回应**：这正是问题——文档把两种东西混在一个词下。checkpoint 提供的是**重跑幂等**（防同批重跑污染），不是**回滚**（恢复到历史 active 集）。若某日进化产出一批有害卡（issue-010 已证明"照卡执行挤占交付本能"），想要退回昨日 active 集，唯一手段是那份已被覆盖的 snapshot.db。建议：快照按日期命名留存 N 天，或 checkpoint.snapshot 至少记录本批晋升/降级/清理的 content_hash 清单，使回滚可重放为逆操作。

---

### F-05 · major · 升级前置失败（DLP 403 / 预算 429 / egress 422）时丢弃已算好的本地结果，请求整体报错，无降级；且默认预算无上限

**文档位置**：v2 §3.1（"命中即升级"、"依次失败分别返回 422/403/429"）、§2.2 时序图 alt 分支。

**攻击论点**：`execute_with_escalation` 中，本地学生结果已经算完、只差一步升级，此时 `begin_escalation` 任一前置失败即 `raise GatewayError`，异常一路抛到 `chat_completions` 非流式分支 `re-raise`，客户端收到 403/429/422 错误，**本地结果被直接丢弃**，不存在"退回本地（低质量）结果"的降级分支。对长批跑：一旦月度预算耗尽或 DLP 命中率高，后续所有"本地不合格"的请求不再是"升级到云"，而是**整体失败**——eval 任务报错而非拿到一个可观察的本地结果。此外 `config.py` 中 `monthly_budget_micro_usd: int | None = None`（默认无上限），`cloud_egress_allowed=False` 默认关——"成本可控/安全"完全依赖逐 channel 显式配置，未配置时预算闸形同虚设（`reserve` 在 `cap_micro_usd=None` 时永不抛 `BudgetExceeded`）。

**支撑证据**：
- `chat.py:begin_escalation`：egress 不允许 → `raise GatewayError("local_quality_rejected")`；DLP 命中 → `raise GatewayError("cloud_egress_forbidden")`；`BudgetExceeded` → `raise GatewayError("budget_exceeded")`。
- `chat.py:execute_with_escalation` 对 `escalate_to_cloud` 的异常不捕获，直接上抛；`chat_completions` 非流式 `except GatewayError as exc: raise`。
- `config.py:58` `reserve_micro_usd = 100_000`（固定预留 $0.10）；`budget_ledger.reconcile` 被 `finish_escalation` 以 `reservation.reserved_micro_usd` 全额计费（`chat.py` 注释 "actual cloud cost is not known"），预算计量为近似上限而非真实花费。
- `config.py:83` `monthly_budget_micro_usd: int | None = None`；`config.py:81` `cloud_egress_allowed: bool = False`。

**设计方可能的反驳**：fail-closed 是安全/成本优先的刻意设计（DLP 命中绝不允许回退到本地把敏感数据之外的半成品发给用户；预算超限绝不允许继续烧钱）；云端不可用时客户端拿到错误比拿到错误答案更可审计。

**审查者回应**：对 DLP 命中（403）可以接受 fail-closed；但 egress 未启用（422）与预算超限（429）属于**配置/配额**问题，不是安全违规，此时丢弃本地结果、令大批 eval 任务报错是可用性损失。至少应区分"安全阻断（403，不降级）"与"配额耗尽（429，可降级回本地+标记 degraded）"两类语义。文档未区分，且默认预算 None 意味着"成本可控"这条红线在未显式配置时并不成立。

---

### F-06 · major · DLP 覆盖窄且漏扫 tools[]；蒸馏经验卡携带真实办公域内容出网，仅 3 条默认 regex 兜不住

**文档位置**：v2 §3.1（"升级行为安全（egress+DLP）"）、§2.4（`scan_envelope() DLP`）、inventory §5.1 升级前置。

**攻击论点**：注入后的完整 envelope 中，EVIDENCE/Method/Guard 块作为合成 user 消息、SKILL 目录并入 system 消息，**这些确实落在 `messages[]` 内、会被 `scan_envelope` 扫到**（这点文档是对的）。但有两个实打实的覆盖缺口：(1) `scan_envelope` 只遍历 `messages[].content` 与 assistant `tool_calls[].arguments`，**不扫 `envelope.tools[]`**（函数 name/description/parameters）也不扫 `tool_choice`；SOP 卡经 `sop-schema.ts` 把 `description`/`parameters` 塞进 tools，随升级一起发云端，而 SOP 的 schema 源自离线轨迹抽取，可能含内部路径/域名/字段样例，这一整类字节 DLP 完全看不见。(2) 默认 `DEFAULT_DLP_PATTERNS` 只有 3 条（AWS AKIA、PEM 私钥、`api_key=…` 赋值式），对办公自动化域的真实敏感物（客户名、工单内容、内部文档片段、非 AWS 形态的 token、连接串）没有任何默认覆盖；`config.dlp_patterns` 默认为空、需人工扩展。红线"原始轨迹从不注入"挡不住的是：蒸馏后的 EVIDENCE 卡本身就是从真实轨迹压缩来的**事实/工作流片段**，升级时整包发 DeepSeek，3 条 regex 无法兜住其信息泄露面。

**支撑证据**：
- `dlp.py:scan_envelope`：`for index, message in enumerate(envelope.messages)`，只 `_scan_text(message.content)` 与 assistant `tool_calls[].arguments`；无 `envelope.tools`、无 `envelope.tool_choice` 分支。
- `dlp.py:DEFAULT_DLP_PATTERNS` 仅 3 个键。
- `sop-schema.ts:buildSopSchemas` 把 `schema.description`/`schema.parameters` 映射进 `function`；`injection.ts` 将 SOP tools 合并进 `tools`；`openai-compat.ts` 将 tools 原样放入请求体。
- `envelope.py:ChatCompletionEnvelopeV1.tools` 为独立字段，DLP 未引用。
- `config.py:89` `dlp_patterns: dict = Field(default_factory=dict)`（无默认扩展集）。

**设计方可能的反驳**：注入卡在 messages 内已被扫（EVIDENCE/SKILL 均如此）；SOP 的 tools description 是结构化 schema 而非轨迹原文；`dlp_patterns` 支持逐 channel 配置，属部署方责任。

**审查者回应**：反驳只覆盖了 EVIDENCE/SKILL，未覆盖 tools[]——而 tools[] 恰恰是"发云端但 DLP 结构性不可见"的唯一盲区，属于设计缺口而非配置缺口。默认 3 条 pattern 面向"通用密钥泄露"，与"办公自动化经验库"的实际敏感面不匹配。建议：DLP 扫 tools[] 的 description/parameters/default/enum，并把 SOP schema 也纳入；至少在文档中写明"经验卡内容可能包含办公域敏感信息，默认 DLP 不覆盖此类，需部署方扩展"，否则 §3.1 的"升级行为安全"结论过强。

---

### F-07 · minor · 淘汰策略价值盲（纯年龄）+ active 集无上限 + removed/FTS 永不物理清理

**文档位置**：v2 §3.3（TTL 30 天 / 容量 10000）、§3.6（"最小样本阈值防误杀"）、inventory §5.2 生命周期。

**攻击论点**：三点叠加构成长期技术债：(1) `removeDormantBefore` 的 TTL 用 `created_at < cutoff`、cap 用 `ORDER BY created_at ASC` 淘汰**最老**的 dormant，完全不看 quality/价值/是否曾被实战加分——一张"从 active 被 rescore 降回 dormant、曾经实战证明有效"的卡，可能被纯年龄淘汰，而一条从未被评分的 ETL 候选留着。(2) "容量上限 10000"只约束 **dormant**，`active` 集没有 cap，只能靠 rescore→dormant→TTL 的间接路径收缩；若晋升速率高于降级速率，active 无界增长。(3) `removeDormantBefore` 只 `UPDATE status='removed'`，从不 `DELETE`；`insert` 时 FTS 行写入后永不清除（注释明言 "FTS needs no handling: rows stay indexed"），removed 行与 FTS 索引随天数累积，bm25 检索在全量索引上退化。

**支撑证据**：
- `experience-store.ts:removeDormantBefore`：TTL `WHERE status='dormant' AND created_at < ?`；cap `WHERE status='dormant' ORDER BY created_at ASC LIMIT ?`；均为 `UPDATE ... SET status='removed'`，无 DELETE、无 FTS 维护。
- `experience-store.ts:initSchema` 注释 "rows stay indexed but `search` filters status='active'"。
- `scheduler.ts`：`DEFAULT_DORMANT_CAP = 10_000`、`DEFAULT_DORMANT_TTL_DAYS = 30`；无 active cap 常量。
- `verifier.ts:PROMOTION_THRESHOLD=0.5` 晋升路径无 active 数量上限。

**设计方可能的反驳**：dormant 语义就是"留观、价值未知"，年龄淘汰是最简单可预期的策略；active 由 rescore 降级约束；当前规模（数千级）下 FTS 退化不显著。

**审查者回应**：承认当前规模无碍，但这与 §3.6 声称的"实战归因奖惩、最小样本阈值防误杀"存在张力——奖惩在质量轴上做精细加权，淘汰却在时间轴上做无差别删除，二者互不通气。若 v2 的"质量单调向好"要成立，淘汰至少应叠加 quality/`times_selected` 信号（被高频命中的卡不该因年龄被删）。removed/FTS 累积则建议在离线批次末尾加一次 `DELETE FROM ... WHERE status='removed'` + `INSERT INTO experiences_fts(experiences_fts) VALUES('delete', ...)` 或 rebuild-fts 流程。

---

### F-08 · minor · 快照换载 = 进程重启，存在每日停机窗口；"换载瞬间读半个快照"的原子性依赖运维顺序且未文档化

**文档位置**：v2 §2.3（"checkpoint 后换载新快照"、"在线只读快照"）、inventory §3.2（"⑤重启 8789 换载快照"）、§5.2 快照纪律（M10）。

**攻击论点**：对"换载期间读到半个快照"这一疑问的直接答案是：**低风险**——`snapshot_store.py` 用 SQLite online backup API（WAL 安全）整库复制，且换载方式是重启 8789 指向新快照文件，不存在热切换时读到半写入文件的问题。但由此引出的真实问题有两个：(1) 换载靠**进程重启**，每天一次停机窗口（:8789 短暂不可服务）；对夜间离线跑批无所谓，对 v2 自称的"在线请求全链路"则是每日可用性缺口。(2) 快照生成→重启之间的顺序、以及"重启失败时回退旧快照"的动作，完全依赖 runbook 手工执行，文档未写；且快照文件覆盖式写入（同 F-04），一旦新快照生成失败或内容异常，没有原子替换/校验回退机制。

**支撑证据**：
- `snapshot_store.py`：`src.backup(dst)`（online backup，原子）——正面支持"半快照"低风险。
- inventory §3.2 离线时序 `R->>S: ⑤重启 8789 换载快照`；v2 §2.3 仅一句"checkpoint 后换载新快照"，未展开换载的具体原子性保证与回退。
- `experience-store.ts` 构造器 `readonly: true` 打开 snapshotPath——读侧冻结，但换载仍是外部进程动作。

**设计方可能的反驳**：跑批夜间进行、无并发在线流量，重启窗口可忽略；online backup 已保证快照完整性。

**审查者回应**：接受"半快照"结论，但建议在文档补一句换载语义（重启式换载、非热切换），并明确"新快照生成失败/校验失败时沿用旧快照"的运维动作，避免 v2 读者误以为存在零停机热换载。

---

### F-09 · minor · 每请求路径的时延/吞吐无预算；同步 better-sqlite3 三次查询 + JSON.parse 压在事件循环上

**文档位置**：v2 §3.4（检索与注入）、§2.4 调用图。

**攻击论点**：每个请求在 agent-server 侧要串行执行：1 次 FTS `search`（bm25 top-24）+ 1 次 `listActive("SKILL",10)` + 1 次 `listActive("SOP",15)`，外加每个候选 `JSON.parse(payload)`（`rowToExperience`）与 `cosineScore`。这些都是 `better-sqlite3` **同步**调用，直接跑在 Node 事件循环上（`experience-store.ts` 方法均为同步 DB 调用、async facade）。文档宣称 FTS top-24→top-8 在每请求路径上，却没有任何时延预算/SLO，也没评估 active 集规模增长（F-07 的 active 无上限）后 bm25 + JSON.parse 的退化。当前数千级规模毫秒级可忽略，但若 active 涨到万级、并发请求叠加，同步 DB 会阻塞事件循环、抬高 tail latency。

**支撑证据**：
- `retrieval.ts:retrieve`：`store.search(fqs, 24)` → `cosineScore` 逐候选；`experience-store.ts:search` 同步 `this.readDb.prepare(...).all(...)`。
- `injection.ts:buildInjection` 每次请求额外调 `buildSkillCatalog`/`buildSopSchemas`，各自 `store.listActive`（同步查询）。
- `rowToExperience` 对每个候选 `JSON.parse(row.payload)`。

**设计方可能的反驳**：本系统是低 QPS 的 eval/campaign 场景，不是高并发在线服务；better-sqlite3 单连接同步读是刻意取舍。

**审查者回应**：接受定位，但 v2 §2.2 明确叫"在线请求全链路"、§3.4 讨论"每请求"的检索注入，至少应写一句时延量级预期（如"单请求检索+注入 < N ms @ 万级 active"）与规模假设，否则"经验库容量 10000、top-24"这些数字缺少可验证的性能边界。

---

### F-10 · minor · "升级率门控"只有跑批前阈值，无运行时熔断/自动降级；触发后的动作未定义

**文档位置**：v2 §2.1 L4（"升级率门控"）、§5.7 运维（`gate_length_escalation.py`）、inventory §5.1（"跑批放行由 gate_length_escalation.py 把守，窗口内 length 升级率 <5%"）。

**攻击论点**：设计中的"升级率门控"是 `preflight` 性质的**批前阈值检查**（跑批前算窗口内升级率，<5% 才放行，否则 fail 让人工介入），不是运行时控制回路。一旦批跑起来，中途出现升级率尖峰（学生模型劣化、DLP 配置被放宽、蒸馏产出一批低质卡导致本地质量下滑），系统**没有任何自动动作**：不会自动降级、不会熔断暂停批次、不会告警回调，唯一的下限是每请求预算 cap（429），而默认预算还是 None（F-05）。文档对"升级率门控触发后干什么"（自动降级还是人工）没有定义。

**支撑证据**：
- `gate_length_escalation.py` 为批前脚本（`--since`/`--last-hours` 窗口 JOIN），inventory §6.1 issue-005 记录其"无时间窗→永远 FAIL"的修复，均指向批前放行语义。
- v2 §2.1 L4 仅列"升级率门控"四个字，无触发后动作；全文档无运行时熔断/自适应降级组件。
- gateway 侧 `evaluate_quality` 是逐请求纯判定，无全局升级率状态、无反馈到路由的闭环。

**设计方可能的反驳**：C 判据（D7 升级率 ≤5%、新任务 <20%）是**事后验收口径**，批前门控只是防"已知 length 缺陷"（issue-003）在跑批前放行污染实验；运行时熔断属过度设计。

**审查者回应**：接受"验收口径"定位，但 v2 §1 把"升级率趋近 0"列为设计目标、§2.1 L4 把"升级率门控"列为运维层组件，读者会合理预期存在运行时控制。建议文档显式声明其边界：门控=批前放行检查，运行时无熔断，升级率失控由预算 cap + 事后人工复盘兜底——否则这是又一个"观测缺口即盲区"（issue-004/005 的教训）。

---

## 已核查但判定为**非实质问题**（不列为 finding）

- **checkpoint id `ckpt-sha256[:16]`（64 bit 截断）碰撞**：hash 输入含 `kind:epoch:snapshot`，epoch 为调用方毫秒时间戳，两批不同运行 epoch 必不同；64 bit 截断的生日碰撞点在 ~2^32 次（约 4×10⁹ 批，按每日一批约 1180 万年）。唯一理论风险是 `INSERT OR IGNORE` 静默吞掉真碰撞，但概率上不构成实质问题。不列为 finding。
- **换载瞬间"读到半个快照"**：online backup API + 重启式换载，属低风险，已并入 F-08 说明，不单列。
- **预算计量按固定 reserve 全额计费**：已在 F-05 中作为证据提及（近似而非真实花费），不单列。

## 严重级分布

- critical：0
- major：6（F-01~F-06）
- minor：4（F-07~F-10）
