# Agent-Server E 评估里程碑任务书：benchmark 自动化评估环境（SWE-bench + Terminal-Bench）

日期：2026-07-24
状态：**已立项（2026-07-24 用户拍板：两个 benchmark 一起上，在线转发直连 DeepSeek）**
目标：搭建自动化 benchmark 评估环境，用 A/B 对照回答"agent-server 经验注入是否有效"——对照组直连 DeepSeek，实验组经 agent-server（注入开），并用"跑一轮→进化→再跑一轮"验证经验飞轮。
进度跟踪：` design/progress/2026-07-24-eval-benchmark.md`

---

**通用约束**：见 ` design/2026-07-22-agent-server-p3-candidate-tasks.md`"通用约束"。新增：第三方 benchmark 工具（mini-swe-agent、terminal-bench、swebench）**必须装在仓库内隔离环境**（`packages/agent-server/eval/.venv`，gitignored），不进系统 Python、不动 omlx。

**成功判据（预先定义，防事后搬球门）**：
1. 实验组通过率 ≥ 对照组（注入无害）；
2. 第 2 轮（进化后）通过率 > 第 1 轮（飞轮有效）；
3. 报告必须同时给出 per-task 成本与 empty-patch/错误分布（防止"分数涨了但成本爆炸"的假成功）。

**已查证的关键事实（2026-07-24 调研）**：
- SWE-bench：数据集 `princeton-nlp/SWE-bench_Lite`（300）；agent 产出 `preds.jsonl`（instance_id/model_patch/model_name_or_path）→ `python -m swebench.harness.run_evaluation` Docker 评分；**官方评分镜像 x86_64**，Apple Silicon 需 colima Rosetta（慢 3-5 倍）。
- Terminal-Bench 2.0：`tb run --agent-import-path <adapter> --model <openai兼容>`；任务镜像本地构建（arm64 友好）；89 任务。
- mini-swe-agent：~100 行 bash agent，litellm 接任意 OpenAI 兼容端点（`openai/<model>` + `OPENAI_BASE_URL`），SWE-bench 官方标准 harness，分数可与公开 leaderboard 对比。
- agent-server 转发：`GATEWAY_URL` 后由 client 拼 `/v1/chat/completions`——**指 DeepSeek 时不得带 /v1**（`GATEWAY_URL=https://api.deepseek.com`，`AGENT_GATEWAY_KEY=<key>`）；`PORT` env 改端口。

**坑（全部有前人踩过，已记录对策）**：
1. **DB 隔离**：benchmark session 必须进独立评估实例的独立 DB，不得污染生产经验库（`packages/agent-server/var/eval/`）。
2. **代理 MITM**：任务容器内 pip/apt/git 需 `HTTPS_PROXY` + CA 证书（复用 N2 经验）。
3. **成本**：先 5-10 任务小样本估单价，再扩量；DeepSeek 并发建议 2-4。
4. **x86 评分慢**：SWE-bench 先 10 个实例验证评分链路，再决定全量。

---

## E0：评估实例 + 接线冒烟

**预估：~半天；token ~80k。依赖：无。**

1. 起评估专用 agent-server（host tsx，不进 compose）：
   ```bash
   cd packages/agent-server
   PORT=8789 EXPERIENCE_STORE_PATH=./var/eval/experience.db \
   AGENT_SERVER_SESSION_DIR=./var/eval/sessions \
   GATEWAY_URL=https://api.deepseek.com AGENT_GATEWAY_KEY=<deepseek key> \
   ../../scripts/with-node25.sh npx tsx src/start.ts
   ```
   `var/eval/` 入 .gitignore（检查 var/ 规则是否已覆盖）。
2. curl 冒烟：向 8789 发一条 chat 请求 → 确认 DeepSeek 应答 + `var/eval/sessions/` 落盘 + 注入消息出现在 custom_message（当前库空，注入应为空块）。
3. **harness 选型决策点**：评估 Kimi Code / pi 作为 benchmark agent 的可行性（headless 模式、容器内安装与鉴权成本）vs mini-swe-agent 兜底。结论写进决策记录。**默认推荐 mini-swe-agent**（标准 harness、分数可横向对比、零鉴权问题）。
4. 安装隔离环境：`packages/agent-server/eval/` 下 `uv venv .venv && uv pip install mini-swe-agent terminal-bench`（版本锁进 requirements.txt）。
5. mini-swe-agent 接线冒烟：`OPENAI_BASE_URL=http://127.0.0.1:8789/v1 OPENAI_API_KEY=dummy mini run`（model `openai/deepseek-v4-pro`）跑一个 toy 任务，确认 8789 收到请求并落盘。

