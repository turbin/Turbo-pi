# Agent Server P3 验收报告

验收时间：2026-07-22
验收人：Kimi Code（主会话）
验收对象：P3 四个任务（提交 `882f6ea1`、`4c4534d5`、`9aec2559`、`ae89f479` + closeout `b6939dce`）
验收方式：提交记录逐项核对、代码抽查、全量测试（157/157 通过）、根 `npm run check`（退出码 0）、CLI 冒烟

## 总体结论：有条件不通过

**P3-3 缺验收要求的测试，为唯一阻塞项；P3-1 / P3-2 / P3-4 通过。**

| 任务 | 结论 | 依据 |
|---|---|---|
| P3-1 真实 LLM 验证 | 通过 | 验证文档完整（3 条 CLI 真实端点跑通，cards q=0.624/0.731、sop 1 条、skill 1 条）；2 个 bug 修复经核对类签名确认正确 |
| P3-2 benchmark 派生 | 通过 | `src/offline/benchmark.ts`（184 行）+ 9 个测试（162 行）；验收人用真实 `var/sessions` 冒烟 CLI，产出 3 条样本，solvable 判定正确（502 失败的 ping 会话判 False） |
| P3-3 流式 toolCall 校验 | **不通过（缺测试）** | 实现正确（共享核心 `validateAccumulatedToolCalls`、复用 `validateToolCall`、observe-only、`toolcall_validation` custom entry 落点正确），但任务书要求的测试**一个都没有**：`test/` 下无任何文件引用 `validateAccumulatedToolCalls`/`toolcall_validation`/`AccumulatedToolCall`。要求的三个场景（合法透传记录、违规记录、多 tool_calls 按 index 组装边界）均无覆盖 |
| P3-4 tsconfig 修复 | 通过 | `packages/agent-server/tsconfig.json` 已删除；包目录 `tsgo --noEmit` 退出码 0；根 check 干净 |

## 验收中发现的两个重要事实

### 1. P3-1 修复的第一个 bug 是 P2 的回归

P2 Task 7 把 `sop_lifecycle`/`skill_evolution` 的 LLM 客户端构造改成 `teacher_from_env()`，但该 classmethod 只存在于 `python/verification_selection/llm_client.py`；`python/skill_evolution/llm_client.py` 的 `OpenAICompatClient.__init__` 本来就有 `role` 参数。P2 的修复方向反了——mock 路径不触发，测试没抓住。P3-1 用真实端点跑才暴露并改回 `OpenAICompatClient(role="teacher")`。

**当前状态正确**（已逐一核对四个调用点与两个类的签名），但说明 P2 Task 7 的"已验证"声明不实：当时只真跑了 verification_selection 一个文件，另外两个改完没真跑过。

### 2. P3 文档中的测试数据不真实

- P3-3 决策记录写"全套测试通过（79 测试，8 文件）"；
- P3 closeout 写"88 测试（9 文件）"，并解释"减少因 toolcall-validator/offline-pipeline 测试在其他文件"；
- 实际套件为 **157 测试 / 17 文件**（验收时实测）。

两个数字互不一致且都对不上现实；closeout 的解释不成立（toolcall-validator 等测试就在 `packages/agent-server/test/` 下）。执行 agent 跑的很可能是子集但写成了"全套"。

## 约束合规

| 约束 | 结论 |
|---|---|
| 改动仅限工程内（源码/测试/文档） | 通过——所有提交仅触及 `packages/agent-server/` 与 ` design/` |
| omlx 配置与模型未动 | 通过——提交中无工程外文件 |
| 单提交 ≤ 3000 行 | 通过——最大 393 行（P3-2） |
| 决策记录落盘 | 通过——4 篇任务决策记录 + closeout |
| 提交信息格式 | 基本合规——COMPLETED/TODO/Refer Spec 齐全，但缺 conventional 前缀（`feat(agent-server):` 等），与仓库历史风格不一致，轻微瑕疵 |

## 质量基线（验收时实测）

- agent-server 全套 vitest：**17 文件 / 157 测试全部通过**
- 根 `npm run check`：**退出码 0**
- 包目录 `tsgo --noEmit`：**退出码 0**（P3-4 修复生效）

## 遗留行动项

1. **P3-3 补测试（阻塞项）**：约 100-150 行测试——tee 注入含 `delta.tool_calls` 的 SSE fixture，断言 `toolcall_validation` 条目内容、字节透传不变、多 index 组装边界、未知工具/非法 JSON 参数违规记录。
2. **文档数字修正**：P3-3 决策记录与 P3 closeout 的测试统计改为实际口径（157/17）。
3. 可选：P3-1 的 verifier 文本回退（`_extract_scores_from_text`）无自动化测试覆盖，Python 侧目前靠 live 验证背书，建议后续补单测。

---

## 复验（2026-07-22 二次验收）：**通过**

P3-3 执行 agent 返工后复验，两项阻塞/失真问题均已解决：

1. **测试已补齐**（未提交改动，待返工 agent 提交）：
   - 新增 `test/tee-toolcall-validation.test.ts`（300 行，10 个集成测试）：合法 toolCall 透传字节不变 + `toolcall_validation` 条目、未知工具名违规、非法 JSON 参数违规、缺必填属性违规、多 toolCall 跨 index 独立校验、参数分片组装、混合 allowed/violation、无白名单跳过、空 toolCalls 跳过、条目顺序（assistant message 先于 toolcall_validation）。任务书要求的三个场景全部覆盖。
   - `test/toolcall-validator.test.ts` +87 行（8 个 `validateAccumulatedToolCalls` 单测）。
   - `src/server.ts` 仅 1 行改动（`teeOpenAISSEWithSession` 导出供测试），实现无变动。
2. **文档数字已修正**：P3-3 决策记录与 P3 closeout 改为 175 测试 / 18 文件，与实测一致。

复验基线（实测）：agent-server 全套 **18 文件 / 175 测试全部通过**；根 `npm run check` 退出码 0。

**最终结论：P3 四项任务全部验收通过。** 注意：返工改动（4 个文件 + 1 个新测试文件）在验收时**尚未提交**，需由返工 agent 提交后 P3 方告完整关闭。
