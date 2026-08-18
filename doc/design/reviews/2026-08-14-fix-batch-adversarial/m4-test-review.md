# M4（T4+T5）测试 agent 独立复核报告：情景标签与检索过滤 + 晋升机制统一

日期：2026-08-14
复核人：pi-test（测试/质量 agent，独立于 pi-dev 复核）
对象：M4 里程碑（T4 F3 情景标签 + T5 F4 晋升统一），工作区未提交变更（HEAD=63b409be M3）
结论：**打回**（1 项实现缺陷：注册表双副本规则漂移，修复为一行；补测 12 例含 3 红缺陷证据）

前置说明：M3 门禁确认项（样本单位口径）已由用户裁决——**接受任务日口径、方案 §3 已修订、distinct_tasks>=2 列为 D 期调参项**。本报告 §7 标注关闭。

---

## 1. 全量测试独立复跑（不信开发方数字）

| 套件 | 开发方声明 | 独立复跑 | 判定 |
|---|---|---|---|
| TS `packages/agent-server`（Node 25 包装） | 325 通过 / 33 文件 | **325 通过 / 33 文件** | 一致 |
| Python `python/tests/` | 75 通过 | **75 通过** | 一致 |
| eval `tests/` | 71 通过 | **71 通过** | 一致 |

补测后终态（§5）：TS **332 通过**；Python **86 通过 + 3 失败**（3 失败为本复核缺陷证据测试，§2c）；eval 71 通过。

## 2. 重点审计逐项结论

### 2a. 域过滤正确性（F-18-a 验收）—— 通过，测试判别性强

- 跨域排除：检索层（带 domain 卡不返回）+ 服务器集成（/v1 与 /api/stream 注入集实测不含跨域卡，experience_injection 条目断言）双覆盖。
- 无标签放行（存量兼容）、空串标签视为无标签、domain 参数缺省不过滤——各有独立用例。
- **判别性**：主回归"跨域卡相关性与置信度双高也必须缺席"用例（补测 1）——"降权式错实现"（跨域卡排末尾仍出现在结果）会红；空池用例（过滤后无候选 → [] 不崩溃）锁定候选池不扩的接受语义。
- 过滤落点正确：bm25 候选池后、余弦重排前（T3-4 延续）；排除语义而非降权 ✓。

### 2b. domain 来源可信度（双路径）—— 通过（LLM 自报覆盖补测实证）

- **ETL 路径**：只读 session 头 metadata.task_id（M1 透传键）→ 注册表；不读消息文本——可信 ✓。
- **蒸馏路径**：collectTrajectories 读 metadata.domain（合成器写入，优先）+ 注册表回退；`_extract_card` 在 LLM 抽取**之后**强制 `card.domain = traj.domain` 覆盖。
- **覆盖判别性**：主回归蒸馏用例中 mock teacher 恰好输出 domain="office" 与 traj.domain 一致——**覆盖逻辑未被判别**；补测用产出冲突 domain="wenshu" 的自定义 extractor 实证覆盖生效（2 例绿），"信任 LLM 自报"的错实现会红。
- task_pattern 由 LLM 提取（可选字段），语义为"场景模式"，无消费者（payload 存储，F3 预留）——符合决策。

### 2c. 任务→域注册表双副本一致性 —— **缺陷（打回项 1）**

- **实测分歧**：TS `domainForTask` 用 `\btask_\d+`（词边界）；Python `task_domain` 用 `task_\d+`（子串搜索）。分歧输入 = "task_<数字>" 前接**词字符**（字母/下划线）：
  - `"mytask_00001"`、`"footask_7_bar"`、`"x_task_5_y"`：TS → `""`（保守，符合"task_id 形如 task_<编号>_<slug>"规范）；**Python → "office"（误判）**。
