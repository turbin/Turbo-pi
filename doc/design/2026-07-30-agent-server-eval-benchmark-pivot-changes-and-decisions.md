# Agent-Server E 里程碑改道：benchmark 替换为 ALFWorld + QwenClawBench + Claw-Eval——变更与决策记录

日期：2026-07-30
SPEC：`doc/design/2026-07-24-agent-server-eval-benchmark-tasks.md`（E 总任务书，本记录修订其 E2/E3）
进度：`doc/design/progress/2026-07-24-eval-benchmark.md`
状态：**已立项（用户 07-30 两次拍板定案）**

---

## 1. 决策记录

| # | 决策 | 理由 |
|---|---|---|
| P-D1 | **Terminal-Bench 弃用**（E2.3 全量中止，控制臂 8 trial/2 resolved 数据归档保留于 `eval/results/tb-full-20260729/`） | 用户拍板：案例替换。TB 环境攻坚成果（wheelhouse/中继/正向代理/测试注入）作为基础设施保留——中继与正向代理被新 benchmark 复用 |
| P-D2 | **SWE-bench 弃用**（先改 WebArena 后用户再改为去除） | 用户两轮反馈：WebArena 去掉→SWE-bench 也去掉。x86_64 评分镜像 + Rosetta 成本/复杂度是固有负担 |
| P-D3 | **E2'=ALFWorld**（valid_unseen 134 局，自写 ReAct loop ~150 行） | 纯文本、无 Docker、确定性评分（info['won']）、论文标准协议、成本低（$3-10 双臂）；官方无 LLM agent，ReAct notebook 是事实标准 |
| P-D4 | **E3'=QwenClawBench**（100 任务，OpenClaw harness，hybrid 评分） | 真实用户任务分布、arm64 镜像已确认、hybrid（automated+judge）评分比纯 judge 稳；repo 仅 2.5MB、断点续跑/anomaly 机制成熟 |
| P-D5 | **E4'=Claw-Eval 文本子集**（general 161 + multi_turn 38 = 199/300） | 300 任务中 101 个多模态需视觉模型（v4-flash 纯文本）；官方 harness host 侧跑 agent loop，localhost:8789 零网络阻抗；**严禁装 pypi 的 claw-eval（抢注包，是另一个项目）**，用官方 repo `pip install -e .` |
| P-D6 | **agent=v4-flash，judge=deepseek-v4-pro** | QwenClawBench hybrid 惩罚式评分（auto<0.75 时 judge 归零）对 judge 质量敏感；v4-pro judge 成本仍 <$5；judge 口径在报告中声明（判据③） |
| P-D7 | 臂切换全部走端点配置，零代码：ALFWorld/Claw-Eval 用 `http://localhost:8789/v1`（host 侧），QwenClawBench 用 `http://host.docker.internal:8789/v1`（容器内，备选 --add-host patch） | 三个 harness 的 LLM 调用位置已调研核实（命令级证据） |
| P-D8 | 每个 benchmark 先小样本冒烟报价（<$1），再全量 | 三个 benchmark 的 token 量均无公开数据（调研标注"未验证"）；E2.2 教训：先报价后全量 |

## 2. 不变量（沿用 E 总任务书）

成功判据 3 条（实验≥对照 / 轮2>轮1 / 成本与错误分布同报）、评估实例 8789（`HOST=0.0.0.0`）、防泄漏归档纪律（实验臂每轮跑完即归档 session）、8899 中继 + 8898 正向代理基础设施、飞轮实验与总报告框架（07-25 设计文档）。

## 3. 实施路线（对应 progress 状态表）

| 阶段 | 内容 | 预估成本 | 时间 |
|---|---|---|---|
| P1 | ALFWorld：环境（textworld==1.6.2rc5 arm64 wheel + jericho 编译）→ ReAct agent → 8789 stop 透传预检 → 冒烟 5 局 → 全量 134×2 | $3-10 | ~1 天 |
| P2 | QwenClawBench：openclaw.json 双 provider → 双臂冒烟 3 任务 → 全量 100×2（task_00005 feishu 排除） | ~$8+judge | ~1 天 |
| P3 | Claw-Eval：repo editable install + sandbox 冒烟 → 双臂冒烟 5 任务 → 文本子集 199×2 | ~$8+judge | ~1 天 |
| P4 | 飞轮实验（冷库→evolution→热库）+ 总报告（判据①②③）+ 收口 | <$5 | 数小时 |

## 4. 调研证据要点（详见调研记录，缓存 /tmp/bench-research/）

- ALFWorld：`alfworld==0.4.2 --no-deps` + `textworld==1.6.2rc5`（唯一 cp312 macosx_arm64 wheel）；jericho 3.3.x 源码编译需 Xcode CLT；`alfworld-download` 可跳过 mrcnn（178MB）；游戏顺序 `os.walk` 未排序——需 patch 固定保证双臂逐局对齐。
- QwenClawBench：openclaw.json `models.providers` 任意加 OpenAI 兼容 provider；judge 走 `JUDGE_BASE_URL` 环境变量；`ghcr.io/openclaw/openclaw:main` arm64+amd64 manifest 已核实；容器→宿主网络与 bind mount 权限为未验证项，冒烟先行。
- Claw-Eval：config YAML `model:`/`judge:` 独立 base_url；`--tag general` 子集跑法；sandbox 镜像 arm64 构建未验证，备选 `--sandbox-tools` 免 Docker；stop 参数为标准 openai client 透传无冲突。

Refer Spec：`doc/design/2026-07-24-agent-server-eval-benchmark-tasks.md`（E 总任务书）；`doc/design/2026-07-25-agent-server-eval-report-design.md`（E4 报告设计）；`doc/design/2026-07-28-agent-server-e2-wheelhouse-relay-changes-and-decisions.md`（被复用的基础设施决策）
