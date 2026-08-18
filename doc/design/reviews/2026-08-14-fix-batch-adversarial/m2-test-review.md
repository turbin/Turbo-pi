# M2（T2）测试 agent 独立复核报告：卡片交付物维度（issue-010 主体）

日期：2026-08-14
复核人：pi-test（测试/质量 agent，独立于 pi-dev 复核）
对象：M2 里程碑（T2，F1 交付物维度），工作区未提交变更（HEAD=0b7fe8d3 M1 已提交）
结论：**门禁通过**（无阻断缺陷；4 项非阻断 finding 记录在案，§6；补测 11 例全绿）

---

## 1. 全量测试独立复跑（不信开发方数字）

| 套件 | 开发方声明 | 独立复跑 | 判定 |
|---|---|---|---|
| TS `packages/agent-server`（Node 25 包装） | 295 通过 / 32 文件 | **295 通过 / 32 文件** | 一致 |
| Python `python/tests/` | 57 通过 | **57 通过** | 一致 |
| eval `tests/` | 54 通过 | **54 通过** | 一致 |

补测后终态（§5）：TS **298 通过**、Python **65 通过**、eval 54 通过，全绿无红（本轮未发现实现缺陷，补测为判别性用例——对"换错实现"会红，对当前实现绿）。

## 2. 测试质量审计（防假绿）

### 2.1 `test/regressions/issue-010-card-deliverable-gate.test.ts`（11 例）

逐例断言强度：

| 组 | 用例 | 强度 | 审计结论 |
|---|---|---|---|
| 映射 | deliverables 进 ABILITY payload；EVIDENCE 路由卡也映射 | 强 | payload 存储契约锁定（含 Guard 卡经 promoteStagedOutputs 集成用例） |
| 闸门 | 缺字段 / 空数组 / 非数组 / 含空串 / 非字符串 → 不晋升；Guard 同 | 强 | normalizeDeliverables 全校验路径覆盖；`verifyAndCanonicalize` 零晋升 + 库内零条（物理断言非仅 mapper 层） |
| 豁免 | SKILL/SOP 无交付物概念照常晋升；Workflow→EVIDENCE；raw EVIDENCE | 强 | 三条豁免路径全部有"实际入库"断言（listActive 计数），非仅不拦截断言 |
| 集成 | 旧模板 Method 拦 / 新模板 Guard 晋升（cards.json 全链路） | 强 | 端到端存储断言 + payload.deliverables 落库断言 |

空洞（补测关闭）：① 纯空白串交付项 `"   "`（实现用 `trim()`，主文件未测）；② 角色缺失的旧格式卡路由 EVIDENCE → 豁免闸门（现状未锁定，见 §6-5）。

### 2.2 `python/tests/test_issue010_deliverable_check.py`（12 例）+ `test_issue010_restill.py`（4 例）

- **封顶是"物理拦截"非软降分**：成立。实现为双保险——quality 封顶 `min(q, 0.49)`（严格 <0.5 默认阈值）+ `accepted = (not capped) and qf >= threshold`（下调阈值 0.2 仍 False，测试 5 断言）。测试 4/5 覆盖新鲜路径。
- **豁免路径有真测试**：SOP/SKILL（TS 侧 skillsToStaged/sopsToStaged + 入库）、EVIDENCE 两条路径（TS raw EVIDENCE + Python `--rescore` 质量保持 0.672 不被封顶）——非口头豁免，均有断言。
- **崩溃/断点真实性**：restill 冒烟 4 例覆盖源定位去歧义（同 task_id 跨日双 session，trace_span_ref 前缀区分）、无交付源淘汰、缺源不致命、resume 幂等（journal 不翻倍 + 产物逐位一致）。
- 空洞（补测关闭）：① **resume 路径封顶**（主测试只走新鲜打分路径——"resume 不重查交付、缓存质量直接按阈值放行"的错实现现有测试全过）；② 指纹版本失效（M1 时代 journal 无 DELIVERY_CAP_VERSION，T2-6 声称"全部失效重打"，无测试）；③ 检测器边界（误报/漏报方向未锁）。

