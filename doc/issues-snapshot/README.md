# issues-snapshot — 用户报告问题登记与回归跟踪

登记**用户报告的错误/异常**（区别于设计文档记录的技术决策）。每个 issue 一个文件，
配套一个回归测试；**每次新版本推送前必须跑一遍回归测试验证已知问题不复发**。

## 流程

1. **登记**：用户报告问题 → 新建 `issue-NNN-<slug>.md`（NNN 三位递增），模板见下；
   同时在 `index.md` 加一行（状态：open）。
2. **回归测试**：为 issue 写测试，放在对应包的 `test/regressions/issue-NNN-<slug>.test.ts`
   （agent-server；其他包类推，coding-agent 沿用 `test/suite/regressions/`）。
   测试必须先在修复前复现失败（red），修复后转绿。
3. **修复**：最小改动；issue 文件更新根因与修复 commit，index 状态改 fixed。
4. **推送前门控**：`./test.sh`（含各包 regressions）全绿才允许推送新版本；
   issue 修复后永不删除测试——它是该问题的永久哨兵。
5. **关闭**：修复经一个发布周期验证无复发 → 状态改 closed（文件与测试保留，可追溯）。

## issue 文件模板

```markdown
# issue-NNN: <标题>

- 状态：open | fixed | closed
- 报告：YYYY-MM-DD（用户报告/监控发现）
- 修复：YYYY-MM-DD commit <hash>（fixed 后填）
- 影响面：<包/端点/页面>

## 现象
<用户看到的原始症状，原样记录>

## 根因
<确诊后的原因>

## 修复
<改动点>

## 回归测试
<测试文件路径 + 覆盖点>
```
