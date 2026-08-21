# issue-017: verifier 打分对"模型偶发不遵循标签格式"零重试——进化批单次失败即整体中断

- 状态：**fixed（2026-08-21 用户裁决提前修复：temperature=0 + 提取失败重试 3 次 + 打分指纹含模型；测试 6 例先红后绿；python 95/eval 266/vitest 348 全绿）**
- 报告：2026-08-20（D1 夜间进化连续两次中断，主会话排查定位）
- 影响面：`packages/agent-server/python/verification_selection/verifier.py`（`_score_once`/`_extract_scores_from_text`）、`pipeline.py`（score_trajectories_with_checkpoint）；D 阶段每日夜间进化

## 现象

D1 夜间进化（runDailyEvolution）连续两次在打分阶段首调用即炸批：

```text
ScoreExtractionError: logprobs 不可用且文本中未找到 <score_A>/<score_B> 标签
```

两次失败的响应文本均为分析散文（v4-pro 一次 "## Analysis..."、v4-flash 一次 "A: The trajectory performs..."）——模型未按 "Reply with exactly one letter inside each tag" 输出，且 512 token 封顶内未出现标签，logprobs 通路同样无评分 token。

## 排查（逐项证伪后定位）

1. ~~模型选错~~：v4-pro/v4-flash 均可复现（探针两模型简单 prompt 都正确出标签）。
2. ~~prompt 长度/轨迹大小~~：30KB 真实轨迹 + 真实打分模板直接调用成功。
3. ~~确定性输入问题~~：用与失败任务（task_00024）完全相同的 `Verifier.score_pair`（G=20、DEFAULT_CRITERIA、REFERENCE_TRAJECTORY）复现——**成功（preference=0.702）**；连跑 5 次 5/5 通过。
4. **定位**：打分调用未设 temperature（DeepSeek 默认 1.0 采样），模型对格式指令的遵循是**随机的**；昨夜两次失败命中低概率不遵循样本，且 `_score_once` 对 ScoreExtractionError 零重试（llm_client 只重试网络层错误），单次不遵循即中断整个进化批。C 阶段 7 夜未命中纯属运气（或 API 行为随时间漂移）。

## 建议修法（延后处理时参考）

1. `_score_once` 的文本回退失败后**有限重试**（打分是幂等机械任务，重试 2-3 次带 jitter；issue-002 的管线韧性同款思路）；
2. 打分调用显式 `temperature=0`（机械任务本应确定性，降低不遵循率的根本修法——需先实测 v4-flash/v4-pro 在 temperature=0 下的分布质量无退化）；
3. 防回退测试：mock client 第一次返回散文、第二次返回标签，断言重试后成功；连续散文断言最终 fail loud（不静默给默认分）。

## 临时处置（已执行）

- `--resume var/offline/runs/2026-08-20T13-09-21-826Z` 断点重跑（T1 最小断点：ETL 产物复用，仅重跑失败打分），第三次启动已恢复运行（2026-08-20 21:47）。
- 教师模型口径校正：进化打分用 deepseek-v4-flash（C 验证口径；verifier 注释即针对 flash 调优），judge 维持 deepseek-v4-pro 不变（P-D6）。

## 回归测试

延后处理时按"建议修法 3"补；临时处置期若同一 run 重跑 ≥3 次仍炸，升级为 open 立即修。
