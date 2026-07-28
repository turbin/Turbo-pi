// Minimal HTTP->HTTPS relay for the E2/E3 control arm.
//
// Why: colima VM -> internet (api.deepseek.com) connectivity is intermittently
// broken (SSL EOF / connection errors that come and go over time), while host
// -> DeepSeek is stable. Task containers can always reach the host via
// host.docker.internal. So the control arm points OPENAI_BASE_URL at
// http://host.docker.internal:8899/v1 and this relay forwards to
// https://api.deepseek.com over the host network, adding nothing (no
// injection, no logging of bodies) — a dumb pipe so the A/B difference stays
// limited to the agent-server experience injection.
//
// Usage: node deepseek_relay.mjs  (listens 0.0.0.0:8899)

import http from "node:http";
import https from "node:https";

const UPSTREAM_HOST = process.env.RELAY_UPSTREAM_HOST || "api.deepseek.com";
const LISTEN_HOST = process.env.RELAY_LISTEN_HOST || "0.0.0.0";
const LISTEN_PORT = Number(process.env.RELAY_PORT || 8899);

const server = http.createServer((req, res) => {
	const options = {
		hostname: UPSTREAM_HOST,
		port: 443,
		path: req.url,
		method: req.method,
		headers: { ...req.headers, host: UPSTREAM_HOST },
	};
	const upstream = https.request(options, (upRes) => {
		res.writeHead(upRes.statusCode ?? 502, upRes.headers);
		upRes.pipe(res);
	});
	upstream.on("error", (err) => {
		if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: { message: `relay upstream error: ${err.message}` } }));
	});
	req.pipe(upstream);
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
	console.log(`[relay] http://${LISTEN_HOST}:${LISTEN_PORT} -> https://${UPSTREAM_HOST}`);
});
