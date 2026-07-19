import { createWriteStream, type WriteStream } from "node:fs";

export class SessionWriter {
	private stream: WriteStream;

	constructor(path: string) {
		this.stream = createWriteStream(path, { flags: "a" });
	}

	write(entry: Record<string, unknown>): void {
		this.stream.write(`${JSON.stringify(entry)}\n`);
	}

	close(): Promise<void> {
		return new Promise((resolve, reject) => {
			this.stream.end((err: Error | null | undefined) => (err ? reject(err) : resolve()));
		});
	}
}
