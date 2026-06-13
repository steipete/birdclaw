import http from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const host = process.env.BIRDCLAW_HOST || "127.0.0.1";
const port = Number(process.env.BIRDCLAW_PORT || "3100");
const clientRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../dist/client",
);
const contentTypes = new Map([
	[".css", "text/css; charset=utf-8"],
	[".html", "text/html; charset=utf-8"],
	[".ico", "image/x-icon"],
	[".js", "text/javascript; charset=utf-8"],
	[".json", "application/json; charset=utf-8"],
	[".map", "application/json; charset=utf-8"],
	[".png", "image/png"],
	[".svg", "image/svg+xml"],
	[".txt", "text/plain; charset=utf-8"],
	[".webmanifest", "application/manifest+json; charset=utf-8"],
	[".woff", "font/woff"],
	[".woff2", "font/woff2"],
]);

if (process.env.BIRDCLAW_WEB_PROFILE !== "public-readonly") {
	throw new Error(
		"Built Birdclaw server requires BIRDCLAW_WEB_PROFILE=public-readonly",
	);
}
if (host !== "127.0.0.1" && host !== "::1") {
	throw new Error("Built Birdclaw server must bind to loopback");
}
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
	throw new Error(`Invalid BIRDCLAW_PORT: ${process.env.BIRDCLAW_PORT}`);
}

const { default: serverEntry } = await import("../dist/server/server.js");

function addSecurityHeaders(headers) {
	headers["permissions-policy"] =
		"camera=(), microphone=(), geolocation=(), payment=()";
	headers["referrer-policy"] = "no-referrer";
	headers["x-content-type-options"] = "nosniff";
	headers["x-frame-options"] = "DENY";
	return headers;
}

async function serveStatic(requestUrl, method, outgoing) {
	if (method !== "GET" && method !== "HEAD") return false;

	let decodedPath;
	try {
		decodedPath = decodeURIComponent(requestUrl.pathname);
	} catch {
		return false;
	}
	const filePath = path.resolve(clientRoot, `.${decodedPath}`);
	if (
		filePath === clientRoot ||
		!filePath.startsWith(`${clientRoot}${path.sep}`)
	) {
		return false;
	}

	let fileStat;
	try {
		fileStat = await stat(filePath);
	} catch {
		return false;
	}
	if (!fileStat.isFile()) return false;

	const extension = path.extname(filePath).toLowerCase();
	const headers = addSecurityHeaders({
		"cache-control": decodedPath.startsWith("/assets/")
			? "public, max-age=31536000, immutable"
			: "public, max-age=3600",
		"content-length": String(fileStat.size),
		"content-type": contentTypes.get(extension) || "application/octet-stream",
		"last-modified": fileStat.mtime.toUTCString(),
	});
	outgoing.writeHead(200, headers);
	if (method === "HEAD") {
		outgoing.end();
		return true;
	}
	createReadStream(filePath)
		.on("error", (error) => outgoing.destroy(error))
		.pipe(outgoing);
	return true;
}

const server = http.createServer(async (incoming, outgoing) => {
	const abortController = new AbortController();
	incoming.once("aborted", () => abortController.abort());

	try {
		const method = incoming.method || "GET";
		const requestUrl = new URL(
			incoming.url || "/",
			`http://${incoming.headers.host || host}`,
		);
		if (await serveStatic(requestUrl, method, outgoing)) return;

		const request = new Request(requestUrl, {
			method,
			headers: incoming.headers,
			body:
				method === "GET" || method === "HEAD"
					? undefined
					: Readable.toWeb(incoming),
			duplex: "half",
			signal: abortController.signal,
		});
		const response = await serverEntry.fetch(request);
		const headers = addSecurityHeaders(Object.fromEntries(response.headers));
		if (
			process.env.BIRDCLAW_WEB_PROFILE === "public-readonly" &&
			!response.headers.has("cache-control")
		) {
			headers["cache-control"] = "private, no-store";
		}
		const getSetCookie = response.headers.getSetCookie?.bind(response.headers);
		if (getSetCookie) {
			const cookies = getSetCookie();
			if (cookies.length > 0) headers["set-cookie"] = cookies;
		}
		outgoing.writeHead(response.status, headers);
		if (!response.body || method === "HEAD") {
			outgoing.end();
			return;
		}
		Readable.fromWeb(response.body).pipe(outgoing);
	} catch (error) {
		if (abortController.signal.aborted) return;
		console.error(error);
		outgoing.writeHead(500, {
			"content-type": "text/plain; charset=utf-8",
			"x-content-type-options": "nosniff",
		});
		outgoing.end("Internal Server Error");
	}
});

server.listen(port, host, () => {
	console.log(`Birdclaw listening on http://${host}:${String(port)}`);
});
