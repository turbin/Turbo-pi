import { startServer } from "./server.ts";

startServer(Number(process.env.PORT ?? 8788)).catch((err) => {
	console.error(err);
	process.exit(1);
});
