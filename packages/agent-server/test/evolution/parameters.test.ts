import { describe, expect, it } from "vitest";
import {
	DEFAULT_PARAMETERS,
	type EvolutionParameter,
	loadParameters,
	validateParameter,
	validateRegistry,
} from "../../src/evolution/parameters.ts";

const EXPECTED_IDS = ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9", "P10"];

describe("loadParameters", () => {
	it("loads default parameters with all P1-P10 present", () => {
		const params = loadParameters();
		expect(params).toHaveLength(10);
		expect(params.map((p) => p.id)).toEqual(EXPECTED_IDS);
	});

	it("returns a defensive copy, not the DEFAULT_PARAMETERS array", () => {
		const params = loadParameters();
		params[0].owner = "mutated";
		expect(DEFAULT_PARAMETERS[0].owner).not.toBe("mutated");
	});

	it("loads an explicitly supplied registry", () => {
		const custom: EvolutionParameter = {
			id: "P1",
			name: "custom",
			owner: "someone",
			value: "rotated-every-30d",
			rationale: "confirmed",
			version: "1.0",
			expiresAt: "2027-01-01T00:00:00.000Z",
			failClosedDefault: "no rotation",
			status: "registered",
		};
		const params = loadParameters([custom]);
		expect(params).toHaveLength(1);
		expect(params[0].status).toBe("registered");
		expect(params[0].value).toBe("rotated-every-30d");
	});
});

describe("DEFAULT_PARAMETERS", () => {
	it("every parameter has non-empty owner, rationale, version, expiresAt", () => {
		for (const p of DEFAULT_PARAMETERS) {
			expect(p.owner.length).toBeGreaterThan(0);
			expect(p.rationale.length).toBeGreaterThan(0);
			expect(p.version.length).toBeGreaterThan(0);
			expect(p.expiresAt.length).toBeGreaterThan(0);
			expect(Number.isNaN(Date.parse(p.expiresAt))).toBe(false);
		}
	});

	it("every default parameter passes validation and starts pending", () => {
		for (const p of DEFAULT_PARAMETERS) {
			expect(p.status).toBe("pending");
			expect(validateParameter(p)).toEqual({ ok: true });
		}
	});

	it("fail-closed defaults are declared for every parameter", () => {
		for (const p of DEFAULT_PARAMETERS) {
			expect(p.failClosedDefault.length).toBeGreaterThan(0);
		}
	});
});

describe("validateParameter", () => {
	function complete(): EvolutionParameter {
		return {
			id: "P3",
			name: "data-classes",
			owner: "data-owner",
			value: "not_yet_registered",
			rationale: "needs full enum with TTL and erasure rules",
			version: "0b-draft.1",
			expiresAt: "2026-12-31T00:00:00.000Z",
			failClosedDefault: "local retention only",
			status: "pending",
		};
	}

	it("accepts a complete parameter", () => {
		expect(validateParameter(complete())).toEqual({ ok: true });
	});

	it("rejects a missing owner", () => {
		const result = validateParameter({ ...complete(), owner: "" });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toContain("owner must be non-empty");
		}
	});

	it("rejects a missing rationale", () => {
		const result = validateParameter({ ...complete(), rationale: "" });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toContain("rationale must be non-empty");
		}
	});

	it("rejects an invalid expiresAt", () => {
		const result = validateParameter({ ...complete(), expiresAt: "not-a-date" });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toContain("expiresAt must be a parseable ISO 8601 timestamp");
		}
	});

	it("rejects an invalid status", () => {
		const result = validateParameter({ ...complete(), status: "bogus" as EvolutionParameter["status"] });
		expect(result.ok).toBe(false);
	});

	it("collects multiple errors at once", () => {
		const result = validateParameter({ ...complete(), owner: "", rationale: "", version: "" });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.length).toBeGreaterThanOrEqual(3);
		}
	});
});

describe("validateRegistry", () => {
	function freshRegistry(): EvolutionParameter[] {
		return loadParameters();
	}

	it("accepts the default P1-P10 registry", () => {
		expect(validateRegistry(freshRegistry())).toEqual({ ok: true });
	});

	it("fails when P5 is missing", () => {
		const params = freshRegistry().filter((p) => p.id !== "P5");
		const result = validateRegistry(params);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toContain("missing parameter P5");
		}
	});

	it("fails on a duplicate parameter id", () => {
		const params = freshRegistry();
		params.push({ ...params[0] });
		const result = validateRegistry(params);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toContain("duplicate parameter id P1");
		}
	});

	it("fails on an expired parameter", () => {
		const params = freshRegistry().map((p) =>
			p.id === "P3" ? { ...p, expiresAt: "2020-01-01T00:00:00.000Z", status: "expired" as const } : p,
		);
		const result = validateRegistry(params);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.some((e) => e.startsWith("expired parameter P3"))).toBe(true);
		}
	});

	it("allows expired parameters when explicitly permitted", () => {
		const params = freshRegistry().map((p) =>
			p.id === "P3" ? { ...p, expiresAt: "2020-01-01T00:00:00.000Z", status: "expired" as const } : p,
		);
		expect(validateRegistry(params, { allowExpired: true })).toEqual({ ok: true });
	});

	it("fails when a parameter is individually invalid", () => {
		const params = freshRegistry().map((p) => (p.id === "P8" ? { ...p, owner: "" } : p));
		const result = validateRegistry(params);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toContain("P8: owner must be non-empty");
		}
	});

	it("honours an explicit reference time for expiry checks", () => {
		const params = freshRegistry();
		const future = new Date("2027-06-01T00:00:00.000Z");
		const result = validateRegistry(params, { now: future });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.filter((e) => e.startsWith("expired parameter"))).toHaveLength(10);
		}
	});
});
