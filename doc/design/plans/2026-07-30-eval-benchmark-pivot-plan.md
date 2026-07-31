# E 里程碑改道：benchmark = ALFWorld + QwenClawBench + Claw-Eval——实施方案

日期：2026-07-30（v3，按用户反馈：ALFWorld 保留；SWE-bench/WebArena 去除；新增 ClawEval、QwenClawBench）
决策：Terminal-Bench/SWE-bench 全部弃用；TB 全量已停（控制臂 8 trial：2 resolved，数据归档保留于 `eval/results/tb-full-20260729/`）。

## 三个 benchmark 调研结论（全部已验证到命令级）

| | ALFWorld | QwenClawBench | Claw-Eval |
|---|---|---|---|
| 任务 | 134（valid_unseen，6 类型） | 100（8 域，hybrid 评分） | 300（文本子集 199：general 161 + multi_turn 38） |
| Harness | 自写 ReAct loop（~150 行，论文标准协议） | OpenClaw（Docker 镜像 ghcr.io/openclaw/openclaw:main，**arm64 已确认**） | 官方 claw-eval CLI（host 侧 agent loop + mock services） |
| 臂切换 | OPENAI base_url（零代码） | openclaw.json 双 provider（零代码） | 两份 config YAML（零代码） |
| 实验臂路径 | http://localhost:8789/v1 | http://host.docker.internal:8789/v1（容器内） | http://localhost:8789/v1（host 侧） |
| 评分 | env info['won']，确定性 | automated checks + LLM judge（host 侧 POST） | 确定性检查 + LLM judge（2159 rubric） |
| 双臂成本（1 trial/run） | **$3-10** | **~$8**（区间 $3-30） | 文本子集 **~$8**，全 300 ~$12 |
| 主要坑 | textworld==1.6.2rc5 arm64 wheel、jericho 编译、8789 透传 stop 参数 | 容器→宿主 host.docker.internal（必要时 1 行 --add-host patch）、bind mount 权限、task_00005 需 feishu 凭据（排除） | **不装 pypi 的 claw-eval（抢注包）**；多模态 101 任务需视觉模型（v4-flash 文本，跳过）；sandbox 镜像构建 |

**Judge 模型决策（建议）**：agent 用 v4-flash；judge 用 **deepseek-v4-pro**（$0.435/$0.87，judge 成本仍 <$5）——QwenClawBench hybrid 惩罚式评分对 judge 质量敏感，避免 v4-flash 自判偏置；并在决策记录声明 judge 口径（判据③要求同报）。

## 不变的部分

成功判据 3 条（实验≥对照 / 轮2>轮1 / 成本与错误分布同报）、双臂端点切换、评估实例 8789、防泄漏归档纪律、8899 中继（控制臂直连等价物）、8898 正向代理、E 总任务书/INDEX 将 TB 与 SWE-bench 标【废】并记录替换决策、决策记录/progress/commit 纪律。

## 实施步骤

### P1：ALFWorld（E2'，~1 天，$3-10）
1. `eval/.venv`：`uv pip install --no-deps alfworld==0.4.2` + `textworld==1.6.2rc5 pyyaml gymnasium`（jericho 编译失败 → Docker fallback）；`alfworld-download`（跳过 mrcnn）
2. `eval/alfworld_agent.py`（~150 行 ReAct，chat API，stop=["\n"]，temperature=0，49 步上限，JSONL 落盘）；游戏顺序 patch 排序 + 固定 134 清单
3. **8789 透传预检**：stop 参数生效 + usage 落盘（失真先修 agent-server，TDD）
4. 双臂各 5 局冒烟 → 全量 134×2（控制臂 localhost 直连/8899 中继 → 实验臂 8789，顺序执行）→ SR 总体+6 类型、成本、失败分类；实验臂 session 归档

### P2：QwenClawBench（E3'，~半天-1 天，~$8+judge）
5. clone SKYLENAGE-AI/QwenClawBench（整仓 2.5MB）；`uv pip install pyyaml tqdm`；`docker pull ghcr.io/openclaw/openclaw:main`
6. openclaw.json 配 deepseek/agentserver 双 provider；`.env` 填 key + JUDGE_*（v4-pro）；task_00005（feishu）排除
7. 双臂各 3 任务冒烟（验证容器→8789 网络与 mount 权限；必要时 patch lib_docker.py --add-host）→ 全量 100×2（runs=1，concurrency 8，顺序双臂）
8. 产出：pass@1 双臂、hybrid 分明细、成本、失败分类；E3' 决策记录

### P3：Claw-Eval 文本子集（E4'，~1 天，~$8+judge）
9. clone claw-eval/claw-eval（**不用 pypi 包**）；`uv pip install -e ".[mock,sandbox,web]"`；sandbox 镜像构建冒烟（arm64 未验证，备选 --sandbox-tools 免 Docker）
10. 两份 config（控制/实验）+ judge=v4-pro；`--tag general` + multi_turn 子集（199 任务）双臂冒烟 5 任务 → 全量 199×2（trials=1）
11. 产出：Score/Pass 双臂、三维（completion/safety/robustness）明细、成本、失败分类；E4' 决策记录

### P4：飞轮实验 + 总报告（原 E4）
12. 实验臂第 1 轮（冷库）→ runDailyEvolution（DeepSeek teacher）→ 第 2 轮（热库）
13. 总报告（判据①②③全对照 + 三层证据）；INDEX/progress 收口；commit

## 风险与对策

| 风险 | 对策 |
|---|---|
| 8789 不透传 stop/超长上下文 | P1-3 预检；失真先修 agent-server（TDD） |
| QwenClawBench 容器→宿主网络/mount 权限 | 冒烟先行；--add-host 1 行 patch；网关 IP 备选 |
| Claw-Eval sandbox arm64 构建失败 | --sandbox-tools 免 Docker 模式 |
| judge 偏置 | v4-pro judge + 抽样人工核对 3-5 条 |
| 三个 benchmark token 量均"未验证" | 每个先小样本冒烟报价（<$1），用户确认后全量 |

## 成本/时间总览（双臂、各 1 trial/run）

| 阶段 | 成本 | 时间 |
|---|---|---|
| P1 ALFWorld 134×2 | $3-10 | ~1 天 |
| P2 QwenClawBench 100×2 | ~$8 + judge <$2 | ~半天-1 天 |
| P3 Claw-Eval 199×2 | ~$8 + judge <$3 | ~1 天 |
| P4 飞轮+报告 | < $5 | 数小时 |
| **合计** | **~$20-35** | **3-4 天** |
