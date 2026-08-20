# D2/D7 交叉日 runbook（四臂 + 快照锁 + Kimi audit）

日期：2026-08-19 ｜ 状态：生效中（配合 preview.html §10-§13 与前置清单 H 节使用）

## 1. 交叉日前置（D1 夜间 / D6 夜间）

1. 当日 evolution 完成 → **取库快照两份**：
   - `frozen` = D1-post 快照（仅 D2 前取一次，D7 复用同一 frozen，锁库不换载）
   - `current` = 当日 evolution 后热库快照（四臂起跑前取，§12.1 snapshot lock）
2. 启动冻结实例：`EXPERIENCE_STORE_PATH=<frozen 副本> PORT=8791`（示例），`/api/status/chain` 验证指纹（H1）。
3. 前置核验清单 A-H 全过（特别是 H1-H6）。

## 2. 四臂跑批（逻辑实验日，≈25h，不等价自然日）

```bash
cd packages/agent-server/eval
set -a; eval "$(grep -E '^(DEEPSEEK_|LANGFUSE_)' ../.env | sed 's/^/export /')"; set +a
export JUDGE_BASE_URL="http://127.0.0.1:8899/v1" JUDGE_API_KEY="$DEEPSEEK_API_KEY"
export NO_PROXY="127.0.0.1,localhost" AGENT_EVAL_EXPECTED_OMLX_MODEL="Qwen3.5-9B-4bit"
./.venv/bin/python -u campaign.py --day 2 --arms x1,x2,x3,x4 \
  --frozen-base-url http://127.0.0.1:8791/v1 --dry-run   # 先核批次（H3/H4）
nohup ./.venv/bin/python -u campaign.py --day 2 --arms x1,x2,x3,x4 \
  --frozen-base-url http://127.0.0.1:8791/v1 > /tmp/campaign-9b-d2.log 2>&1 &
```

- 臂序已按 §12.2 task-block 确定性随机（T1 落地）；断点续跑键 (day,arm,task_id)。
- **四臂全部完成前禁止**：hot-library swap、当日 evolution、改 frozen 实例（§12.1）。

## 3. 对账与进化（交叉日收尾）

1. `--metrics results/<run>/run.jsonl`：判据 + addendum 三指标 + cross 差分（X2−X1 库演进 / X1−X4 即时注入 / X3−X4 sanity + transfer_gain）。
   - **D2 预期**：X2−X1 ≈ 0、X3−X4 ≈ 0（零差校准，preview §4.4）；sanity 超 0.05 → 停批查混淆。
   - **D7**：X2−X1 为真实库演进效应；同时报 DiD 与 paired distribution。
2. 对账通过后才进化（§12.1）：`synthesize_campaign_sessions.py --input-dir ... --output-dir ...`（默认 `--eligible-arms experiment,x2`，held-out 自动排除，H5）→ runDailyEvolution → 次日热库 → snapshot_store。
3. `trajectory_metrics.py results/<run_id>` 出轨迹指标族（§8.2/§17.3，随日报呈现）。

## 4. Kimi audit（Teacher/Judge 同源稳健性，preview §13；用户 08-19 拍板用 Kimi）

- **时机**：D2 与 D7 各一次。
- **抽样**：从当日重复集已完成任务中确定性抽 6 个（sha256(run_id+day) 排序取前 6，执行时记录抽样键）。
- **方法**：同一批 transcript 用 `_call_llm_judge_api` 换 Kimi（base_url/key/model 走 gateway `[cloud.kimi]` 段临时启用或直连 Kimi API）重判；judge 提示词与主 judge 相同（vendored lib_grading 同一 rubric）。
- **一致性判定（预注册）**：① 逐任务 |score_kimi − score_deepseek| ≤ 0.2 的占比 ≥ 2/3；② 任务排序方向一致（高低分组不翻转）。两条不满足 → 结论方向标"判分敏感"，主结论降级为探索性。
- **纪律**：audit 分数只进稳健性章节，不回写 run.jsonl、不进判据、不替代主 judge。

## 5. 异常处置

| 异常 | 动作 |
|---|---|
| sanity 差超容差（D2 校准失败） | 停批，报用户；按 preview §20 P0 风险查混淆源 |
| 冻结实例挂掉/库被换载 | 当日四臂数据作废，修复后重跑该逻辑日（run.jsonl 保留断点） |
| Kimi audit 不可用（配额/故障） | 登记延期，不阻塞主批；audit 缺口在最终报告声明 |

- **D 阶段 run-evolution 启动 env 增补（2026-08-20 实战教训）**：`AGENT_SERVER_PIPELINE_TIMEOUT_MS=900000` 必设（N2 既有裁决：DeepSeek reasoning 模型单评分 30-60s，缺省 300s 子进程超时必 SIGTERM；source `packages/agent-server/.env` 的部署不包含此变量，手动启动必须显式加）；`LLM_MODEL/TEACHER_MODEL=deepseek-v4-flash`（打分口径，勿误设 v4-pro——judge 才是 v4-pro）。

Refer Spec：doc/design/preview.html（§4.4/§7/§10-§13）；doc/design/2026-08-19-run-batch-preflight-checklist.md（H 节）；plans/2026-08-19-d-stage-addendum-dev-tasks.md（裁决登记）
