# issue-003: 门控 length 缺陷致 B 阶段两臂 84-87% 请求误升级 DeepSeek（纯 27B 从未被测）

- 状态：open（代码修复已落地，重跑方案 A/B/C 待用户拍板）
- 报告：2026-08-09（B 阶段复盘发现，gateway model_runs 全量核验证实）
- 修复：2026-08-09 P0 批次（见下，commit 待补）
- 影响面：`packages/agent-server/eval/alfworld_agent.py`（harness 配置）、`packages/agent-gateway/src/agent_gateway/quality.py:90`（门控规则）、B 阶段全部结论（冷/热库 SR、升级率、云端成本）

## 现象

B 阶段（27B 冷/热库 A/B）复盘发现：冷库窗口 4,991 次本地调用 + 4,175 次升级（84%），热库窗口 4,915 次本地 + 4,278 次升级（87%），升级原因 100% = `finish_reason_length`（2,991/3,000 抽样）。两臂实为"27B+DeepSeek 混合体"，纯 27B 从未被测。连带撤回：A 阶段 bisect"27B 升级率 0/147=0%"（小样本不具代表性）、"本地小模型独立工作已下定论"、"27B SR 是老师 2.3 倍"、"云端成本归零"四项结论（详见根因文档 §3）。

## 根因

`eval/alfworld_agent.py:123` 设 `max_tokens=200`（v1 叙述泄漏修复时为命令提取所设），27B 蒸馏模型叙述风格（"Let me think..." 后给命令）频繁超 200 token → 截断 → `quality.py:90` `finish_reason == "length"` 无条件升级。链路逐跳透传、无任何防护：agent-server `server.ts:205/283`、`proxy-handler.ts:172` 原样转发；gateway `providers/base.py:59-65` 原样进 omlx payload。升级腿重发同一 envelope（`chat.py:494`），DeepSeek 输出简洁不触顶 → 升级"成功"，缺陷被掩盖两个跑批周期。定性：**harness 配置缺陷，非模型能力问题**。

## 修复

改造方案见 `doc/design/2026-08-09-agent-server-27b-b-round-findings-and-gate-length-flaw.md` §5（方案 A 双臂 max_tokens 800 重跑 ~4 天 / B 混合口径 0 成本 / C 仅冷库 ~2 天，**待用户拍板，跑批暂停**）。

代码审核对方案 A 的两处修正（2026-08-09，见 `doc/design/2026-08-09-adversarial-review-experiment-validity.md` §1）：

1. **补充观察"冷库臂改 agent-local 绕开门控"在当前代码下行不通**：`routing.py:31` `del envelope`——V1 路由完全忽略 model 名，agent-local 无绕门控语义。建议双臂统一 agent-auto + 调大 max_tokens（门控在 length 误杀清零后≈不触发，且 empty_output/invalid_tool 是真实质量信号，保留更接近生产口径）。
2. **max_tokens=800 需 pilot 校准**：先冷库 5 局实测 finish_reason 分布定值（800/1024）；全量验收预注册门槛：model_runs 全量口径 length 升级率 <5%，不达标不开全量（制度化"拒绝小样本外推"教训）。

门控规则本身（有内容输出的 length 是否该升级）为策略问题，记入技术债另立任务，本次不动 `quality.py`。

### 已落地（2026-08-09 P0 批次，详见 `doc/design/2026-08-09-p0-fixes-changes-and-decisions.md`）

- gateway：`x-gateway` 升级标记（M1）+ 云端结果观测（C4，cloud_finish_reason 落库/告警）+ omlx thinking 透传与 reasoning_content 解析（M9）
- eval：campaign runner 修复（C1）+ 判据 fail loud 与 model_runs 回填（C2）+ alfworld 池上界/`env.skip`/去重/提取正则/init_prompt/max_tokens 参数化/每步 finish_reason（C3/M14/M15/M16/M18/M3）+ 控制臂统一 8789/8790（M8）+ preflight 指纹（M11）+ 快照脚本（M10）
- agent-server：流式 include_usage（M2）+ system 消息合并（M5）+ SSE 标记解析（M3）+ 快照检索（M10）

### 待办（用户拍板后）

1. pilot：冷库 5 局实测 finish_reason 分布 → 定 max_tokens（800/1024）
2. `gate_length_escalation.py` 门槛（<5%）通过后开全量（方案 A/B/C 之一）

## 回归测试

已落地（2026-08-09，red-first）：

1. gateway 升级可观测标记 pytest（`packages/agent-gateway/src/agent_gateway/tests/unit/test_escalation.py`）：升级/未升级响应均带 `x-gateway` 标记（含 SSE 注释行与云端 length 告警）——先红后绿。
2. 跑批前 gating 脚本（`packages/agent-server/eval/gate_length_escalation.py`）：model_runs 全量口径 `finish_reason_length` 升级率 <5% 才允许全量开跑（pilot 后硬门槛，永久保留），测试见 `eval/tests/test_campaign.py`。
