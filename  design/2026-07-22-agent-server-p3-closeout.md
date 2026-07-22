# Agent Server P3 收尾

日期：2026-07-22
范围：` design/2026-07-22-agent-server-p3-candidate-tasks.md` 立项的 4 项 P3 候选任务，共 4 个提交

## P3 完成状态

| 任务 | 内容 | 状态 | 提交 |
|------|------|------|------|
| P3-1 | 真实 LLM 打分路径 live 验证 + 修复 2 个预存在 bug | 完成 | `4c4534d5` |
| P3-2 | benchmark 自动从 session 派生（规则化提取） | 完成 | `ae89f479` |
| P3-3 | 流式路径 toolCall 出站校验（observe-only） | 完成 | `9aec2559` |
| P3-4 | agent-server package 级 tsconfig 修复 | 完成 | `882f6ea1` |

## 任务成果摘要

### P3-1：真实 LLM 打分路径 live 验证
- 用 omlx gemma-4-12B-it-4bit 跑通 3 条 CLI 管线（verification_selection pipeline 管线、sop_lifecycle、skill_evolution）
- **修复 2 个预存在 bug**：
  1. `sop_lifecycle`/`skill_evolution` 调用不存在的 `teacher_from_env()` → 改为 `OpenAICompatClient(role="teacher")`
  2. MLX 后端不支持 logprobs → verifier 添加文本回退（正则提取 `<score_A>`/`<score_B>`）+ `extract_tag_distribution` 兼容两种入参格式
- 验证结果：verification pipeline 产出 2 cards（q=0.624/0.731），sop_lifecycle 产出 1 SOP，skill_evolution 产出 1 skill

### P3-2：benchmark 自动从 session 派生
- 新模块 `src/offline/benchmark.ts`（CLI + 编程 API）
- 规则化 concept 提取（零 LLM 调用）、去重、上限、solvable 判定
- 9 个新测试，CLI 验证产出 3 条 benchmark 样本

### P3-3：流式路径 toolCall 出站校验
- observe-only 方案：tee 中累积 `delta.tool_calls` → 比对注入白名单 → 写 `toolcall_validation` custom entry
- 共享核心 `validateAccumulatedToolCalls`（非流式阻断式 + 流式观察式共用）
- raw SSE bytes 完全不变，违规记录到 session + stderr

### P3-4：tsconfig 修复
- 删除 `packages/agent-server/tsconfig.json`，让根 config 统一管理
- 包目录下 `tsgo --noEmit` 不再报 15+ 个路径解析错误

## 验证基线

- **agent-server 全套 175 测试通过**（18 文件，含新增 P3-2 benchmark 测试 9 个、P3-3 toolCall 校验测试 8 个 unit + 10 个 integration）
- 根 `npm run check` 干净
- 所有变更仅限 `packages/agent-server/` 范围内，未修改 omlx 配置

## 实际提交清单（P3 净增 4 个）

```
ae89f479 P3-2: benchmark 自动从 session 派生
9aec2559 P3-3: 流式路径 toolCall 出站校验
4c4534d5 P3-1: 真实 LLM 验证 + 2 bug 修复
882f6ea1 P3-4: 删除 agent-server package 级 tsconfig
```

（不含约束文档 2 个：`4be52810`、`acb8808f`、`eaa049db`）

## 与 P2 closeout 的差异

- P2 基线：148 tests（16 files），本分支 agent-server 测试（`packages/agent-server/test/`）：175 tests（18 files，含 P3-2 benchmark 测试 9 个、P3-3 toolCall 校验测试 18 个）。
- Python 侧：P3 新增 verifier 文本回退逻辑（`_extract_scores_from_text`）+ `extract_tag_distribution` 入参兼容，P2 的 MockLLM 路径不受影响。
