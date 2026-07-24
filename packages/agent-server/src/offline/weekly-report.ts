import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";

/**
 * Weekly observation report (observation runbook, N3 follow-up): dump the
 * fixed SQL set from ` design/2026-07-23-agent-server-observation-runbook.md`
 * plus the trigger-review evaluations, as a markdown report.
 *
 * Usage (from packages/agent-server):
 *   npx tsx src/offline/weekly-report.ts            # one-shot report
 *   npx tsx src/offline/weekly-report.ts --loop     # sidecar loop mode
 *
 * Config via env:
 *   EXPERIENCE_STORE_PATH               → experience.db path (default ./var/experience.db)
 *   AGENT_SERVER_REPORT_INTERVAL_HOURS  → loop sleep (default 168 = 7 days)
 *
 * Reports are written to <storeDir>/reports/weekly-<YYYY-MM-DD>.md and echoed
 * to stdout (visible in `docker compose logs`). The report is descriptive; the
 * interpretation/judgment stays with the reviewing human or agent.
 */

const DEFAULT_INTERVAL_HOURS = 168;
const C_HEAVY_WINDOW_DAYS = 28;
const TRUNCATION_STOCK_LIMIT = 6;
const DORMANT_BACKLOG_LIMIT = 100;

interface CountRow {
	type: string;
	role: string | null;
	status: string;
	cnt: number;
}

interface BucketRow {
	bucket: string | null;
	cnt: number;
}

function qualityBuckets(db: Database.Database, type: string): BucketRow[] {
	return db
		.prepare(
			`SELECT CASE WHEN quality>=0.5 AND quality<0.6 THEN '0.5-0.6'
			       WHEN quality>=0.6 AND quality<0.8 THEN '0.6-0.8'
			       WHEN quality>=0.8 AND quality<=1.0 THEN '0.8-1.0'
			       ELSE 'other' END AS bucket, COUNT(*) AS cnt
			 FROM experiences WHERE type=? AND status='active' GROUP BY bucket ORDER BY bucket`,
		)
		.all(type) as BucketRow[];
}

function mdTable(headers: string[], rows: (string | number)[][]): string {
	const lines = [`| ${headers.join(" | ")} |`, `|${headers.map(() => "---").join("|")}|`];
	for (const row of rows) lines.push(`| ${row.join(" | ")} |`);
	if (rows.length === 0) lines.push(`| ${headers.map(() => "—").join(" | ")} |`);
	return lines.join("\n");
}