**验收**：8789 全链路通（注入/转发/落盘）；隔离 venv 可用；mini-swe-agent 经 8789 完成一次调用；选型结论落决策记录。

## E1：A/B 对照 harness 脚手架

**预估：~150 行 + 配置；token ~100k。依赖：E0。**

1. `eval/` 下写运行编排（脚本或 make 式 CLI）：对同一任务子集跑两臂——
   - 对照臂：`OPENAI_BASE_URL=https://api.deepseek.com/v1`（直连）；
   - 实验臂：`OPENAI_BASE_URL=http://127.0.0.1:8789/v1`（经 agent-server）；
   - 两臂同模型（`deepseek-v4-pro`）、同任务、同并发（2）。
2. 每臂产出：结果 JSONL + 成本统计（从 agent-server session/usage 或 litellm 侧采集）+ 轨迹归档目录。
3. 随机化和顺序：任务顺序固定种子；两臂跑同一 shuffle。
4. **防泄漏**：实验臂跑完一轮后、下一轮开始前，先把上一轮 session 从评估库导出归档（防与生产 var/ 混），进化只读评估库。

**验收**：同一 5 任务子集两臂各跑通一次；成本与通过率落盘可比。

## E2：Terminal-Bench A/B（先行出结果）

**预估：adapter ~100 行；token ~120k。依赖：E1。**

1. 写 tb agent adapter（`eval/tb_agent.py`，`--agent-import-path` 协议），模型走 `openai/deepseek-v4-pro`，端点按臂切换。
2. 5 任务冒烟（两架构）→ 修坑（代理/CA/超时）。
3. 89 任务 A/B 全量（并发 2，预算上限预设；超支即停并报告）。
4. 结果落 `eval/results/tb-<date>/`，含 pass rate、per-task 成本、失败分类。

**验收**：TB 全量 A/B 报告；若代理/成本阻断，记录实际完成子集与原因。

## E3：SWE-bench A/B

**预估：~200 行 + harness 配置；token ~150k。依赖：E1（可与 E2 并行）。**

1. mini-swe-agent 跑 SWE-bench Lite 10 实例子集（固定 instance id 清单入 `eval/instances-10.txt`），产出 `preds.jsonl`。
2. 评分链路：`swebench.harness.run_evaluation`——先解决 x86 镜像（colima Rosetta：`colima stop && colima start --vz-rosetta`，**需用户确认**（重启 VM 影响在跑容器）；或验证官方 arm64 镜像是否已发布）。
3. 10 实例 A/B → 成本核算 → 用户拍板是否扩 300 全量。
4. 结果落 `eval/results/swe-<date>/`。

**验收**：10 实例 A/B 评分报告（resolved/unresolved/error/empty_patch 四类齐全）；扩量决策有依据。

## E4：飞轮实验 + 总评估报告

**预估：文档为主；token ~80k。依赖：E2+E3。**

1. 实验臂第 1 轮（冷库）→ 对评估库 `runDailyEvolution`（DeepSeek teacher，复用 .env）→ 第 2 轮（热库，注入上一轮经验）。
2. 对照成功判据三条出总报告 ` design/<date>-agent-server-eval-report.md`：A/B delta、轮间 delta、成本曲线、失败分类、结论（成功/部分成功/失败 + 依据）。
3. 若判据 2 不成立，分析是注入检索 miss（FTS 查不到）还是经验质量不足，给下一步立项建议。

**验收**：总评估报告 + 决策记录；INDEX/progress 收口。

## token 用量评估汇总

| 任务 | 预估 | 依赖 |
|---|---|---|
| E0 评估实例 + 接线冒烟 | ~80k | 无 |
| E1 A/B 脚手架 | ~100k | E0 |
| E2 Terminal-Bench A/B | ~120k | E1 |
| E3 SWE-bench A/B | ~150k | E1 |
| E4 飞轮 + 总报告 | ~80k | E2+E3 |
| **合计** | **~530k + API 成本（小样本先行）** | |
