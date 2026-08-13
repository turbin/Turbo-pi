# doc/research/papers

论文中文翻译存档目录。所有 paper 内容统一存放于此（2026-08-11 起，由仓库根目录 research/papers 合并迁入）。

## 工作流程（约定）

1. **获取**：通过 zotero-mcp（MCP 服务 `zotero`，本地 API 模式）搜索论文、获取附件路径；Zotero 索引全文常被截断，需用 pypdf 从附件 PDF 提取完整全文。
2. **翻译**：主会话用 `pi_dispatch` 派发多个 pi 子任务，每个负责一个章节块（按节边界切分，每块 ≤40K 英文字符），翻译结果写入 `/tmp/zh_part_N.md`。
3. **汇总**：主会话校验各块接缝（截断句续接、标题层级），合并为单个 Markdown 存入本目录。
4. **规范**：
   - 文件名：`<paper-slug>.zh.md`
   - 文件头注明原文标题、作者、arXiv/DOI、Zotero Item Key、翻译说明
   - 正文完整翻译，标题中英对照，核心术语首现中英对照
   - 公式、算法伪代码、文献引用标记保留原文
   - 表格重建为 Markdown 表格；图内文字碎片按语义还原为图注
   - 参考文献保留英文原文
   - HTML 输出：每篇论文一个 `<paper-slug>/` 目录，含 `index.html` 与 `images/`；位图直接从 PDF 提取，矢量图用 pymupdf 按页面区域高清渲染；图表以 <figure>/<table> 标签保留原格式

## 存档

| 文件 | 原文 | 日期 |
|---|---|---|
| self-improvements-in-modern-agentic-systems-survey.zh.md | Self-Improvements in Modern Agentic Systems: A Survey (arXiv:2607.13104) | 2026-08-11 |
| self-evolving-ai-agents-survey.zh.md | A Comprehensive Survey of Self-Evolving AI Agents (arXiv:2508.07407) | 2026-08-11 |
| sia-self-improving-ai/ (index.html + images/) | SIA: Self Improving AI with Harness & Weight Updates (arXiv:2605.27276) | 2026-08-11 |
