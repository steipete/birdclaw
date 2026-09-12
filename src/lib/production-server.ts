import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import {
	LOCAL_WEB_PEER_HEADER,
	readOnlyRequestErrorResponse,
} from "./http-effect";
import {
	type BirdclawMcpRuntime,
	handleBirdclawMcpExchange,
	prepareBirdclawMcpRuntime,
} from "./mcp-http";

interface FetchHandler {
	fetch(request: Request): Response | Promise<Response>;
}

export interface ProductionServerOptions {
	packageRoot: string;
	host?: string;
	port?: number;
	clientDir?: string;
	serverEntry?: string;
	serverVersion?: string;
	mcpRuntime?: BirdclawMcpRuntime | null;
	requestTimeoutMs?: number;
	headersTimeoutMs?: number;
	mcpResponseTimeoutMs?: number;
	json?: boolean;
	onListening?: (address: { host: string; port: number }) => void;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 35_000;
const DEFAULT_HEADERS_TIMEOUT_MS = 10_000;
const DEFAULT_MCP_RESPONSE_TIMEOUT_MS = 30_000;

const CONTENT_TYPES: Record<string, string> = {
	".css": "text/css; charset=utf-8",
	".gif": "image/gif",
	".html": "text/html; charset=utf-8",
	".ico": "image/x-icon",
	".jpeg": "image/jpeg",
	".jpg": "image/jpeg",
	".js": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".png": "image/png",
	".svg": "image/svg+xml",
	".txt": "text/plain; charset=utf-8",
	".webmanifest": "application/manifest+json",
	".woff": "font/woff",
	".woff2": "font/woff2",
};

function isLoopbackAddress(address: string | undefined) {
	if (!address) return false;
	const normalized = address.toLowerCase().replace(/^::ffff:/, "");
	return normalized === "::1" || normalized.startsWith("127.");
}

function requestHeaders(request: IncomingMessage) {
	const headers = new Headers();
	for (const [name, value] of Object.entries(request.headers)) {
		if (Array.isArray(value)) {
			for (const item of value) headers.append(name, item);
		} else if (value !== undefined) {
			headers.set(name, value);
		}
	}
	// This header is adapter-owned. Never trust a value supplied by the client.
	headers.delete(LOCAL_WEB_PEER_HEADER);
	if (isLoopbackAddress(request.socket.remoteAddress)) {
		headers.set(LOCAL_WEB_PEER_HEADER, "1");
	}
	return headers;
}

class IncomingRequestError extends Error {}

function rawHeaderValues(request: IncomingMessage, name: string) {
	const values: string[] = [];
	for (let index = 0; index < request.rawHeaders.length; index += 2) {
		if (request.rawHeaders[index]?.toLowerCase() === name) {
			values.push(request.rawHeaders[index + 1] ?? "");
		}
	}
	return values;
}

function parseIncomingUrl(request: IncomingMessage) {
	const hostHeaders = rawHeaderValues(request, "host");
	if (hostHeaders.length !== 1 || !hostHeaders[0]) {
		throw new IncomingRequestError("Exactly one Host header is required");
	}
	const rawTarget = request.url ?? "";
	if (
		!rawTarget.startsWith("/") ||
		rawTarget.startsWith("//") ||
		rawTarget.includes("\\")
	) {
		throw new IncomingRequestError(
			"Only origin-form request targets are allowed",
		);
	}
	let base: URL;
	let url: URL;
	try {
		base = new URL(`http://${hostHeaders[0]}`);
		url = new URL(rawTarget, base);
	} catch {
		throw new IncomingRequestError("Invalid request target or Host header");
	}
	if (url.origin !== base.origin) {
		throw new IncomingRequestError("Request target changed the request origin");
	}
	return { rawTarget, url };
}

function canonicalDnsHostname(hostname: string) {
	return hostname.toLowerCase().replace(/\.+$/u, "");
}

function hasReservedMcpHostname(url: URL, runtime: BirdclawMcpRuntime | null) {
	return Boolean(
		runtime?.config.reserveHost &&
		canonicalDnsHostname(url.hostname) ===
			canonicalDnsHostname(runtime.config.publicUrl.hostname),
	);
}

function hasMcpPathPrefix(rawTarget: string, url: URL) {
	const rawPath = rawTarget.split(/[?#]/u, 1)[0] ?? "";
	let candidate = rawPath;
	for (let depth = 0; depth < 3; depth += 1) {
		if (candidate.toLowerCase().startsWith("/mcp")) return true;
		try {
			const normalized = new URL(candidate, "http://birdclaw.invalid");
			if (
				normalized.origin === "http://birdclaw.invalid" &&
				normalized.pathname.toLowerCase().startsWith("/mcp")
			) {
				return true;
			}
			const decoded = decodeURIComponent(candidate);
			if (decoded === candidate) break;
			candidate = decoded;
		} catch {
			break;
		}
	}
	return url.pathname.toLowerCase().startsWith("/mcp");
}

function rejectDuplicateAuthorization(request: IncomingMessage) {
	if (rawHeaderValues(request, "authorization").length > 1) {
		throw new IncomingRequestError(
			"Multiple Authorization headers are not allowed",
		);
	}
}

function isExpectedClientDisconnect(
	error: unknown,
	request: IncomingMessage,
	response: ServerResponse,
) {
	if (request.aborted || request.destroyed || response.destroyed) return true;
	if (error instanceof Error && error.name === "AbortError") return true;
	const code = (error as { code?: unknown } | null)?.code;
	return (
		code === "ECONNRESET" ||
		code === "ERR_STREAM_DESTROYED" ||
		code === "ERR_STREAM_PREMATURE_CLOSE"
	);
}

function toWebRequest(
	request: IncomingMessage,
	url: URL,
	signal?: AbortSignal,
) {
	const method = request.method ?? "GET";
	const init: RequestInit & { duplex?: "half" } = {
		method,
		headers: requestHeaders(request),
		...(signal ? { signal } : {}),
	};
	if (method !== "GET" && method !== "HEAD") {
		init.body = Readable.toWeb(request) as ReadableStream;
		init.duplex = "half";
	}
	return new Request(url, init);
}

async function sendWebResponse(
	response: Response,
	target: ServerResponse,
	timeoutMs?: number,
) {
	target.statusCode = response.status;
	if (response.statusText) target.statusMessage = response.statusText;
	const setCookies = response.headers.getSetCookie();
	for (const [name, value] of response.headers) {
		if (name !== "set-cookie") target.setHeader(name, value);
	}
	if (setCookies.length > 0) target.setHeader("set-cookie", setCookies);
	if (!response.body) {
		await new Promise<void>((resolve, reject) => {
			target.once("error", reject);
			target.end(resolve);
		});
		return;
	}
	const body = Readable.fromWeb(response.body as never);
	let timeout: ReturnType<typeof setTimeout> | undefined;
	if (timeoutMs !== undefined) {
		timeout = setTimeout(() => {
			body.destroy(new Error("MCP response write timed out"));
			target.destroy(new Error("MCP response write timed out"));
		}, timeoutMs);
	}
	try {
		await pipeline(body, target);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

async function sendStaticFile(
	request: IncomingMessage,
	target: ServerResponse,
	clientDir: string,
	pathname: string,
) {
	if (request.method !== "GET" && request.method !== "HEAD") return false;
	try {
		pathname = decodeURIComponent(pathname);
	} catch {
		target.writeHead(400).end("Bad request");
		return true;
	}
	const root = path.resolve(clientDir);
	const filePath = path.resolve(root, `.${pathname}`);
	if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
		target.writeHead(403).end("Forbidden");
		return true;
	}
	const fileStats = await stat(filePath).catch(() => undefined);
	if (!fileStats?.isFile()) return false;

	target.statusCode = 200;
	target.setHeader("content-length", String(fileStats.size));
	target.setHeader(
		"content-type",
		CONTENT_TYPES[path.extname(filePath).toLowerCase()] ??
			"application/octet-stream",
	);
	if (pathname.startsWith("/assets/")) {
		target.setHeader("cache-control", "public, max-age=31536000, immutable");
	}
	if (request.method === "HEAD") {
		target.end();
		return true;
	}
	await new Promise<void>((resolve, reject) => {
		const stream = createReadStream(filePath);
		stream.once("error", reject);
		target.once("error", reject);
		target.once("finish", resolve);
		stream.pipe(target);
	});
	return true;
}

export async function startProductionServer({
	packageRoot,
	host = "127.0.0.1",
	port = 3000,
	clientDir = path.join(packageRoot, "dist", "client"),
	serverEntry = path.join(packageRoot, "dist", "server", "server.js"),
	serverVersion = "0.0.0",
	mcpRuntime: injectedMcpRuntime,
	requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
	headersTimeoutMs = DEFAULT_HEADERS_TIMEOUT_MS,
	mcpResponseTimeoutMs = DEFAULT_MCP_RESPONSE_TIMEOUT_MS,
}: ProductionServerOptions) {
	process.env.BIRDCLAW_LOCAL_WEB = "socket";
	const mcpRuntime =
		injectedMcpRuntime === undefined
			? prepareBirdclawMcpRuntime(serverVersion)
			: injectedMcpRuntime;
	const loaded = (await import(pathToFileURL(serverEntry).href)) as {
		default?: FetchHandler;
	};
	if (!loaded.default || typeof loaded.default.fetch !== "function") {
		throw new Error(
			`Production server entry has no fetch handler: ${serverEntry}`,
		);
	}
	const handler = loaded.default;
	const server = createServer(
		{
			requireHostHeader: true,
			requestTimeout: requestTimeoutMs,
			headersTimeout: Math.min(headersTimeoutMs, requestTimeoutMs),
			connectionsCheckingInterval: 1_000,
			maxHeaderSize: 16 * 1024,
		},
		async (request, response) => {
			try {
				const { rawTarget, url } = parseIncomingUrl(request);
				const isExactMcpTarget = rawTarget === "/mcp";
				const isMcpNamespace = hasMcpPathPrefix(rawTarget, url);
				const isReservedMcpHost = hasReservedMcpHostname(url, mcpRuntime);

				if (!isExactMcpTarget && (isReservedMcpHost || isMcpNamespace)) {
					if (!request.readableEnded) {
						response.setHeader("connection", "close");
						request.resume();
					}
					await sendWebResponse(
						new Response(
							JSON.stringify({ error: "The MCP hostname only serves /mcp" }),
							{
								status: 404,
								headers: {
									"cache-control": "no-store",
									"content-type": "application/json",
								},
							},
						),
						response,
					);
					return;
				}

				if (isExactMcpTarget) {
					rejectDuplicateAuthorization(request);
					const requestAbort = new AbortController();
					const abortRequest = () => requestAbort.abort();
					const abortPrematureResponse = () => {
						if (!response.writableFinished) abortRequest();
					};
					request.once("aborted", abortRequest);
					request.once("error", abortRequest);
					response.once("close", abortPrematureResponse);
					const webRequest = toWebRequest(request, url, requestAbort.signal);
					const exchange = await handleBirdclawMcpExchange(
						webRequest,
						mcpRuntime,
						{ isLoopbackPeer: isLoopbackAddress(request.socket.remoteAddress) },
					);
					try {
						if (!request.readableEnded) {
							response.setHeader("connection", "close");
							request.resume();
						}
						await sendWebResponse(
							exchange.response,
							response,
							mcpResponseTimeoutMs,
						);
					} finally {
						exchange.finalize();
						request.removeListener("aborted", abortRequest);
						request.removeListener("error", abortRequest);
						response.removeListener("close", abortPrematureResponse);
					}
					return;
				}

				const readOnlyDenied = readOnlyRequestErrorResponse({
					url: url.href,
					method: request.method ?? "GET",
				});
				if (readOnlyDenied) {
					request.resume();
					await sendWebResponse(readOnlyDenied, response);
					return;
				}
				if (await sendStaticFile(request, response, clientDir, url.pathname))
					return;
				await sendWebResponse(
					await handler.fetch(toWebRequest(request, url)),
					response,
				);
			} catch (error) {
				if (error instanceof IncomingRequestError) {
					if (!response.headersSent) {
						response.statusCode = 400;
						response.setHeader("connection", "close");
						response.setHeader("content-type", "text/plain; charset=utf-8");
					}
					request.resume();
					response.end("Bad request");
					return;
				}
				if (isExpectedClientDisconnect(error, request, response)) return;
				if (!response.headersSent) {
					response.statusCode = 500;
					response.setHeader("content-type", "text/plain; charset=utf-8");
				}
				if (!response.destroyed) response.end("Internal server error");
				console.error(error instanceof Error ? error.message : String(error));
			}
		},
	);
	server.maxHeadersCount = 100;
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, resolve);
	});
	return server;
}

export async function runProductionServer(options: ProductionServerOptions) {
	const server = await startProductionServer(options);
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("Production server did not bind a TCP address");
	}
	const host = options.host ?? "127.0.0.1";
	const url = `http://${host.includes(":") ? `[${host}]` : host}:${String(address.port)}`;
	console.log(
		options.json
			? JSON.stringify({ ok: true, host, port: address.port, url })
			: `Birdclaw listening on ${url}`,
	);
	options.onListening?.({ host, port: address.port });

	await new Promise<never>((_, reject) => {
		const signals = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const;
		const removeHandlers = () => {
			for (const signal of signals) process.removeListener(signal, stop);
		};
		const stop = (signal: NodeJS.Signals) => {
			removeHandlers();
			server.close(() => process.kill(process.pid, signal));
			server.closeAllConnections();
		};
		for (const signal of signals) process.on(signal, stop);
		server.once("error", (error) => {
			removeHandlers();
			reject(error);
		});
	});
}
