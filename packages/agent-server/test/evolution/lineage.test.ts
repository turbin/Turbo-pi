import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EvolutionDb } from "../../src/evolution/db.ts";
import { type LineageEdge, LineageTracker } from "../../src/evolution/lineage.ts";

/**
 * P2-T23: lineage_edges recording and traversal.
 *
 * Graph used by the traversal tests:
 *
 *   root --draft--> a --improve--> b --debug--> c
 *                   a --crossover--> d
 */

describe("LineageTracker", () => {
	let evo: EvolutionDb;
	let tracker: LineageTracker;

	beforeEach(() => {
		evo = new EvolutionDb(":memory:");
		evo.migrate();
		tracker = new LineageTracker(evo.db);
	});

	afterEach(() => {
		evo.close();
	});

	function seedChain(): void {
		tracker.recordEdge({ parentId: "root", childId: "a", operator: "draft" }, 1000);
		tracker.recordEdge({ parentId: "a", childId: "b", operator: "improve", diffSummary: "better" }, 2000);
		tracker.recordEdge({ parentId: "b", childId: "c", operator: "debug" }, 3000);
		tracker.recordEdge({ parentId: "a", childId: "d", operator: "crossover" }, 4000);
	}

	it("records and retrieves an edge with a content-addressed edgeId", () => {
		const edgeId = tracker.recordEdge({ parentId: "p", childId: "c", operator: "improve", diffSummary: "d" }, 42);
		expect(edgeId).toMatch(/^[0-9a-f]{64}$/);
		const parents = tracker.getParents("c");
		expect(parents).toHaveLength(1);
		const edge = parents[0] as LineageEdge;
		expect(edge).toEqual({
			edgeId,
			parentId: "p",
			childId: "c",
			operator: "improve",
			createdAt: 42,
			diffSummary: "d",
		});
	});

	it("omits diffSummary when not provided", () => {
		tracker.recordEdge({ parentId: "p", childId: "c", operator: "draft" }, 1);
		expect(tracker.getParents("c")[0]?.diffSummary).toBeUndefined();
	});

	it("answers parent and child queries in both directions", () => {
		seedChain();
		expect(tracker.getParents("b").map((e) => e.parentId)).toEqual(["a"]);
		expect(tracker.getChildren("a").map((e) => e.childId)).toEqual(["b", "d"]);
		expect(tracker.getParents("root")).toEqual([]);
		expect(tracker.getChildren("c")).toEqual([]);
	});

	it("traverses ancestors up to the root", () => {
		seedChain();
		const ancestors = tracker.getAncestors("c");
		expect(ancestors.map((e) => `${e.parentId}->${e.childId}`)).toEqual(["b->c", "a->b", "root->a"]);
		expect(tracker.getAncestors("root")).toEqual([]);
	});

	it("traverses descendants down to the leaves", () => {
		seedChain();
		const descendants = tracker.getDescendants("a");
		expect(descendants.map((e) => `${e.parentId}->${e.childId}`)).toEqual(["a->b", "a->d", "b->c"]);
		expect(tracker.getDescendants("d")).toEqual([]);
	});

	it("rejects an invalid operator before SQLite", () => {
		expect(() => tracker.recordEdge({ parentId: "p", childId: "c", operator: "mutate" as never }, 1)).toThrow(
			/invalid operator/,
		);
		const count = evo.db.prepare("SELECT COUNT(*) AS n FROM lineage_edges").get() as { n: number };
		expect(count.n).toBe(0);
	});

	it("is idempotent: same input yields the same edgeId and one row", () => {
		const input = { parentId: "p", childId: "c", operator: "consolidate" } as const;
		const first = tracker.recordEdge(input, 7);
		const second = tracker.recordEdge(input, 7);
		expect(second).toBe(first);
		expect(tracker.getParents("c")).toHaveLength(1);
	});

	it("produces distinct edgeIds for distinct timestamps", () => {
		const first = tracker.recordEdge({ parentId: "p", childId: "c", operator: "rollback" }, 1);
		const second = tracker.recordEdge({ parentId: "p", childId: "c", operator: "rollback" }, 2);
		expect(second).not.toBe(first);
		expect(tracker.getParents("c")).toHaveLength(2);
	});

	it("rejects UPDATE and DELETE via the append-only triggers", () => {
		const edgeId = tracker.recordEdge({ parentId: "p", childId: "c", operator: "draft" }, 1);
		expect(() => evo.db.prepare("UPDATE lineage_edges SET operator = 'debug' WHERE edge_id = ?").run(edgeId)).toThrow(
			/append-only: UPDATE forbidden/,
		);
		expect(() => evo.db.prepare("DELETE FROM lineage_edges WHERE edge_id = ?").run(edgeId)).toThrow(
			/append-only: DELETE forbidden/,
		);
	});
});
