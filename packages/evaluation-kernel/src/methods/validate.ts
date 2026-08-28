// 参数校验助手：缺必填字段 → missing_field（fail closed）；格式错误 → invalid_request。
// 语义：字段缺失/非期望类型按缺字段拒绝；值存在但格式不符按 invalid_request 拒绝。

import { type Budget, TekError } from "../ipc/contract.ts";

export function asObject(params: unknown): Record<string, unknown> {
	if (typeof params === "object" && params !== null && !Array.isArray(params)) {
		return params as Record<string, unknown>;
	}
	return {};
}

export function requireString(params: Record<string, unknown>, field: string): string {
	if (params[field] === undefined) {
		throw new TekError("missing_field", `missing required field: ${field}`, field);
	}
	if (typeof params[field] !== "string" || params[field] === "") {
		throw new TekError("invalid_request", `field ${field} must be a non-empty string`, field);
	}
	return params[field] as string;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

export function requireSha256Hex(params: Record<string, unknown>, field: string): string {
	const value = requireString(params, field);
	if (!SHA256_HEX.test(value)) {
		throw new TekError("invalid_request", `field ${field} must be a lowercase sha256 hex (64 chars)`, field);
	}
	return value;
}

/** `prefix-<sha256hex>` 引用格式（preflight-… / denylist-…）。 */
export function requirePrefixedSha256Hex(params: Record<string, unknown>, field: string, prefix: string): string {
	const value = requireString(params, field);
	if (!value.startsWith(`${prefix}-`) || !SHA256_HEX.test(value.slice(prefix.length + 1))) {
		throw new TekError("invalid_request", `field ${field} must be '${prefix}-<sha256hex>'`, field);
	}
	return value;
}

export function requireNumber(params: Record<string, unknown>, field: string, displayName = field): number {
	if (params[field] === undefined) {
		throw new TekError("missing_field", `missing required field: ${displayName}`, displayName);
	}
	if (typeof params[field] !== "number" || !Number.isFinite(params[field])) {
		throw new TekError("invalid_request", `field ${displayName} must be a finite number`, displayName);
	}
	return params[field] as number;
}

export function requireNonNegativeInteger(params: Record<string, unknown>, field: string, displayName = field): number {
	const value = requireNumber(params, field, displayName);
	if (!Number.isInteger(value) || value < 0) {
		throw new TekError("invalid_request", `field ${displayName} must be a non-negative integer`, displayName);
	}
	return value;
}

export function requireStringArray(params: Record<string, unknown>, field: string): string[] {
	if (params[field] === undefined) {
		throw new TekError("missing_field", `missing required field: ${field}`, field);
	}
	if (!Array.isArray(params[field]) || params[field].some((item) => typeof item !== "string")) {
		throw new TekError("invalid_request", `field ${field} must be an array of strings`, field);
	}
	return params[field] as string[];
}

export function requireObject(params: Record<string, unknown>, field: string): Record<string, unknown> {
	if (params[field] === undefined) {
		throw new TekError("missing_field", `missing required field: ${field}`, field);
	}
	if (typeof params[field] !== "object" || params[field] === null || Array.isArray(params[field])) {
		throw new TekError("invalid_request", `field ${field} must be an object`, field);
	}
	return params[field] as Record<string, unknown>;
}

export function requireEnum<T extends string>(
	params: Record<string, unknown>,
	field: string,
	allowed: readonly T[],
): T {
	const value = requireString(params, field);
	if (!(allowed as readonly string[]).includes(value)) {
		throw new TekError("invalid_request", `field ${field} must be one of: ${allowed.join(", ")}`, field);
	}
	return value as T;
}

export function requireBudget(params: Record<string, unknown>, field: string): Budget {
	const budget = requireObject(params, field);
	return {
		tokensCap: requireNonNegativeInteger(budget, "tokensCap", `${field}.tokensCap`),
		costCapMicros: requireNonNegativeInteger(budget, "costCapMicros", `${field}.costCapMicros`),
		wallTimeCapMs: requireNonNegativeInteger(budget, "wallTimeCapMs", `${field}.wallTimeCapMs`),
	};
}