## 3. 机制核查

### 3a. 旧格式 staged JSON 行为（无 deliverables）——与"存量卡渐进替换"声明一致

- TS：旧模板 Method/Guard 卡（无 deliverables）在 `cardsToStaged` 被闸门丢弃（集成测试 9 实证）；角色路由到 EVIDENCE 的旧卡豁免。
- Python：CARD_SCHEMA required 增 deliverables → 旧格式卡在抽取期 SchemaError 即被拒，根本到不了 staged JSON。
- **存量库行不受影响**：`verifyAndCanonicalize` 按 contentHash 命中既有行即跳过（代码核查，`if (existing) { ...; continue; }`），不重查交付字段——83 条存量 ABILITY 卡继续 active，替换靠 restill 排期执行。三层（抽取拒 / 闸门拦 / 存量不动）与决策记录 T2-4/§3-1 完全一致。

### 3b. normalizeDeliverables 闸门仅作用 Method/Guard（ABILITY）——通过

`cardsToStaged` 中 `type === "ABILITY" && deliverables === null` 才拦截；Workflow/missing/unknown role → EVIDENCE 携带 `deliverables ?? []` 照常晋升。代码与测试（用例 7/8、§2.1 豁免组）一致。

### 3c. 封顶逻辑新鲜 vs resume 双路径一致性（M1 checkpoint 交互）——通过

- 代码核查：`_apply_deliverable_cap` 在 `score_trajectories_with_checkpoint` 的**两条路径**（新鲜打分分支 + 缓存复用分支）同样调用，同一确定性启发式——封顶幂等。
- journal 存**原始质量**（未封顶），封顶在读取时施加 → resume 从原始值重新封顶，无双封顶/漏封顶。
- 阈值正交在 resume 路径同样成立（`(not capped) and qf >= score_threshold` 公式共用）。
- **M1→M2 缓存迁移**：`prompt_fingerprint` 增 `extra` 参数（默认 "" 向后兼容），管线传 `DELIVERY_CAP_VERSION="v1"` → M1 时代 journal 的 input_hash 全部不匹配 → 重打。补测 4 实证（构造 extra="" 的旧条目 → 当前管线重打 + 新语义生效）。
- 一致性已由补测（§5-1）测试锁定。

### 3d. restill.py 声称抽查——用真实 C 库导出独立复现，全部吻合

`backup/c-campaign-20260814/cards/active-cards.json`（真实导出）+ `eval/sessions-synth/` 实测（mock LLM）：

| 声称 | 独立复现 | 判定 |
|---|---|---|
| 83 ABILITY 卡 / 837 非 ABILITY 跳过 | 83 / 837 | ✓ |
| 41 restilled（全含非空 deliverables） | 41，0 条空/缺 deliverables | ✓ |
| 6 rejected_no_deliverable | 6（exp-e2c7.../exp-0fdd... 等） | ✓ |
| 36 rejected_low_quality | 36 | ✓ |
| 0 缺源（83/83 定位成功） | 0 | ✓ |
| 50 打分组落盘 | scores.jsonl 50 行 | ✓ |
| resume 零追加 + 产物逐位一致 | 二次运行 BYTE-IDENTICAL（cards/report），journal 仍 50 行 | ✓ |

### 3e. 检测器误判方向——确为安全方向（含两处边界实证）

- **漏报（安全方向）**：纯读操作（`cat`/`ls`/`diff`/`grep`）、`/dev/null` 重定向、**未加引号路径的交付声明**（"wrote the summary to /tmp/out.json" 不命中）→ 判无交付 → 封顶 → 不产新卡。方向安全（误杀新卡，不放过坏卡）。
- **误报（permissive 边，已知边界）**：`bash: echo debug > /tmp/debug.log` 判为有交付——无真实交付但含写命令噪声的轨迹可绕过封顶（决策记录 §3-3"交付证据≠交付证明"的诚实边界，主防线是重蒸 + 双闸 + 验收 campaign）。方向记录在案。
- C 语料 4/98 误封顶形态（内联答案/API 执行/SPARQL 内联）复现为"不判交付"（补测锁定）。