- 与决策 T4-1"两侧同规则镜像"声明**不符**；两侧注释均声称同规则，实际漂移已发生。
- 影响评估：C 语料真实 task_id 均为规范前缀（`task_<n>_<slug>`）或臂前缀（`experiment-/control-`，连字符 = 词边界）——**当前语料行为一致**，分歧仅对非规范命名（未来域/新任务命名）暴露；但"镜像"不变量已破，正是双副本风险清单中的漂移形态。
- 修复建议（一行）：Python `domains.py` 改 `re.compile(r"\btask_\d+")`，与 TS 完全一致。
- 缺陷证据：补测 `test_issue012_domain_registry_parity.py` 锁定同一期望表（11 用例，以 TS 语义为参照），当前 **3 例红**（mytask_00001 / footask_7_bar / x_task_5_y），修复后转绿。

### 2d. T5 闸门位置与 SOP 标记 —— 通过

- **SKILL 暂缓在统一层**：`verifyAndCanonicalize` 类型过滤（非 mapper 层）——skillsToStaged 仍产出 SKILL item（通道保留），入库被拦；补测实证 utility=1.0 也被拦（类型闸非质量闸）、**绕过 skillsToStaged 直调 VerifyItem（quality 1.0）同样被拦**（所有晋升路径受保护，T5-1 声明验证）。
- **SOP 标记纯语义**：`SOP_PREVETTED_QUALITY = 1` 常量导出 + 文档化；`sopsToStaged` 零改动（quality 恒 1，行为不变）✓。
- 五类混合批次测试（SKILL 拦 / SOP+EVIDENCE+Method+Guard 各 1）作为红线 3 修订哨兵 ✓。
- 观察（非缺陷）：手写 SOP VerifyItem quality 0.6 可过 0.5 闸——与手写 EVIDENCE/ABILITY 同等的调用方信任面，闸门不区分产物来源（contentHash 去重缓解），属统一闸既有语义。

### 2e. 红线 3 文档修订与代码一致性 —— 通过

v2 设计文档（high-level-design-v2.md L273）修订文本与实现逐条对账：EVIDENCE/ABILITY 0.5 闸（ABILITY + F1 交付物检查 + F2 confidence 信号）✓；SOP quality=1 = 预验证通过标记 ✓；SKILL 暂缓（utility 无验证对象，映射建立后解除）✓；issue-012 快照状态更新 ✓。

### 2f. harness domain 必选 kwarg 破坏面 —— 全部更新

- `run_agent` 调用点 grep：campaign.py main（domain="office"）+ test_campaign.py 4 处（321/363/382/429 全带 domain="office"，extra_body 断言含 domain）✓；alfworld_agent.py 独立 loop（extra_body 含 `"domain": "alfworld"`，L191）✓；synthesize_* 两合成器写 metadata.domain ✓。无遗漏调用点。

### 2g. 空池风险接受记录 —— 充分

决策记录 T4-3 显式声明："候选池不扩（limit×3 不变）——过滤后池可能变空，接受（同域命中率不退化仅对未打标存量库成立）"；方案 §4 验收同口径。补测锁定空池返回 []（不崩溃）+ 不带 domain 参数时同查询不受影响。存量 C 库无标签 → 过滤不激活 → 检索行为逐位不变（实测 restill 41 卡全 office 是带标签后行为，不影响该声明）。

## 3. 迁移/兼容实测

- 存量无标签库检索行为不变：domain 参数缺省路径零改动（`inDomain = domain ? filter : candidates`），无标签卡在过滤路径恒通过（补测 + 主回归双重断言）✓。
- 无新列迁移（domain 在 payload JSON 内，非 schema 列）——无迁移面；request_traces 不加列（T4-4 声明）✓。
- restill 冒烟独立复现：83 ABILITY → 41 restilled 且 **41 卡全部 domain="office"**（存量回填默认域生效，T4-5 声称验证）✓。

## 4. 测试计数与 npm run check

