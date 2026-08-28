/**
 * TypeScript port of the agent-gateway DLP pattern logic.
 *
 * The default patterns are identical to those in
 * `packages/agent-gateway/src/agent_gateway/security/dlp.py`:
 *   - AWS access key id
 *   - PEM/OPENSSH/PGP private key header
 *   - api_key / secret / access_token assignment
 *   - Chinese 18-digit ID number
 *
 * The scan only returns pattern name and location; matched text is never kept.
 */

export interface DlpFinding {
	pattern: string;
	location: string;
}

export interface CompiledPattern {
	name: string;
	regex: RegExp;
}

export const DEFAULT_DLP_PATTERNS: Record<string, string> = {
	aws_access_key_id: "AKIA[0-9A-Z]{16}",
	private_key_pem: "-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----",
	api_key_assignment: "\\b(?:api[_-]?key|secret|access[_-]?token)\\b\\s*[:=]\\s*['\"]?[A-Za-z0-9_\\-]{20,}",
	chinese_id_number: "\\b\\d{17}[\\dXx]\\b",
};

export function compilePatterns(patterns: Record<string, string>): CompiledPattern[] {
	return Object.entries(patterns).map(([name, source]) => ({
		name,
		regex: new RegExp(source, "i"),
	}));
}

export function scanText(
	text: string,
	location: string,
	patterns: Record<string, string> = DEFAULT_DLP_PATTERNS,
): DlpFinding[] {
	const compiled = compilePatterns(patterns);
	const findings: DlpFinding[] = [];
	for (const { name, regex } of compiled) {
		if (regex.test(text)) {
			findings.push({ pattern: name, location });
		}
	}
	return findings;
}
