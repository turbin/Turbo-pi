# M5（T6+T7）测试 agent 独立复核报告：quick wins 四项 + 交叉评估臂 harness

日期：2026-08-14
复核人：pi-test（测试/质量 agent，独立于 pi-dev 复核）
对象：M5 里程碑（T6 台账 quick wins 四项 + T7 交叉臂 harness），工作区未提交变更（HEAD=c78416b5 M4）
结论：**打回**（1 项严重缺陷：T7 交叉臂跑批回路三处断裂——NameError + 注入维度未接线 + 冻结实例未接线；补测 3 例红为缺陷证据）

---

## 1. 全量测试独立复跑（不信开发方数字，四项）

| 套件 | 开发方声明 | 独立复跑 | 判定 |
|---|---|---|---|
| TS `packages/agent-server`（Node 25 包装） | 338 通过 / 35 文件 | **338 通过 / 35 文件** | 一致 |
| Python `python/tests/` | 89 通过 | **89 通过** | 一致 |
| eval `tests/` | 81 通过 | **81 通过** | 一致 |
| gateway `uv run pytest` | 185 通过 | **185 通过** | 一致 |

补测后终态（§5）：TS 338 / Python 89 / gateway 185 不变；eval **81 通过 + 3 失败**（3 失败为本复核缺陷证据测试，§2e）。

## 2. 重点审计逐项结论

### 2a. GatewayMarker trace_id 四构造点 —— 通过（全覆盖 + 消费侧含键）

- **四构造点 grep 实证**：`chat.py:504`（escalate_to_cloud 非流式）、`:560`（execute_with_escalation 非升级）、`:683`（stream_traced_events 升级）、`:691`（stream 非升级）——全部带 `trace_id`，无遗漏。
- **对账键语义**：trace_id = 响应体 id（`openai_response` 的 `"id": trace_id`，chatcmpl-*），marker.to_dict() 含 trace_id → SSE 注释 → agent-server 侧解析同一键。gateway model_runs 与 agent-server session 条目逐请求对账成立。
- **消费侧双路径**：/v1 流式内联（server.ts:570 gateway_marker custom entry，M1 已有）+ handleStream 路径（proxy-handler.ts:151 done 事件补写，本次新增）——/api/stream 与 /v1 非流式共用 handleStream，契约一致 ✓。

### 2b. DLP tools[] 扫描 —— 通过（SOP 出网路径覆盖实证 + 默认模式清单正确）

- 扫描面：`tools[i].function.description` + `parameters`（JSON 序列化）——SOP schema 经 buildInjection 合并进 tools → toOpenAIRequest → gateway envelope.tools，正是消息文本之外的出网盲区 ✓。
- 测试判别性：tool description 内 api_key 赋值命中（location `tools[0].function.description`）、parameters schema 内 PEM 私钥命中（`tools[0].function.parameters`）、干净 schema 零 finding——3 例齐全 + 身份证号默认模式 1 例（`110101199003078888` → `chinese_id_number`）。
- 默认模式清单：4 条 = 3 条密钥类（aws_access_key_id / private_key_pem / api_key_assignment）+ 身份证号（18 位，`\b\d{17}[\dXx]\b`，词边界防 19+ 位长串误中）——与用户裁决 5 一致；config.security.dlp_patterns 合并覆盖机制为既有（SecurityConfig 编译校验），docstring 文档化 ✓。

### 2c. ETL 完整性校验 —— 通过（判别性齐全）

- 判据：session 头 + 流闭合标记（response_completed/error/aborted）→ 完整；有头无闭合 → **整体隔离**（isolated 列表 + scheduler 快照 etlIsolated 计数）；无头 legacy → 无信号维持摄入。
- 测试 5 例判别性：半截隔离（篡改闭合标记即拒）+ 零摄入断言、正常 session 不误伤、error 闭合仍摄入（完整性≠成功）、legacy 无信号摄入、混合批次只隔离坏文件——全部有库内状态断言。
- 两条写 session 路径（handleStream teeWithSessionClose / /v1 teeOpenAISSEWithSession）均写闭合标记（grep 实证）——无"新判据把正常 session 全隔离"的灾难性回归。

### 2d. 快照留存 N=7 + 回滚 runbook —— 通过

- `--snapshots-dir <dir> [--retain N]` 每日模式：时间戳命名、按名序剪枝、非快照文件不动、legacy 双参模式保留——测试 4 例锁定（含连造 9 份留 7 份、最早 2 份被剪、内容有效性）。
- 回滚 runbook 三步（冻结回滚不动 live / 整库回滚 cp 覆盖 / 验证）写入 docstring——"回滚到昨日 active 集"可执行。

### 2e. T7 四臂 —— **缺陷（打回项 1，严重）**

**差分纯函数与 plan 预注册一致**（通过部分）：`campaign_cross.py`——臂定义 X1/X2/X3/X4 与库/注入映射、差分公式（库演进 X2−X1、即时注入 X1−X4、sanity X3−X4）、SANITY_TOLERANCE=0.05、n_per_arm_per_day=20、per-day + overall、任务日配对设计（四臂同任务集 → 均值差即配对差）；--metrics 集成（四臂齐全时附 cross 核算）——与 plan 逐条一致 ✓。

**但 campaign.py --arms 跑批回路三处断裂**（缺陷证据：mocked 端到端驱动实测）：

