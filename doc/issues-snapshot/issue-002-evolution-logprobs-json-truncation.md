# issue-002: 进化管线对中继链路健壮性不足（三连故障，草案）

- 状态：**draft（监控发现，非用户报告；验证与转正待用户决策）**
- 发现：2026-08-06 16:58 首败（r2）；r3/r4 连续暴露后续层（08-06 23:08 / 08-07 02:01）
- 修复：2026-08-06 ~ 08-07 三轮递进修复（见下）；回归测试**未写**（用户 08-06 决定：先草案，全部测试完成后提醒决策）
- 影响面：packages/agent-server — python/skill_evolution、python/verification_selection（离线进化管线）

## 故障链（同一根因的三种表现）

| 轮次 | 失败点 | 错误 |
|---|---|---|
| r2（16:58） | 打分调用 | `JSONDecodeError: line 2 column 7158598`——logprobs 响应 ~7MB 被截断，无重试 |
| r3（23:08） | 第三阶段整体 | 4h 管线超时——1,608 次打分调用（134 轨迹×3 标准×4 重复）单次 30-90s，总需 13-27h |
| r4（02:01） | 卡片提取 | `KeyError: 'choices'`——HTTP 200 但响应体无 choices（上游/中继瞬时异常另一形态） |

## 根因（实测定案）

1. **打分调用形态失控**（主因）：v4-flash 是 reasoning 模型，`_score_once` 未关 thinking、未封顶输出 → 长 CoT + 逐 token 20 个 logprobs → 单响应 7MB/30-90s。实测探针：关 thinking + max_tokens=512 后 **0.8s / 0.02MB / 标签完整**。
2. **客户端容错不足**（次因）：两个 llm_client 的 `_post` 只包装 HTTPError/URLError，JSON 截断与结构异常（缺 choices）均无重试，单次瞬时故障整轮报废。
3. **管线无断点**（放大器）：任意阶段失败即全量重跑（2-4h/次），ETL/打分/提取中间产物不落盘。

## 修复（三轮递进）

1. `llm_client._post`（双副本）：JSONDecodeError 3 次指数退避重试
2. `verifier._score_once`：打分调用注入 `thinking: {type: disabled}` + `max_tokens: 512`（实测提速 40-100 倍）
3. `llm_client._post`（双副本）：缺 choices 的结构异常并入重试，终败时携带响应体片段

Python 测试 29 全绿。进化 r5 于 08-07 02:10 重跑。

## 待办（到期提醒用户决策，触发时点：B 热库轮 + C campaign 报告交付后）

1. issue 转正并补回归测试（模拟截断/缺 choices 响应验证重试；模拟打分调用验证 thinking/max_tokens 注入）
2. 是否立项"管线分阶段断点持久化"（结构性改进，消除全量重跑放大器）
3. 或降级为已知风险 / 关闭
