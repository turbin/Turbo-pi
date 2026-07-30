# A2：verifier 文本回退单测 —— 决策记录

日期：2026-07-22
关联任务书：`doc/design/2026-07-22-agent-server-a2-b3-tasks.md`

## 新增文件

- `python/tests/test_verifier_fallback.py`（pytest 风格，27 test cases）
- `python/tests/__init__.py`

## 改动文件

- `package.json`：新增 `test:python` script

## 测试覆盖

| 测试类 | case 数 | 覆盖内容 |
|---|---|---|
| `TestExtractScoresFromText` | 11 | 正常值/边界值/缺失/畸形标签/空文本/量程端点/字母超出刻度(ValueError) |
| `TestScorePairFallback` | 6 | 空 list 回退、dict 空 content 回退、dict None content 回退、logprobs 正常不触发回退、无标签 fallback 抛异常 |
| `TestExtractTagDistribution` | 7 | list 输入、dict 输入、缺失标签、标签在末尾、只有空白 token、空 dict content、无 content key |
| `TestExpectedFromTopLogprobs` | 4 | 非评分 token 过滤、多 token renormalize、无评分 token 抛异常、重复 token 取 max prob |
| **合计** | **27** | |

## 设计决策

1. **`test_letter_beyond_scale_raises_valueerror`**：LLM 返回超出 G 档字母（如 G=5 时返回 F）触发 `ValueError`（非 `ScoreExtractionError`）。这是预存行为，已在测试中固化并在注释中记录，未改动实现。
2. **Python 测试不在根 CI 中运行**：`test:python` script 已添加但 CI 只跑 vitest。根 `npm run check`（tsgo --noEmit）不涉及 Python。
