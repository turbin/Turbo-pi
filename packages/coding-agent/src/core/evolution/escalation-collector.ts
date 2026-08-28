/**
 * Gateway escalation join key collector for the Phase 1 evidence plane.
 *
 * Each quality-gated cloud escalation in the gateway carries a join key that
 * links the escalation back to the quality-signals record that triggered it.
 * The collector validates and stores those keys so later phases can join
 * gateway logs with the evidence plane.
 */

const HEX_64 = /^[0-9a-f]{64}$/;

export interface EscalationJoinKey {
	/** Monotonic gateway sequence number of the escalation. */
	gatewaySequence: number;
	/** 64-char lowercase sha256 hex of the quality-signals record. */
	qualitySignalsSha: string;
}

function isValidJoinKey(value: unknown): value is EscalationJoinKey {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const candidate = value as Partial<EscalationJoinKey>;
	return (
		typeof candidate.gatewaySequence === "number" &&
		Number.isInteger(candidate.gatewaySequence) &&
		typeof candidate.qualitySignalsSha === "string" &&
		HEX_64.test(candidate.qualitySignalsSha)
	);
}

function validateJoinKey(key: EscalationJoinKey): void {
	if (typeof key.gatewaySequence !== "number" || !Number.isInteger(key.gatewaySequence)) {
		throw new Error("gatewaySequence must be an integer");
	}
	if (typeof key.qualitySignalsSha !== "string" || !HEX_64.test(key.qualitySignalsSha)) {
		throw new Error("qualitySignalsSha must be a 64-char lowercase hex string");
	}
}

export class EscalationCollector {
	private joinKeys: EscalationJoinKey[] = [];

	recordJoinKey(key: EscalationJoinKey): void {
		validateJoinKey(key);
		this.joinKeys.push(key);
	}

	getJoinKeys(): EscalationJoinKey[] {
		return [...this.joinKeys];
	}
}

/** Creates a fresh, independent EscalationCollector. */
export function createEscalationCollector(): EscalationCollector {
	return new EscalationCollector();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * Extracts a join key from a gateway response shape. Accepts either a flat
 * shape (`gateway_sequence`, `quality_signals_sha`) or a nested shape under a
 * `gateway` field. Returns null when the fields are missing or invalid.
 */
export function parseFromGatewayResponse(response: unknown): EscalationJoinKey | null {
	if (!isRecord(response)) {
		return null;
	}
	const source = isRecord(response.gateway) ? response.gateway : response;
	const key = {
		gatewaySequence: source.gateway_sequence,
		qualitySignalsSha: source.quality_signals_sha,
	};
	return isValidJoinKey(key) ? key : null;
}