- 复跑基线：TS 325 / Python 75 / eval 71（与开发方一致）；补测后 TS 332 / Python 86+3 红 / eval 71。
- `npm run check`：biome 干净（唯一 info 为 pre-existing web-monitor.test.ts:107）；ts-imports/shrinkwrap/install-lock/tsgo（0 错误）/browser-smoke 全过；**check:pinned-deps 138 条全部位于 eval/results/**（pre-existing，不修，M1-M4 同口径）。

## 5. 补测试清单（本复核新增 12 例：9 绿 + 3 红缺陷证据）

| 文件 | 用例 | 结果 |
|---|---|---|
| `test/domain-tagging-extra.test.ts`（新，TS 4 例） | 跨域排除判别（相关性+置信度双高仍缺席）；空池 [] + 无参不过滤；/api/stream 域通道（元数据 + 注入集不含跨域卡——主回归只测 /v1）；TS 注册表词边界语义锁 | **全绿** |
| `test/promotion-gate-extra.test.ts`（新，TS 3 例） | SKILL utility=1.0 仍拦（类型闸非质量闸）；直调 VerifyItem quality 1.0 仍拦（统一层）；同 quality 下 EVIDENCE 过/SKILL 拦判别 | **全绿** |
| `python/tests/test_issue012_domain_registry_parity.py`（新，9 例） | 注册表双副本同一期望表（11 组输入）：规范/臂前缀/alfworld/未知 8 例绿；**词字符前缀 3 例红**（mytask_00001/footask_7_bar/x_task_5_y——缺陷证据）+ 根因正则锁定用例 | **6 绿 3 红** |
| `python/tests/test_issue012_llm_domain_override.py`（新，2 例） | 冲突 LLM 自报 domain（"wenshu"）被 traj.domain 覆盖（判别：信任自报的实现会红）；自报不泄漏 | **全绿** |

## 6. 打回清单（pi-dev 修复后本复核复跑确认）

1. **缺陷-1（必改，一行）**：`python/verification_selection/domains.py` 正则 `task_\d+` → `\btask_\d+`，与 TS `src/offline/task-domain.ts` 完全一致（双副本同规则，决策 T4-1）。修复后 `test_issue012_domain_registry_parity.py` 3 红转绿。
2. **补测保留**：本复核 4 个测试文件（12 例）随修复合入，作为双副本一致性与 T4/T5 语义的永久回归。
3. 修复后全量复跑（TS 332 / Python 89 / eval 71 全绿）并复跑 `npm run check`。

## 7. M3 确认项关闭

样本单位口径（m3-test-review §2a）：**用户已裁决——接受任务日口径，方案 §3 已修订，distinct_tasks>=2 列为 D 期调参项**。本批次未触及归因规则，与 T4/T5 无耦合；M3 门禁确认项正式关闭。

## 8. 总体结论

**门禁：打回**（仅缺陷-1；其余全部通过）。判据：① 测试全绿基线一致（325/75/71）；② check 干净（仅 pre-existing pinned-deps）；③ diff 合规（agent-server + eval + 文档，无越权）；④ 方案 §4/§4.5 逐项对账——除注册表镜像不变量外全部一致；⑤ 决策记录完整（含空池接受与窗口期声明）。

通过项（无需返工）：域过滤语义与判别性、ETL/蒸馏双路径可信度（含 LLM 自报覆盖实证）、SOP 纯语义标记、SKILL 统一层闸门、红线 3 文档一致、harness 破坏面全更新、空池接受记录、存量库兼容、restill 打标冒烟。

Refer Spec：plans/2026-08-14-fix-batch-dev-tasks.md（T4/T5）；plans/2026-08-14-post-c-unified-fix-batch-plan.md v5 §4/§4.5；doc/design/2026-08-14-m4-t4-t5-changes-and-decisions.md；doc/design/reviews/2026-08-14-fix-batch-adversarial/m3-test-review.md（§2a 关闭）