## 4. 测试计数

- 复跑基线：TS 295 / Python 57 / eval 54（与开发方一致）
- 补测后：TS 298 / Python 65 / eval 54
- `npm run check`：biome 干净（唯一 info 为 pre-existing web-monitor.test.ts:107，非本批次文件）；check:ts-imports / check:shrinkwrap / check:install-lock / tsgo --noEmit（0 错误）/ check:browser-smoke 全过；**check:pinned-deps 失败 138 条全部位于 eval/results/**（gitignore campaign 工件，13 个唯一文件，与本变更无关）——pre-existing，不修，与 M1 同口径。

## 5. 补测试清单（本复核新增，11 例全绿）

| 文件 | 用例 | 判别性（对错实现会红） |
|---|---|---|
| `test/regressions/issue-010-deliverable-gate-extra.test.ts`（新，TS 3 例） | 纯空白串交付项 → 拒；空白串清单整体拒 + 零晋升；role-less 旧卡路由 EVIDENCE 豁免（现状锁定） | trim 缺失 / 部分项校验 / 闸门误伤非 ABILITY 的实现会红 |
| `python/tests/test_issue010_resume_cap.py`（新，4 例） | resume 路径重放封顶（阈值 0.2 仍拒）；resume 不误伤有交付轨迹；PPT 组 resume 与新鲜逐位一致；M1 时代 journal（extra=""）失效重打 | "resume 不重查交付" / "无指纹版本"实现会红 |
| `python/tests/test_issue010_detector_edges.py`（新，4 例） | 读操作与 /dev/null 不判交付；未引号声明漏报（保守边锁）；调试 log 误报边锁（现状）；内联答案/API 执行型保持无交付 | 检测器方向改动（收紧引号要求 / 放宽读操作）会红 |

## 6. 非阻断 finding（记录在案，不构成打回）

1. **PPT 混合组交互（设计层）**：封顶在锦标赛归一化**之后**施加——组内无交付轨迹质量更高时，其归一化分压过有交付伙伴（实证：无交付 0.49 capped / 有交付 0.3849，双双拒）。结果保守（不产卡）但误伤有交付轨迹。候选改进：封顶后重归一化或将无交付轨迹先排除出锦标赛。决策记录未提及该交互。
2. **检测器误报边**：`bash: echo x > /tmp/debug.log` 类噪声算交付证据（§3e），决策记录 §3-3 已声明边界，无新增风险。
3. **检测器漏报边**：未加引号路径的交付声明不命中（保守方向，安全）。
4. **restill 源定位回退**：trace_span_ref 非空前缀无匹配时静默取首日文件（`_pick_source` fallback），可能选错日 session——report 含 source_session 字段可审计；真实数据 83/83 前缀匹配成功，未触发。
5. **role-less 卡豁免**：缺 role 的旧格式卡路由 EVIDENCE 绕过交付闸（五元组 role 必填，仅异常输入可达）；已由补测锁定现状，后续批次若收紧需同步改测试。

## 7. 总体结论

**门禁：通过**。判据逐项：① 目标测试 + 相关包测试全绿（TS 298 / Python 65 / eval 54，含补测）；② `npm run check` 干净（仅 pre-existing pinned-deps，与本变更无关）；③ diff 规模与范围合规（agent-server + 文档，无越权改动，~700 行 < 3000 行约束）；④ 方案 §2 F1 改动点逐项对账（schema 三处 / 双闸 / 豁免 / 重蒸 / 回归测试）全部落地且与决策记录一致；⑤ 决策记录随工作区待提交。

4 项非阻断 finding（§6）无需返工，建议主会话在后续批次（T3 归因奖惩）设计时考虑 finding-1 的 PPT 交互。

Refer Spec：plans/2026-08-14-fix-batch-dev-tasks.md（T2）；plans/2026-08-14-post-c-unified-fix-batch-plan.md v5 §2；doc/design/2026-08-14-m2-t2-changes-and-decisions.md；doc/issues-snapshot/issue-010-card-guided-execution-crowds-out-deliverable.md
