// Minimal HTTP forward proxy (CONNECT + plain HTTP) for E2/E3 eval containers.
//
// Why: colima VM -> internet is intermittently broken (SSL EOF, multi-minute
// outages), while host -> internet is stable. TB task containers need network
// in three places outside the agent LLM call: docker build (apt), run-tests.sh
// (apt + uv + pytest install), and occasional in-task tooling. Pointing
// containers at this proxy (http://host.docker.internal:8898) routes all of it
// over the host network. The agent LLM call itself goes through
// deepseek_relay.mjs (control arm) or the eval agent-server (experiment arm).
//
// Usage: node host_forward_proxy.mjs  (listens 0.0.0.0:8898)

import http from "node:http";
import net from "node:net";

const LISTEN_HOST = process.env.PROXY_LISTEN_HOST || "0.0.0.0";
const LISTEN_PORT = Number(process.env.PROXY_PORT || 8898);
const CONNECT_TIMEOUT_MS = 30_000;

// host.docker.internal is a VM-side alias for this host; resolve it to loopback
// when containers send host-bound traffic through us anyway.
function resolveHost(hostname) {
	return hostname === "host.docker.internal" ? "127.0.0.1" : hostname;
}

const server = http.createServer((req, res) => {
	// Plain HTTP forward: absolute-URI form (http://host/path).
	let target;
	try {
		target = new URL(req.url);
	} catch {
		res.writeHead(400);
		res.end("bad request: absolute URI required");
		return;
	}
	const upstream = http.request(
		{
			hostname: resolveHost(target.hostname),
			port: target.port || 80,
			path: target.pathname + target.search,
			method: req.method,
			headers: { ...req.headers, host: target.host },
			timeout: CONNECT_TIMEOUT_MS,
		},
		(upRes) => {
			res.writeHead(upRes.statusCode ?? 502, upRes.headers);
			upRes.pipe(res);
		},
	);
	upstream.on("timeout", () => upstream.destroy(new Error("upstream timeout")));
	upstream.on("error", (err) => {
		if (!res.headersSent) res.writeHead(502);
		res.end(`proxy error: ${err.message}`);
	});
	req.pipe(upstream);
});

// HTTPS via CONNECT tunnel.
server.on("connect", (req, clientSocket, head) => {
	const [rawHost, port] = (req.url || "").split(":");
	if (!rawHost) {
		clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
		return;
	}
	const host = resolveHost(rawHost);
	const upstream = net.connect(Number(port) || 443, host, () => {
		clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
		if (head?.length) upstream.write(head);
		upstream.pipe(clientSocket);
		clientSocket.pipe(upstream);
	});
	upstream.setTimeout(CONNECT_TIMEOUT_MS, () => upstream.destroy(new Error("connect timeout")));
	upstream.on("error", () => clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
	clientSocket.on("error", () => upstream.destroy());
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
	console.log(`[forward-proxy] http://${LISTEN_HOST}:${LISTEN_PORT}`);
});
