# 经验库 schema 演化方案：溯源三字段（scaffoldHash / supersedesId / verification）

- 日期：2026-08-11
- 状态：**待用户评审**；实施时间根据实验完成情况另行安排（本方案不含排期承诺）
- 上游依据：
  - SIA 论文（arXiv:2605.27276）符号表（§3.4）与译文对比分析（2026-08-11 会话）
  - 姊妹方案（机制层）：`plans/2026-08-11-self-improve-skill-plan.md`（self-improve 回路；其 S2 的 scaffoldHash 与 stale 复核依赖本方案 T2/T3）
  - `plans/2026-07-31-agent-self-evolution-roadmap.md`（已批准路线图，本方案对齐 R1 入库验证 / R3 harness 自进化）
  - 通用约束：`doc/design/2026-07-22-agent-server-p3-candidate-tasks.md`"通用约束"一节（工程内改动、omlx 不可动、提交格式、git 纪律）

---

## 1. 背景与动机

SIA 论文把"经验的有效性条件"显式建模为符号：`A_g`（产生经验时的支架版本）、`g`（世代谱系）、`V`/`E_g`（验证器与评分证据）。对照 agent-server 当前入库结构（`src/types.ts` `Experience`）：

```typescript
{ id, type, title, payload, quality, status, sourceSession, sourceEntryId, contentHash, createdAt }
```

缺三层信息：

1. **支架指纹缺失**——自我改进回路（讨论中的 self-improve skill/extension）会改动 skills/extensions；支架一变，历史经验可能失效，但目前无法识别哪些经验是在旧支架下产出的。
2. **谱系缺失**——经验演化（新经验取代旧经验）无记录，只有 contentHash 去重，库里是"静态卡片堆"而非可演化谱系。
3. **评分不可审计**——`quality` 是黑盒标量，不知道由哪个 verifier/judge、基于什么证据、何时打出；防古德哈特（SIA §8 教训）需要可审计。

本方案为 `Experience` 增加三个溯源字段，全部可空、向后兼容。

## 2. 现状代码事实（勘察结论）

- 类型定义：`packages/agent-server/src/types.ts:28-39`（`Experience`）。
- 建表：`src/experience-store.ts:154-205` `initSchema()`，`CREATE TABLE IF NOT EXISTS`，**无迁移机制**。
- **已有的 schema/type 漂移**：DB 表含 `branch_path`、`times_selected` 两列（experience-store.ts:163-164），但 `ExperienceRow`/`Experience` 类型均未声明，全仓仅 experience-store.ts 自身引用——属历史遗留死列，本方案不处理也不扩大漂移（新字段必须类型、行映射、SQL 三处同步）。
- 写入路径：
  - `src/offline/etl.ts:48-66`：session JSONL → `store.insert()`（sourceSession/sourceEntryId 在此产生）。
  - `src/offline/verifier.ts:60-90` `promoteQualifying()`：质量分 ≥ `PROMOTION_THRESHOLD`(0.5) 才 insert/晋升，contentHash 去重，同事务。
- 读取路径：`src/retrieval.ts`（FTS bm25 + 余弦重排）、`listActive`/`search`（M10 快照只读库，快照为文件级拷贝——新列随文件拷贝自动传播，快照机制无需改动）。
- 测试：`test/experience-store.test.ts`、`test/offline/verifier.test.ts`、`test/offline/etl.test.ts` 等；运行需 Node 25.9.0（`scripts/with-node25.sh`，见根 AGENTS.md）。

## 3. 变更设计

### 3.1 类型层（`src/types.ts`）

```typescript
export interface ExperienceVerification {
  /** 打分者标识：judge 模型名 / 规则名 / "human"。 */
  verifier: string;
  /** 评分时间 ISO。 */
  at: string;
  /** 原始分（未经阈值处理），可选。 */
  rawScore?: number;
}

export interface Experience {
  // ……现有字段不变……
  /** 对应 SIA A_g：产生此经验时的支架指纹；历史数据为 null（未知）。
      支架被 self-improve 改动后，可据此批量复核旧经验。 */
  scaffoldHash?: string | null;
  /** 对应 SIA 世代 g：本经验演化自哪条（取代关系），可选。 */
  supersedesId?: string | null;
  /** 对应 SIA V/E_g：quality 的可审计来源。 */
  verification?: ExperienceVerification | null;
}
```

### 3.2 存储层（`src/experience-store.ts`）

新表结构加三列（全部 `TEXT`，可空）：

```sql
scaffold_hash TEXT,
supersedes_id TEXT REFERENCES experiences(id),
verification TEXT  -- JSON 序列化的 ExperienceVerification
```

**迁移策略（新增，当前无迁移机制）**：`initSchema()` 在建表后执行列存在性检查（`PRAGMA table_info(experiences)`），缺列则 `ALTER TABLE ... ADD COLUMN`。纯增量、可空、无默认值回填——对存量库安全，对全新库幂等。同时在 `ExperienceRow` 与 `rowToExperience()` 补全三列映射（含 `branch_path`、`times_selected` 的类型声明一并补齐，消除现有漂移，但**不改变**两死列的任何行为）。

