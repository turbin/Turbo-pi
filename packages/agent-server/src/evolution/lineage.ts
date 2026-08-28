import type Database from "better-sqlite3";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import { OPERATORS, type Operator } from "./schema.ts";

/**
 * P2-T23: artifact lineage tracking over the `lineage_edges` table.
 *
 * Each edge records that `childId` was derived from `parentId` by `operator`.
 * Edge identity is content-addressed:
 *
 *   edgeId = sha256Hex(canonicalJson([parentId, childId, operator, createdAt]))
 *
 * reusing the frozen canonical JSON spec in canonical.ts. Recording the same
 * (parent, child, operator, createdAt) tuple twice yields the same edgeId and
 * is idempotent (INSERT OR IGNORE): the table gains no duplicate row.
 *
 * The table is append-only (guarded by the same triggers as the rest of
 * evolution.db); this class exposes no UPDATE/DELETE path. Traversal is
 * iterative with a visited set so cyclic or self-referential input data
 * terminates instead of looping.
 */

export interface LineageEdge {
	edgeId: string;
	parentId: string;
	childId: string;
	operator: Operator;
	/** INTEGER epoch ms. */
	createdAt: number;
	diffSummary?: string;
}

export type LineageEdgeInput = Omit<LineageEdge, "edgeId" | "createdAt">;

interface LineageRow {
	edge_id: string;
	parent_id: string;
	child_id: string;
	operator: string;
	diff_summary: string | null;
	created_at: number;
}

function toEdge(row: LineageRow): LineageEdge {
	const edge: LineageEdge = {
		edgeId: row.edge_id,
		parentId: row.parent_id,
		childId: row.child_id,
		operator: row.operator as Operator,
		createdAt: row.created_at,
	};
	if (row.diff_summary !== null) edge.diffSummary = row.diff_summary;
	return edge;
}

export class LineageTracker {
	private readonly insertStmt: Database.Statement;
	private readonly parentsStmt: Database.Statement;
	private readonly childrenStmt: Database.Statement;

	constructor(db: Database.Database) {
		this.insertStmt = db.prepare(`
			INSERT OR IGNORE INTO lineage_edges (edge_id, parent_id, child_id, operator, diff_summary, created_at)
			VALUES (?, ?, ?, ?, ?, ?)
		`);
		this.parentsStmt = db.prepare("SELECT * FROM lineage_edges WHERE child_id = ? ORDER BY created_at, edge_id");
		this.childrenStmt = db.prepare("SELECT * FROM lineage_edges WHERE parent_id = ? ORDER BY created_at, edge_id");
	}

	/**
	 * Append one lineage edge; returns the content-addressed `edgeId`.
	 * `now` is injectable for deterministic tests; defaults to wall clock.
	 * Re-recording the same tuple is a no-op returning the same edgeId.
	 */
	recordEdge(edge: LineageEdgeInput, now: number = Date.now()): string {
		if (typeof edge.parentId !== "string" || edge.parentId.length === 0) {
			throw new Error("recordEdge: parentId must be a non-empty string");
		}
		if (typeof edge.childId !== "string" || edge.childId.length === 0) {
			throw new Error("recordEdge: childId must be a non-empty string");
		}
		if (!OPERATORS.includes(edge.operator)) {
			throw new Error(`recordEdge: invalid operator ${String(edge.operator)} (allowed: ${OPERATORS.join(", ")})`);
		}
		const edgeId = sha256Hex(canonicalJson([edge.parentId, edge.childId, edge.operator, now]));
		this.insertStmt.run(edgeId, edge.parentId, edge.childId, edge.operator, edge.diffSummary ?? null, now);
		return edgeId;
	}

	/** Direct edges where `artifactId` is the child (its parents). */
	getParents(artifactId: string): LineageEdge[] {
		return (this.parentsStmt.all(artifactId) as LineageRow[]).map(toEdge);
	}

	/** Direct edges where `artifactId` is the parent (its children). */
	getChildren(artifactId: string): LineageEdge[] {
		return (this.childrenStmt.all(artifactId) as LineageRow[]).map(toEdge);
	}

	/** All edges on every path from `artifactId` up to the roots (breadth-first). */
	getAncestors(artifactId: string): LineageEdge[] {
		return this.walk(artifactId, (id) => this.getParents(id));
	}

	/** All edges on every path from `artifactId` down to the leaves (breadth-first). */
	getDescendants(artifactId: string): LineageEdge[] {
		return this.walk(artifactId, (id) => this.getChildren(id));
	}

	private walk(startId: string, next: (id: string) => LineageEdge[]): LineageEdge[] {
		const edges: LineageEdge[] = [];
		const seenEdges = new Set<string>();
		const seenNodes = new Set<string>([startId]);
		let frontier = [startId];
		while (frontier.length > 0) {
			const following: string[] = [];
			for (const id of frontier) {
				for (const edge of next(id)) {
					if (seenEdges.has(edge.edgeId)) continue;
					seenEdges.add(edge.edgeId);
					edges.push(edge);
					const neighbor = edge.parentId === id ? edge.childId : edge.parentId;
					if (!seenNodes.has(neighbor)) {
						seenNodes.add(neighbor);
						following.push(neighbor);
					}
				}
			}
			frontier = following;
		}
		return edges;
	}
}
