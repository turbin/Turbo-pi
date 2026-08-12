# issue-011: QCB 任务内嵌评分脚本崩溃杀死批次

- 状态：fixed
- 报告：2026-08-13 02:58（D5 监视器告警，监控发现）
- 修复：2026-08-13（commit 见 git log）
- 影响面：packages/agent-server eval — `campaign.py` 评分调用点（vendored QCB 评分代码为上游资产，不改）

## 现象

D5 完成 30/31 任务后整批崩溃：
`UnboundLocalError: cannot access local variable 'readme_content'`（任务内嵌 grade() 在 agent 未产出 README 时触发——上游 QCB 任务资产的评分脚本 bug）。

## 根因

`campaign.py` 主循环直接调用 `grade()`，vendored 评分代码经 `exec` 执行，其内部异常（上游任务脚本的防御性缺陷）无任何隔离即穿透到批次层。同类故障模式的第三例（issue-008 API 超时 / issue-009 工具超时 / 本次评分崩溃）——**批次层的局部异常隔离原则**。

## 修复

- 新增 `safe_grade()`：评分异常降级为 `grading_error` 行（score=0、grading_type=error、notes 带异常信息），批次继续
- 上游 QCB 评分脚本不动（vendored 资产；grading_error 行在报告中单独标注，不计入有效分数统计口径时需声明）

## 回归测试

`eval/tests/test_campaign.py::test_safe_grade_degrades_on_grader_crash`——monkeypatch 评分抛 UnboundLocalError，断言降级行结构正确。
