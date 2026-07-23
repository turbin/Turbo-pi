# N1：FTS tokenizer 修正 — 变更记录与决策

日期：2026-07-23
任务书：` design/2026-07-23-agent-server-post-c-tasks.md` N1 节
进度：` design/progress/2026-07-23-post-c-operations.md`

---

## 背景

C3 follow-up（决策 4）发现 `tokenizeForFts`（`src/experience-store.ts:69-83`）对非 CJK 字符也逐字拆开写入 `search_text`，导致 FTS5 词查询对拉丁正文永不命中。词查询实际只命中 `title` 列（INSERT 时 title 从 experiences 原样 SELECT 未经 tokenizer）。实证：`MATCH 'jitter'`（仅正文）0 命中，`MATCH 'flaky'`（title 内）命中。

## 变更内容

### 决策 1：重写 tokenizeForFts（拉丁整词 + CJK char/bigram）

**改前**：所有非 CJK 字符逐个拆为单字 token（`"backoff"` → `"b a c k o f f"`）。

**改后**：与 `src/retrieval.ts` 的 `tokenize()` 对齐——拉丁/数字连续段（`[a-zA-Z0-9]+`）保留为整词 token（小写化），CJK 维持单字 + 相邻 bigram，空白/标点为天然分段。函数从模块私有改为 `export`（供单测和 rebuild CLI 使用）。

**理由**：索引侧（tokenizeForFts）与查询侧（retrieval.ts buildFtsQuery + tokenize）分词口径必须一致，否则查询侧生成整词 token 而索引侧只有单字 token，MATCH 永不命中。

### 决策 2：FTS 重建使用 DROP + CREATE 而非 DELETE

`experiences_fts` 是外部内容 FTS5 表（`content=experiences, content_rowid=rowid`），而 `experiences` 表没有 `search_text` 列。`DELETE FROM experiences_fts` 会触发 FTS5 从 content 表读取旧值用于索引删除，导致 `no such column: T.search_text` 错误。同理 `SELECT COUNT(*) FROM experiences_fts` 也会失败。

**方案**：重建时 `DROP TABLE IF EXISTS experiences_fts` → `CREATE VIRTUAL TABLE`（同 schema）→ 全量重插。测试中计数使用内部表 `experiences_fts_docsize`。

### 决策 3：不自动迁移

server 启动、run-evolution 均不自动重建 FTS。重建是手动一次性动作（`npx tsx src/offline/rebuild-fts.ts`），需要时由用户或运维执行。

**理由**：重建涉及 DROP TABLE，在请求路径上自动执行风险过高；且只需跑一次。

### 决策 4：rebuild-fts CLI 设计

- 路径：`src/offline/rebuild-fts.ts`，风格对齐 `schedule.ts` 的 CLI dispatch。
- 参数：`--dry-run`（只打印将重建的行数，以 readonly 模式打开 DB，不写入）。
- 环境变量：`EXPERIENCE_STORE_PATH`（默认 `./var/experience.db`）。
- 红线：dry-run 之外只动 EXPERIENCE_STORE_PATH 指向的库文件，不碰其他任何状态。
- 事务化：DROP + CREATE + 全量 INSERT 在单个 SQLite 事务内完成。
- 幂等：多次运行结果一致（每次 DROP 重建）。

## TDD 用例覆盖（10 条全绿）

| # | 用例 | 文件 |
|---|---|---|
| 1 | EVIDENCE 正文词 idempotent 可检索 | experience-store.test.ts |
| 2 | ABILITY 正文词 backoff/jitter 各自可检索 | experience-store.test.ts |
| 3 | CJK 正文"量子"可检索（不回归） | experience-store.test.ts |
| 4 | 混合正文 backoff/flaky/策略 均可检索 | experience-store.test.ts |
| 5a/5b/5c | payload.text 缺失/空/纯标点不抛异常 | experience-store.test.ts |
| 6 | tokenizeForFts 拉丁整词（连字符分段） | experience-store.test.ts |
| 7 | tokenizeForFts CJK char+bigram | experience-store.test.ts |
| 8 | rebuild 旧格式→词查询命中+行数一致 | rebuild-fts.test.ts |
| 9 | rebuild 幂等 | rebuild-fts.test.ts |
| 10 | --dry-run 不写 | rebuild-fts.test.ts |

## Live sanity

- 备份：`var/experience.db.n1-pre-rebuild-backup`
- 重建前：`MATCH '"jitter"'` → 0 命中
- 重建后（29 行）：`MATCH '"jitter"'` → 2 命中（含自然 Method card "Bounded Exponential-Backoff Retry for Flaky APIs"）

## 测试统计

- 基线：20 文件 / 213 测试
- 新增：+1 文件（rebuild-fts.test.ts）/ +12 测试（experience-store 9 + rebuild-fts 3）
- 合计：21 文件 / 225 测试全绿
- `npm run check` 干净
