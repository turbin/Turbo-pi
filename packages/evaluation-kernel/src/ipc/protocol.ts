// NDJSON 传输帧编解码（Unix domain socket，架构 §3.2）。

export function encodeFrame(payload: unknown): string {
	return `${JSON.stringify(payload)}\n`;
}

/** 按行切分接收缓冲；跨 chunk 的残行缓存在实例内。 */
export class LineBuffer {
	private buffer = "";

	push(chunk: Buffer): string[] {
		this.buffer += chunk.toString("utf8");
		const lines: string[] = [];
		let newline = this.buffer.indexOf("\n");
		while (newline >= 0) {
			lines.push(this.buffer.slice(0, newline));
			this.buffer = this.buffer.slice(newline + 1);
			newline = this.buffer.indexOf("\n");
		}
		return lines;
	}

	/** 尚未成行的残行字节数（用于按帧的超长载荷检查）。 */
	get pendingLength(): number {
		return this.buffer.length;
	}
}