/** Generate the markdown report. Exported for tests; pure read-only on db. */
export function generateWeeklyReport(db: Database.Database, now: Date): string {
	const iso = now.toISOString();
	const date = iso.slice(0, 10);

	const inventory = db
		.prepare(
			`SELECT type, json_extract(payload,'$.role') AS role, status, COUNT(*) AS cnt
			 FROM experiences GROUP BY type, json_extract(payload,'$.role'), status ORDER BY type, role`,
		)
		.all() as CountRow[];

	const abilityBuckets = qualityBuckets(db, "ABILITY");
	const evidenceBuckets = qualityBuckets(db, "EVIDENCE");

	const coexisting = db
		.prepare(
			`SELECT json_extract(a.payload,'$.taskId') AS taskId
			 FROM experiences a JOIN experiences e
			 ON json_extract(a.payload,'$.taskId')=json_extract(e.payload,'$.taskId')
			 WHERE a.type='ABILITY' AND e.type='EVIDENCE'`,
		)
		.all() as { taskId: string }[];

	const methodGuardStock = (
		db
			.prepare(
				`SELECT COUNT(*) AS cnt FROM experiences
				 WHERE type='ABILITY' AND status='active' AND json_extract(payload,'$.role') IN ('Method','Guard')`,
			)
			.get() as { cnt: number }
	).cnt;

	const checkpoints = db
		.prepare("SELECT id, epoch, metric FROM checkpoints WHERE kind='evolution' ORDER BY epoch DESC LIMIT 5")
		.all() as { id: string; epoch: number; metric: number }[];

	const dormantCount = (
		db.prepare("SELECT COUNT(*) AS cnt FROM experiences WHERE status='dormant'").get() as { cnt: number }
	).cnt;

	const cutoff = new Date(now.getTime() - C_HEAVY_WINDOW_DAYS * 86_400_000).toISOString();
	const newAbility28d = (
		db.prepare("SELECT COUNT(*) AS cnt FROM experiences WHERE type='ABILITY' AND created_at >= ?").get(cutoff) as {
			cnt: number;
		}
	).cnt;

	const distinctAbilityQuality = (
		db
			.prepare("SELECT COUNT(DISTINCT quality) AS cnt FROM experiences WHERE type='ABILITY' AND status='active'")
			.get() as {
			cnt: number;
		}
	).cnt;

	// --- trigger evaluations (runbook §3 action table) ---
	const triggers: string[] = [];
	triggers.push(
		methodGuardStock >= TRUNCATION_STOCK_LIMIT
			? `- [触发] **截断评审：触发** — Method+Guard 库存 ${methodGuardStock} ≥ ${TRUNCATION_STOCK_LIMIT}，注入端截断正在发生；核对被截条目的 quality 是否可惜（R3 结论：维持上限 5，被截 quality 上升时再评审）。`
			: `- 截断评审：未触发（Method+Guard 库存 ${methodGuardStock} < ${TRUNCATION_STOCK_LIMIT}）`,
	);
	triggers.push(
		coexisting.length > 0
			? `- [触发] **并存行评审：触发** — ${coexisting.length} 个 taskId 同时存在 ABILITY+EVIDENCE（${coexisting
					.slice(0, 5)
					.map((r) => r.taskId)
					.join(", ")}）；按 R3 判读规则先区分"同轨迹不同 role"与"重复晋升"。`
			: `- 并存行评审：未触发（0 行）`,
	);
	triggers.push(
		checkpoints.length > 0 && newAbility28d === 0
			? `- [触发] **C-重评审：触发** — 近 ${C_HEAVY_WINDOW_DAYS} 天无新 ABILITY 入库且已有进化运行记录；对照 C 决策 1 重启条件（真实 teacher 下连续 4 周为 0）。`
			: `- C-重评审：未触发（近 ${C_HEAVY_WINDOW_DAYS} 天新 ABILITY ${newAbility28d} 条）`,
	);
	triggers.push(
		dormantCount > DORMANT_BACKLOG_LIMIT
			? `- [触发] **rescore 治理：触发** — dormant 积压 ${dormantCount} > ${DORMANT_BACKLOG_LIMIT}，真实 LLM 下 rescore 成本不可行（R1 决策 1），需立项治理。`
			: `- rescore 治理：未触发（dormant ${dormantCount}）`,
	);
	if (distinctAbilityQuality <= 2 && methodGuardStock > 0) {
		triggers.push(
			`- [提示] quality 聚集 — active ABILITY 仅 ${distinctAbilityQuality} 个 distinct quality 值，注入排序区分度弱（R3 观察项 2）。`,
		);
	}

	return `# 观察周报（${date}）

生成时间：${iso}
数据库：见运行环境 EXPERIENCE_STORE_PATH

## 1. 库存概览（基线 §1）

${mdTable(
	["type", "role", "status", "cnt"],
	inventory.map((r) => [r.type, r.role ?? "(null)", r.status, r.cnt]),
)}

## 2. Quality 分布（基线 §3）

ABILITY：
${mdTable(
	["bucket", "cnt"],
	abilityBuckets.map((r) => [r.bucket ?? "—", r.cnt]),
)}

EVIDENCE：
${mdTable(
	["bucket", "cnt"],
	evidenceBuckets.map((r) => [r.bucket ?? "—", r.cnt]),
)}

## 3. 并存行（基线 §4）

${coexisting.length} 行。${coexisting.length > 0 ? `taskId：${coexisting.map((r) => r.taskId).join(", ")}` : ""}

## 4. 截断观察（基线 §5）

Method+Guard active 库存：${methodGuardStock}（注入上限各 5，库存 ≥${TRUNCATION_STOCK_LIMIT} 时截断发生）

## 5. Checkpoint 历史（基线 §6，近 5 次）

${mdTable(
	["id", "epoch", "metric"],
	checkpoints.map((c) => [c.id, new Date(c.epoch).toISOString(), c.metric]),
)}

## 6. 触发评审判定（runbook §3 动作表）

${triggers.join("\n")}

---
本报告为机械汇总，解读与处置由评审人（用户/agent）完成。
`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function runOnce(storePath: string, log: (msg: string) => void): string {
	const db = new Database(storePath, { readonly: true });
	try {
		const report = generateWeeklyReport(db, new Date());
		const reportDir = join(dirname(storePath), "reports");
		mkdirSync(reportDir, { recursive: true });
		const path = join(reportDir, `weekly-${new Date().toISOString().slice(0, 10)}.md`);
		writeFileSync(path, report, "utf-8");
		log(`weekly report written to ${path}`);
		return report;
	} finally {
		db.close();
	}
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
	const storePath = process.env.EXPERIENCE_STORE_PATH ?? "./var/experience.db";
	const intervalHours = Number(process.env.AGENT_SERVER_REPORT_INTERVAL_HOURS) || DEFAULT_INTERVAL_HOURS;
	const log = (msg: string) => console.log(msg);

	if (process.argv.includes("--loop")) {
		const tick = () => {
			try {
				runOnce(storePath, log);
			} catch (err) {
				console.error(`[weekly-report] run failed: ${err instanceof Error ? err.message : String(err)}`);
			}
			log(`[weekly-report] sleeping ${intervalHours}h until next run`);
		};
		tick();
		setInterval(tick, intervalHours * 3_600_000);
	} else {
		const report = runOnce(storePath, log);
		console.log(report);
	}
}