1. **NameError（回路无法运行）**：row 构造 `**({"library": library} if args.arms else {})`——`library` 在 campaign.py 全文件无定义（grep 实证）。--arms 模式在**第一个任务落库行**即崩溃 `name 'library' is not defined`。dry-run 与 --metrics 冒烟均在回路之前返回，未触达。
2. **注入维度未按臂接线（2×2 设计注入维度失效）**：`injection=arm == "experiment"`——交叉臂名 x1..x4 恒不等于 "experiment" → **四臂全部注入关闭**（X1/X2 本应注入开）。campaign_cross.ARM_INJECTION 常量存在但**无人消费**（grep 实证）。
3. **冻结实例未接线（"锁库不换载"未落地）**：`client_frozen` 创建后从未使用（grep 实证）——X1/X4 与 X2/X3 同走 `client`（AGENT_SERVER 当日实例），冻结臂实际跑的是当日库。

综合影响：**T7 四臂跑批当前不可用**（崩溃），即使绕过崩溃，跑出的四臂数据也不是 2×2 设计（注入全关 + 库无冻结）——差分核算将得到无意义结果。开发方"四臂 dry-run / 合成 metrics 冒烟"未覆盖回路，属冒烟路径选择漏洞。

**缺陷证据测试**：`eval/tests/test_campaign_cross_wiring.py`（3 例，mocked 端到端驱动 campaign.main() 真实执行 --arms 回路）：断言按臂注入开关（ARM_INJECTION）、冻结臂走 --frozen-base-url 实例、落库行带 library 维度——当前实现 3 例全红（首例即 NameError 崩溃实证）。

### 2f. proxy-handler gateway_marker 与 /v1 契约一致性 —— 通过

handleStream done 事件补写 gateway_marker custom entry（与 /v1 流式内联同形状：event.x_gateway 解析 JSON 直落），非流式 /v1 响应体 x_gateway 保留（server.ts:473）——两条路径 + 两种流式形态契约一致。

## 3. 测试计数与 npm run check

- 复跑基线：TS 338 / Python 89 / eval 81 / gateway 185（与开发方一致）；补测后 eval 81+3 红。
- `npm run check`：biome 干净（唯一 info 为 pre-existing web-monitor.test.ts:107）；ts-imports/shrinkwrap/install-lock/tsgo（0 错误）/browser-smoke 全过；**check:pinned-deps 138 条全部位于 eval/results/**（pre-existing，不修，M1-M5 同口径）。

## 4. 补测试清单（本复核新增 3 例，全红 = 缺陷证据）

| 文件 | 用例 | 结果 |
|---|---|---|
| `eval/tests/test_campaign_cross_wiring.py`（新，3 例） | mocked 端到端驱动 `campaign.main()` 真实执行 --arms 回路：① 注入开关按臂接线（x1/x2 开、x3/x4 关）；② 冻结臂走 --frozen-base-url 实例、当日臂走 AGENT_SERVER；③ 落库行带 library 维度且按臂正确 | **3 红**（首例 NameError 崩溃实证；修复后转绿） |

## 5. 打回清单（pi-dev 修复后本复核复跑确认）

1. **缺陷-1（严重，必改）campaign.py --arms 回路**：
   - a) row 构造的 `library` 改为按臂取值（建议消费 `campaign_cross.ARM_LIBRARY[arm]` 单一事实源——常量已在，接线即可）；
   - b) `injection=` 按臂映射（`campaign_cross.ARM_INJECTION[arm]`），不再用 `arm == "experiment"`；
   - c) 冻结臂（X1/X4）使用 `client_frozen`（base_url = --frozen-base-url），当日臂用 `client`。
   - 修复后 `test_campaign_cross_wiring.py` 3 红转绿。
2. **补测保留**：wiring 3 例 + 既有 campaign_cross 纯函数测试，作为 T7 回路的永久回归。
3. **冒烟口径补强**：dev 侧后续冒烟应包含"回路级"冒烟（本 wiring 测试即最小回路冒烟），dry-run/--metrics 不可作为 T7 可用性证据。
4. 修复后全量复跑（TS 338 / Python 89 / eval 84 / gateway 185 全绿）并复跑 `npm run check`。

## 6. 总体结论

**门禁：打回**（缺陷-1 严重：T7 是 M5 的核心交付物之一，跑批回路不可用且 2×2 语义未接线）。判据：① 测试基线全绿一致（338/89/81/185）；② check 干净（仅 pre-existing pinned-deps）；③ diff 合规；④ 方案 §5 台账与交叉臂 plan 逐项对账——**除 T7 回路接线外全部一致**；⑤ 决策记录完整（含边界声明）。

通过项（无需返工）：marker trace_id 四构造点全覆盖 + 消费侧双路径契约、DLP tools[] 扫描（含 SOP 出网路径）与默认模式清单、ETL 完整性判据与隔离计数、快照留存 N=7 与回滚 runbook、campaign_cross 差分纯函数与预注册一致性、T6 其余三项。

Refer Spec：plans/2026-08-14-fix-batch-dev-tasks.md（T6/T7）；plans/2026-08-14-post-c-unified-fix-batch-plan.md v5 §5；plans/2026-08-14-plan-library-version-cross-eval.md；doc/design/2026-08-14-m5-t6-t7-changes-and-decisions.md
