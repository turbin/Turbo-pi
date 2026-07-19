import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const aiSrcIndex = fileURLToPath(new URL("../ai/src/index.ts", import.meta.url));

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		environment: "node",
		passWithNoTests: true,
	},
	resolve: {
		alias: [{ find: /^@earendil-works\/pi-ai$/, replacement: aiSrcIndex }],
	},
});
