import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ExperienceStore } from "../../src/experience-store.ts";
import type { Experience } from "../../src/types.ts";

/**
 * issue-006 回归：快照模式下写侧去重必须读 live 库。
 *
 * M10 快照修复曾把 getByContentHash/getById 一并切到冻结快照（readDb）——
 * 进化晋升（offline/verifier.ts）与 ETL（offline/etl.ts）用它们做去重，
 * 读快照会看不到快照之后写入 live 库的经验，导致重复晋升/重复入库。
 * 原则：写路径服务查询（getById/getByContentHash）一律读 live；只有检索
 * 路径（search/listActive）才读快照。
 */

function makeExp(id: string, hash: string): Experience {
	return {
		id,
		type: "EVIDENCE" as const,
		title: `evidence ${id}`,
		payload: { text: `content ${id}` },
		quality: 0.8,
		confidence: 0.5,
		rescoreExcludedBatches: 0,
		status: "active" as const,
		sourceSession: "session-1",
		sourceEntryId: "entry-1",
		contentHash: hash,
		createdAt: new Date().toISOString(),
	};
}

describe("issue-006: snapshot write-path dedup reads the live db", () => {
	it("getByContentHash sees live writes even with a snapshot configured", async () => {
		const dir = mkdtempSync(join(tmpdir(), "agent-server-issue006-"));
		const livePath = join(dir, "live.db");
		const snapPath = join(dir, "snap.db");
		try {
			const live = new ExperienceStore(livePath);
			await live.initSchema();
			await live.insert(makeExp("exp-before", "hash-before"));
			copyFileSync(livePath, snapPath); // 冻结点

			// 快照之后写入 live 库的新经验（进化晋升的去重对象）。
			await live.insert(makeExp("exp-after", "hash-after"));

			const snap = new ExperienceStore(livePath, { snapshotPath: snapPath });
			await snap.initSchema();
			// 写侧去重：必须能查到 live 新写入（先红后绿）。
			expect(await snap.getByContentHash("hash-after")).not.toBeNull();
			expect(await snap.getById("exp-after")).not.toBeNull();
			// 检索路径仍读快照：快照点之前的内容可见，之后的内容不可见。
			expect(await snap.search("content", 10)).toHaveLength(1);
			expect((await snap.search("content", 10))[0].id).toBe("exp-before");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
