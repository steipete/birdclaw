import { execFile, spawn } from "node:child_process";
import {
	mkdtemp,
	mkdir,
	readFile,
	readdir,
	rm,
	writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tempRoot = await mkdtemp(
	path.join(os.tmpdir(), "birdclaw-package-smoke-"),
);

async function run(command, args, options = {}) {
	return execFileAsync(command, args, {
		maxBuffer: 20 * 1024 * 1024,
		...options,
	});
}

async function reserveLoopbackPort() {
	const reservation = createServer();
	await new Promise((resolve, reject) => {
		reservation.once("error", reject);
		reservation.listen(0, "127.0.0.1", resolve);
	});
	const address = reservation.address();
	if (!address || typeof address === "string") {
		throw new Error("Could not reserve a loopback TCP port");
	}
	await new Promise((resolve, reject) =>
		reservation.close((error) => (error ? reject(error) : resolve())),
	);
	return address.port;
}

async function withTimeout(label, promise, timeoutMs = 20_000) {
	let timer;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setTimeout(
					() =>
						reject(
							new Error(`${label} timed out after ${String(timeoutMs)}ms`),
						),
					timeoutMs,
				);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function waitForServer(child) {
	return new Promise((resolve, reject) => {
		let output = "";
		let errors = "";
		const timer = setTimeout(() => {
			reject(
				new Error(
					`Timed out waiting for production server\n${output}\n${errors}`,
				),
			);
		}, 20_000);
		child.stdout.on("data", (chunk) => {
			output += String(chunk);
			const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
			if (!match) return;
			clearTimeout(timer);
			resolve(`http://127.0.0.1:${match[1]}`);
		});
		child.stderr.on("data", (chunk) => {
			errors += String(chunk);
		});
		child.once("exit", (code, signal) => {
			clearTimeout(timer);
			reject(
				new Error(
					`Production server exited before startup (${String(code ?? signal)})\n${output}\n${errors}`,
				),
			);
		});
	});
}

try {
	const packDir = path.join(tempRoot, "pack");
	await mkdir(packDir, { recursive: true });
	await run("npm", ["pack", "--pack-destination", packDir], { cwd: root });
	const tarballName = (await readdir(packDir)).find((name) =>
		name.endsWith(".tgz"),
	);
	if (!tarballName) throw new Error("npm pack did not create a tarball");
	const tarball = path.join(packDir, tarballName);
	const { stdout: tarOutput } = await run("tar", ["-tzf", tarball]);
	const files = tarOutput.trim().split("\n");
	for (const required of [
		"package/bin/birdclaw.mjs",
		"package/dist/cli/birdclaw.js",
		"package/dist/server/server.js",
	]) {
		if (!files.includes(required))
			throw new Error(`Tarball missing ${required}`);
	}
	for (const forbidden of ["package/src/", "package/scripts/", "tsx"]) {
		if (files.some((file) => file.includes(forbidden))) {
			throw new Error(`Tarball unexpectedly contains ${forbidden}`);
		}
	}

	const installDir = path.join(tempRoot, "install");
	await mkdir(installDir, { recursive: true });
	await writeFile(
		path.join(installDir, "package.json"),
		`${JSON.stringify({ name: "birdclaw-package-smoke", private: true, type: "module" })}\n`,
	);
	await run(
		"npm",
		["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
		{ cwd: installDir },
	);
	const installedRoot = path.join(installDir, "node_modules", "birdclaw");
	const manifest = JSON.parse(
		await readFile(path.join(installedRoot, "package.json"), "utf8"),
	);
	if (manifest.dependencies?.tsx || manifest.dependencies?.vite) {
		throw new Error("Installed runtime dependencies include tsx or vite");
	}
	const bin = path.join(installDir, "node_modules", ".bin", "birdclaw");
	const home = path.join(tempRoot, "home");
	const env = {
		...process.env,
		BIRDCLAW_DISABLE_LIVE_WRITES: "1",
		BIRDCLAW_HOME: home,
	};
	delete env.BIRDCLAW_MCP_ACCOUNT;
	delete env.BIRDCLAW_WEB_TOKEN;

	const versionStarted = performance.now();
	const { stdout: versionOutput } = await run(bin, ["--version"], {
		cwd: installDir,
		env,
	});
	const versionMs = performance.now() - versionStarted;
	if (versionOutput.trim() !== manifest.version) {
		throw new Error(`Unexpected version output: ${versionOutput}`);
	}
	const { stdout: helpOutput } = await run(bin, ["--help"], {
		cwd: installDir,
		env,
	});
	if (!helpOutput.includes("Run the local web app")) {
		throw new Error("Installed CLI help is missing serve");
	}
	const { stdout: initOutput } = await run(bin, ["--json", "init", "--demo"], {
		cwd: installDir,
		env,
	});
	const init = JSON.parse(initOutput);
	if (
		init.demo?.seeded !== true ||
		init.demo?.counts?.accounts !== 2 ||
		!init.nextSteps?.includes("birdclaw serve")
	) {
		throw new Error(`Installed CLI demo init failed: ${initOutput}`);
	}
	const { stdout: statsOutput } = await run(bin, ["--json", "db", "stats"], {
		cwd: installDir,
		env,
	});
	JSON.parse(statsOutput);

	const port = await reserveLoopbackPort();
	const expectedBaseUrl = `http://127.0.0.1:${String(port)}`;
	const mcpToken = [
		"birdclaw-package",
		"smoke-token",
		"0123456789",
		"abcdef",
	].join("-");
	const serverEnv = {
		...env,
		BIRDCLAW_MCP_PUBLIC_URL: `${expectedBaseUrl}/mcp`,
		BIRDCLAW_MCP_TOKEN: mcpToken,
	};
	const child = spawn(
		bin,
		["serve", "--host", "127.0.0.1", "--port", String(port)],
		{
			cwd: installDir,
			env: serverEnv,
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let shutdownError;
	try {
		const baseUrl = await waitForServer(child);
		if (baseUrl !== expectedBaseUrl) {
			throw new Error(
				`Production server listened at unexpected URL ${baseUrl}`,
			);
		}
		const page = await fetch(baseUrl);
		if (!page.ok || !(await page.text()).toLowerCase().includes("birdclaw")) {
			throw new Error(
				`Production SSR smoke failed with ${String(page.status)}`,
			);
		}
		const asset = await fetch(`${baseUrl}/favicon.ico`);
		if (!asset.ok) {
			throw new Error(
				`Production static asset smoke failed with ${String(asset.status)}`,
			);
		}

		const installedRequire = createRequire(
			path.join(installedRoot, "package.json"),
		);
		const { Client } = await import(
			pathToFileURL(
				installedRequire.resolve("@modelcontextprotocol/sdk/client/index.js"),
			).href
		);
		const { StreamableHTTPClientTransport } = await import(
			pathToFileURL(
				installedRequire.resolve(
					"@modelcontextprotocol/sdk/client/streamableHttp.js",
				),
			).href
		);
		const transport = new StreamableHTTPClientTransport(
			new URL(`${baseUrl}/mcp`),
			{
				requestInit: {
					headers: { authorization: `Bearer ${mcpToken}` },
				},
			},
		);
		const client = new Client({
			name: "birdclaw-package-smoke",
			version: "1.0.0",
		});
		try {
			await withTimeout("MCP initialize", client.connect(transport));
			const serverVersion = client.getServerVersion();
			if (serverVersion?.version !== manifest.version) {
				throw new Error(
					`Unexpected MCP server version: ${JSON.stringify(serverVersion)}`,
				);
			}
			if (transport.sessionId !== undefined) {
				throw new Error(
					`Stateless MCP returned session ${transport.sessionId}`,
				);
			}
			const listed = await withTimeout("MCP tools/list", client.listTools());
			const toolNames = listed.tools.map((tool) => tool.name);
			if (
				JSON.stringify(toolNames) !==
				JSON.stringify(["search_tweets", "get_tweet_thread"])
			) {
				throw new Error(`Unexpected MCP tools: ${JSON.stringify(toolNames)}`);
			}
			const result = await withTimeout(
				"MCP tools/call",
				client.callTool({
					name: "search_tweets",
					arguments: { resource: "home", limit: 1 },
				}),
			);
			const structured = result.structuredContent;
			if (
				result.isError ||
				!structured ||
				structured.resource !== "home" ||
				!Array.isArray(structured.items)
			) {
				throw new Error(
					`Unexpected MCP tool result: ${JSON.stringify(result)}`,
				);
			}
		} finally {
			await withTimeout("MCP client close", client.close(), 5_000);
		}
	} finally {
		if (child.exitCode === null && child.signalCode === null) {
			const exited = new Promise((resolve) =>
				child.once("exit", (code, signal) => resolve({ code, signal })),
			);
			child.kill("SIGTERM");
			const exit = await exited;
			if (process.platform !== "win32" && exit.signal !== "SIGTERM") {
				shutdownError = new Error(
					`Production server did not preserve SIGTERM (${JSON.stringify(exit)})`,
				);
			}
		}
	}
	if (shutdownError) throw shutdownError;

	console.log(
		`Package smoke passed: ${String(files.length)} files, --version ${versionMs.toFixed(0)}ms`,
	);
} finally {
	await rm(tempRoot, { recursive: true, force: true });
}
