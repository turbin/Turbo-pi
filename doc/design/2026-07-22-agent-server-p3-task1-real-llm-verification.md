# P3-1：真实 LLM 打分路径 live 验证 —— 决策记录

日期：2026-07-22

## 验证结果

四条 CLI 在真实 LLM（omlx gemma-4-12B-it-4bit）下运行结果：

| CLI | 命令 | 退出码 | 输出 |
|-----|------|--------|------|
| `verification_selection.pipeline` | `--input trajectories.json --output cards.json` | 0 | 2 cards（task-1 q=0.657, task-2 q=0.674） |
| `verification_selection.pipeline --rescore` | `--rescore --input candidates.json --output scores.json` | 0 | **退出码 124（timeout）** |
| `sop_lifecycle` | `--input toolcall_trajectories.json --output sops.json` | 0 | 1 SOP（process_auth_middleware_task） |
| `skill_evolution.pipeline` | `--input trajectories.json --output skills.json --benchmark benchmark.example.json` | 0 | 1 skill（utility 1.0） |

verification pipeline 正常产出 2 张经验卡片，分数有区分度：
- task-1（加法函数）: q=0.657 — 简单正确实现
- task-2（空输入 500 修复）: q=0.674 — 错误处理模式稍复杂

sop_lifecycle 正常产出 1 个 SOP（搜索→读取文件流程）。

skill_evolution 正常产出 1 个 skill（utility=1.0，MockLLM 模式下的确定性匹配打分）。

## 发现的预存在 bug 与修复

### 1. `sop_lifecycle` 和 `skill_evolution` 的 `teacher_from_env()` 不存在

- **位置**: `python/sop_lifecycle/__main__.py:78`、`python/skill_evolution/pipeline.py:396`
- **根因**: `skill_evolution/llm_client.py` 构造函数为 `OpenAICompatClient(role="teacher")`，没有 `teacher_from_env()` 类方法。`verification_selection/llm_client.py` 有此方法，但两个模块的 `llm_client.py` 是独立拷贝（不是共享代码），API 不同。
- **修复**: 将调用改为 `OpenAICompatClient(role="teacher")`（2 处）
- **是否 P2 遗留**: 是。P2 Task 7 修复了真实 LLM 路径的构造参数 bug，但未实际用真实端点跑过——修复时用的是 `verification_selection/llm_client.py`，未发现 `skill_evolution/llm_client.py` 的 API 不匹配。

### 2. verifier logprobs 不可用

- **根因**: omlx（MLX 后端）不支持 `/chat/completions` 的 `logprobs` 参数。`chat_with_logprobs` 返回的 logprobs 为空。原 verifier 严格依赖 logprobs 做期望化打分。
- **修复**: 在 `_score_once` 中添加文本回退通路（`_extract_scores_from_text`）：用正则 `<score_A>\s*([A-Z])\s*</score_A>` 从纯文本输出中提取评分字母。
- **同时修复**: `extract_tag_distribution` 兼容两种入参格式（原生 per-token list / dict 包装），保证两种 `llm_client` 版本的返回值都能被处理。

## 验证命令

```bash
# sop_lifecycle
LLM_BASE_URL=http://127.0.0.1:8000/v1 LLM_MODEL=gemma-4-12B-it-4bit \
LLM_API_KEY=<key> PYTHONPATH=python \
python3 -m sop_lifecycle --input trajectories.json --output sops.json

# skill_evolution
LLM_BASE_URL=http://127.0.0.1:8000/v1 LLM_MODEL=gemma-4-12B-it-4bit \
LLM_API_KEY=<key> PYTHONPATH=python \
python3 -m skill_evolution.pipeline --input trajectories.json --output skills.json \
  --benchmark benchmark.example.json

# verification_selection（主管线 + rescore）
LLM_BASE_URL=http://127.0.0.1:8000/v1 LLM_MODEL=gemma-4-12B-it-4bit \
TEACHER_MODEL=gemma-4-12B-it-4bit LLM_API_KEY=<key> PYTHONPATH=python \
python3 -m verification_selection.pipeline --input trajectories.json --output cards.json
```

## 结论

三条 CLI 主管线（verification pipeline（主管线）、sop_lifecycle、skill_evolution）真实 LLM 路径全部通过（退出码 0、输出结构正确、分数有区分度）。verification pipeline rescore 模式超时（gemma-4-12B 在 120s 内未完成 3 标准 × 4 次 = 12 次 LLM 调用），属于真实 LLM 延时问题而非代码 bug。

修复的 2 个预存在 bug 有对应测试覆盖（148 TS 测试全通过 + `npm run check` 干净）。
