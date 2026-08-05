# issue-001: Web 页面命中率显示 NaN%

- 状态：fixed
- 报告：2026-08-05（用户在 `/dashboard` 页面看到"总请求 6231，命中 6231，命中率 NaN%"）
- 修复：2026-08-05（本仓库工作区，commit 见 git log）
- 影响面：packages/agent-server — `/stats` 与 `/dashboard` 两个静态页

## 现象

dashboard 命中率面板显示"命中率 NaN%"，`/stats` 页的命中率与"按经验类型"表同样坏（类型表为空）。
总请求/命中计数正常。

## 根因

前端页面 JS 读取 `d.hit_rate` / `d.by_kind`（snake_case），而 `/api/stats/hit-rate`
的响应字段是 camelCase（`hitRate` / `byKind`，experience-store.ts `getHitRateStats`）。
取值 undefined → `(undefined*100).toFixed(1)` = "NaN%"，`undefined.map` 抛错导致类型表不渲染。
`/stats` 页是同样问题的存量携带者——上线时未实机核对字段名。

## 修复

- `src/stats-page.ts`：`d.hit_rate`→`d.hitRate`、`d.by_kind`→`d.byKind`
- `src/dashboard-page.ts`：`d.hit_rate`→`d.hitRate`
- API 不动（camelCase 是既有契约，recent 行本就是 camelCase 别名）

## 回归测试

`packages/agent-server/test/regressions/issue-001-hit-rate-nan.test.ts`：

1. API 契约：注入一条命中 trace 后断言 `hitRate` 为 number 且 `byKind` 数组结构正确；
2. 页面契约：两个页面 HTML 必须引用 `d.hitRate` 且不得再出现 `d.hit_rate` / `d.by_kind`。