`insert()` 扩展三字段写入；FTS 不受影响（新列不入索引）。

### 3.3 支架指纹计算（新文件 `src/scaffold-hash.ts`）

```typescript
export function computeScaffoldHash(dirs: string[]): string
```

- 输入：支架目录列表（`.pi/extensions/`、`.pi/skills/`、`.pi/prompts/`、settings 文件），来源 env `AGENT_SERVER_SCAFFOLD_DIRS`（冒号分隔），默认 `~/.pi/agent`。
- 算法：遍历目录下文件（排除 `.git`、`node_modules`），对 `(相对路径 + 内容)` 排序后 sha256；单文件超 1MB 或总数超 2000 个时降级为 `(路径+大小+mtime)` 哈希并在返回值上无法区分——因此改为直接抛错，宁缺毋滥（指纹必须可靠，不可静默降级）。
- 同内容必须同 hash（跨机器/跨时间稳定），不混入绝对路径、时间戳。

### 3.4 生产者接线

| 写入点 | 改动 |
|---|---|
| `offline/verifier.ts` `promoteQualifying()` | insert/晋升时写入 `scaffoldHash = computeScaffoldHash()`（env 未配置目录时为 null），`verification = { verifier: <teacher 模型名>, at, rawScore: item.quality }`；候选对象新增可选 `supersedesId`（由 pipeline 在判定"演化取代"时填入，v1 阶段 pipeline 不判，恒 null） |
| `offline/etl.ts` | insert 时同样写入 `scaffoldHash`；`verification` 为 null（ETL 不评分） |

### 3.5 消费者接线（v1 最小集）

- `experience-store.ts` 新增方法：
  ```typescript
  /** 支架变更后复核入口：把 scaffoldHash 与 currentHash 不同的 active 经验降为 dormant，
      交给 verifier 既有 rescore 流程重新评分。返回降级条数。 */
  async markStaleByScaffoldHash(currentHash: string): Promise<number>
  ```
- **检索/注入不改**：`search`/`listActive`/`injection.ts` 对新字段无感知（v1 不做按支架过滤，避免检索行为变化污染正在进行的 A/B 实验）。
- `weekly-report.ts`：报告增加一行"当前支架指纹 + stale 条数"（只读展示）。

### 3.6 测试

- `test/experience-store.test.ts` 增补：
  - 迁移：用旧 schema 预建库 → `initSchema()` → 三列出现、旧行可读、新字段为 null；
  - 新字段 insert/getById/search 往返一致；
  - `markStaleByScaffoldHash`：混合 hash 的 active 行只降不匹配者，幂等（二次调用返回 0）。
- `test/scaffold-hash.test.ts`（新）：同内容同 hash、改一字节 hash 变、超限抛错。
- `test/offline/verifier.test.ts`：晋升行携带 scaffoldHash/verification。
- 运行方式：`scripts/with-node25.sh node ../../node_modules/vitest/dist/cli.js --run <file>`（包根目录下），全量 `./test.sh` 门控。

## 4. 不做的事（范围护栏）

- 不引入 SIA 的 RL 符号（π_θ、s、a、G 等）——无权重更新，映射即噪音。
- 不加结构化任务字段 `U`——检索全文索引已覆盖，边际收益低，以后需要再说。
- 不改 `branch_path`/`times_selected` 行为（仅补类型声明）。
- 不改检索/注入行为（v1），不影响进行中的实验臂。
- 不动 omlx、不动 Python gateway 包。

## 5. 分阶段交付（每阶段独立可交付、可回滚）

| 阶段 | 内容 | 依赖 |
|---|---|---|
| T1 | 类型 + 存储层迁移 + 迁移/往返测试（3.1、3.2、3.6 前两项） | 无 |
| T2 | scaffold-hash 工具 + 生产者接线（3.3、3.4）+ 对应测试 | T1 |
| T3 | `markStaleByScaffoldHash` + weekly-report 展示（3.5）+ 测试 | T2 |

**排期说明**：按用户指示，具体实施时间在实验完成情况明确后安排；T1 对实验零影响（纯增量可空字段），如需先行也不干扰在跑实验臂。

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 迁移破坏存量库 | 纯 `ADD COLUMN` 可空增量 + 迁移测试用旧 schema 预建库验证；改前备份库文件 |
| scaffoldHash 计算不可靠（静默降级导致误杀经验） | 超限直接抛错，不降级；hash 不含机器相关量 |
| 新字段污染检索/实验 | v1 检索注入零改动；`markStaleByScaffoldHash` 只被 self-improve 回路显式调用，不自动触发 |
| 与 roadmap R3 的人工审批门冲突 | 本方案只提供数据层能力；stale 复核的触发时机由 R3 的审批门决定，不在本方案内自动化 |
