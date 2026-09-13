import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
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
import { smokeWithoutBird } from "./birdless-smoke.mjs";
import { smokeNativeDms } from "./native-dm-smoke.mjs";

const execFileAsync = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bunBin = process.execPath;
const nodeBin = process.env.BIRDCLAW_NODE_BIN || "node";
const jsonOutput = process.argv.includes("--json");
const tempRoot = await mkdtemp(
	path.join(os.tmpdir(), "birdclaw-package-smoke-"),
);

async function run(command, args, options = {}) {
	return execFileAsync(command, args, {
		maxBuffer: 20 * 1024 * 1024,
		...options,
	});
}

async function sha256(filePath) {
	return createHash("sha256")
		.update(await readFile(filePath))
		.digest("hex");
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

async function waitForServer(child, label) {
	return new Promise((resolve, reject) => {
		let output = "";
		let errors = "";
		const timer = setTimeout(() => {
			reject(
				new Error(
					`${label}: timed out waiting for production server\n${output}\n${errors}`,
				),
			);
		}, 20_000);
		child.stdout.on("data", (chunk) => {
			output += String(chunk);
			const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
			if (!match) return;
			clearTimeout(timer);
			try {
				const startup = JSON.parse(output);
				if (startup.ok !== true || startup.port !== Number(match[1])) {
					throw new Error(`${label}: invalid JSON startup event`);
				}
				resolve(startup.url);
			} catch (error) {
				reject(error);
			}
		});
		child.stderr.on("data", (chunk) => {
			errors += String(chunk);
		});
		child.once("exit", (code, signal) => {
			clearTimeout(timer);
			reject(
				new Error(
					`${label}: production server exited before startup (${String(code ?? signal)})\n${output}\n${errors}`,
				),
			);
		});
	});
}

function commandFor(runtime, args) {
	return [runtime.executable, [...runtime.prefix, ...args]];
}

async function runRuntime(runtime, args, options = {}) {
	const [command, commandArgs] = commandFor(runtime, args);
	return run(command, commandArgs, options);
}

function spawnRuntime(runtime, args, options = {}) {
	const [command, commandArgs] = commandFor(runtime, args);
	return spawn(command, commandArgs, options);
}

async function smokeRuntime({
	runtime,
	manifest,
	installedRoot,
	installDir,
	Client,
	StreamableHTTPClientTransport,
}) {
	const home = path.join(tempRoot, `home-${runtime.name}`);
	const env = {
		...(process.platform === "win32"
			? { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }
			: { PATH: "/usr/bin:/bin" }),
		HOME: home,
		USERPROFILE: home,
		BIRDCLAW_CONFIG: path.join(home, "config.json"),
		BIRDCLAW_BIRD_COMMAND: path.join(home, "bird-does-not-exist"),
		BIRDCLAW_BACKUP_AUTO_SYNC: "0",
		BIRDCLAW_DISABLE_LIVE_PROFILE_LOOKUP: "1",
		BIRDCLAW_DISABLE_LIVE_WRITES: "1",
		BIRDCLAW_HOME: home,
		DO_NOT_TRACK: "1",
	};

	const versionStarted = performance.now();
	const { stdout: versionOutput } = await runRuntime(runtime, ["--version"], {
		cwd: installDir,
		env,
	});
	const versionMs = performance.now() - versionStarted;
	if (versionOutput.trim() !== manifest.version) {
		throw new Error(
			`${runtime.name}: unexpected version output ${versionOutput}`,
		);
	}
	const { stdout: helpOutput } = await runRuntime(runtime, ["--help"], {
		cwd: installDir,
		env,
	});
	if (!helpOutput.includes("Run the local web app")) {
		throw new Error(`${runtime.name}: installed CLI help is missing serve`);
	}
	const { stdout: initOutput } = await runRuntime(
		runtime,
		["--json", "init", "--demo"],
		{ cwd: installDir, env },
	);
	const init = JSON.parse(initOutput);
	if (
		init.demo?.seeded !== true ||
		init.demo?.counts?.accounts !== 2 ||
		!init.nextSteps?.includes("birdclaw serve")
	) {
		throw new Error(
			`${runtime.name}: installed CLI demo init failed: ${initOutput}`,
		);
	}
	const { stdout: statsOutput } = await runRuntime(
		runtime,
		["--json", "db", "stats"],
		{ cwd: installDir, env },
	);
	JSON.parse(statsOutput);
	for (const args of [
		["search", "tweets", "local-first", "--limit", "3", "--json"],
		["search", "dms", "local", "--limit", "3", "--json"],
		["dms", "list", "--limit", "3", "--json"],
		["lists", "list", "--json"],
		["graph", "summary", "--json"],
		["blocks", "list", "--json"],
		["mutes", "list", "--json"],
		["inbox", "--limit", "3", "--json"],
		["show", "tweet", "tweet_001", "--json"],
		["show", "thread", "tweet_001", "--limit", "2", "--json"],
		["show", "dm", "dm_001", "--json"],
		["db", "vacuum", "--json"],
	]) {
		const { stdout } = await runRuntime(runtime, args, {
			cwd: installDir,
			env,
		});
		JSON.parse(stdout);
	}
	for (const [args, expectedCode] of [
		[["unknown-command", "--json"], 2],
		[["search", "tweets", "--unknown-option", "--json"], 2],
		[["backup", "export", "--json"], 2],
		[["show", "tweet", "--json"], 2],
		[["--json"], 2],
		[["dms", "list", "--limit", "-1", "--json"], 1],
		[["show", "tweet", "tweet_001", "--account", "@birdclaw_lab", "--json"], 1],
		[["backup", "import", path.join(tempRoot, "missing-backup"), "--json"], 1],
	]) {
		let failure;
		try {
			await runRuntime(runtime, args, { cwd: installDir, env });
		} catch (error) {
			failure = error;
		}
		if (
			!failure ||
			failure.code !== expectedCode ||
			failure.stdout !== "" ||
			typeof JSON.parse(failure.stderr).error !== "string"
		) {
			throw new Error(
				`${runtime.name}: invalid CLI failure for ${args.join(" ")}`,
			);
		}
	}

	const port = await reserveLoopbackPort();
	const expectedBaseUrl = `http://127.0.0.1:${String(port)}`;
	const mcpToken = `birdclaw-${runtime.name}-smoke-token-0123456789-abcdef`;
	const serverEnv = {
		...env,
		BIRDCLAW_MCP_PUBLIC_URL: `${expectedBaseUrl}/mcp`,
		BIRDCLAW_MCP_TOKEN: mcpToken,
	};
	const child = spawnRuntime(
		runtime,
		["serve", "--host", "127.0.0.1", "--port", String(port), "--json"],
		{
			cwd: installDir,
			env: serverEnv,
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let shutdownError;
	try {
		const baseUrl = await waitForServer(child, runtime.name);
		if (baseUrl !== expectedBaseUrl) {
			throw new Error(
				`${runtime.name}: server listened at unexpected URL ${baseUrl}`,
			);
		}
		const page = await fetch(baseUrl);
		if (!page.ok || !(await page.text()).toLowerCase().includes("birdclaw")) {
			throw new Error(
				`${runtime.name}: production SSR smoke failed with ${String(page.status)}`,
			);
		}
		const asset = await fetch(`${baseUrl}/favicon.ico`);
		if (!asset.ok) {
			throw new Error(
				`${runtime.name}: static asset smoke failed with ${String(asset.status)}`,
			);
		}
		const sourceResponse = await fetch(`${baseUrl}/api/data-sources`);
		const sources = sourceResponse.ok ? await sourceResponse.json() : null;
		if (
			!sources?.sources.some(
				(source) => source.source === "birdclaw" && source.works,
			) ||
			!sources.sources.some(
				(source) => source.source === "bird" && !source.works,
			) ||
			!sources.capabilities.some(
				(capability) =>
					capability.key === "dms" &&
					capability.notes.includes("bird is optional"),
			)
		)
			throw new Error(
				`${runtime.name}: data-source status failed without Bird`,
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
			name: `birdclaw-package-smoke-${runtime.name}`,
			version: "1.0.0",
		});
		try {
			await withTimeout("MCP initialize", client.connect(transport));
			const serverVersion = client.getServerVersion();
			if (serverVersion?.version !== manifest.version) {
				throw new Error(
					`${runtime.name}: unexpected MCP server version ${JSON.stringify(serverVersion)}`,
				);
			}
			if (transport.sessionId !== undefined) {
				throw new Error(
					`${runtime.name}: stateless MCP returned session ${transport.sessionId}`,
				);
			}
			const listed = await withTimeout("MCP tools/list", client.listTools());
			const toolNames = listed.tools.map((tool) => tool.name);
			if (
				JSON.stringify(toolNames) !==
				JSON.stringify(["search_tweets", "get_tweet_thread"])
			) {
				throw new Error(
					`${runtime.name}: unexpected MCP tools ${JSON.stringify(toolNames)}`,
				);
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
					`${runtime.name}: unexpected MCP result ${JSON.stringify(result)}`,
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
					`${runtime.name}: server did not preserve SIGTERM (${JSON.stringify(exit)})`,
				);
			}
		}
	}
	if (shutdownError) throw shutdownError;
	const birdless = await smokeWithoutBird({
		directory: path.join(tempRoot, `birdless-${runtime.name}`),
		runCli: (args, env) => runRuntime(runtime, args, { cwd: installDir, env }),
	});
	const nativeDms = await smokeNativeDms({
		directory: path.join(tempRoot, `native-dms-${runtime.name}`),
		entry: runtime.prefix.at(-1),
		runFixture: (launcher, args, env) =>
			runRuntime(
				{ ...runtime, prefix: [...runtime.prefix.slice(0, -1), launcher] },
				args,
				{ cwd: installDir, env },
			),
	});

	return {
		name: runtime.name,
		executable: runtime.executable,
		entry: runtime.prefix.at(-1),
		versionMs: Math.round(versionMs),
		installedRoot,
		birdless,
		nativeDms,
	};
}

try {
	const { stdout: bunRevision } = await run(bunBin, ["--revision"]);
	if (!bunRevision.trim().startsWith("1.4.0-canary.1+")) {
		throw new Error(`Unexpected Bun revision: ${bunRevision}`);
	}
	const { stdout: nodeVersionOutput } = await run(nodeBin, ["--version"]);
	const { stdout: nodeExecutablePath } = await run(nodeBin, [
		"-p",
		"process.execPath",
	]);
	const nodeVersion = nodeVersionOutput.trim();
	const nodeMatch = nodeVersion.match(/^v26\.(\d+)\.(\d+)$/);
	if (
		!nodeMatch ||
		Number(nodeMatch[1]) < 5 ||
		(Number(nodeMatch[1]) === 5 && Number(nodeMatch[2]) < 1)
	) {
		throw new Error(
			`Node compatibility smoke requires >=26.5.1 <27, got ${nodeVersion}`,
		);
	}
	const nodeToolEnv = { ...process.env };
	if (path.isAbsolute(nodeBin)) {
		nodeToolEnv.PATH = `${path.dirname(nodeBin)}:${nodeToolEnv.PATH ?? ""}`;
	}

	await run(bunBin, ["--no-env-file", "run", "--bun", "build"], {
		cwd: root,
	});
	const npmPackDir = path.join(tempRoot, "pack-npm");
	const bunPackDir = path.join(tempRoot, "pack-bun");
	await mkdir(npmPackDir, { recursive: true });
	await mkdir(bunPackDir, { recursive: true });
	await run(
		"npm",
		["pack", "--ignore-scripts", "--pack-destination", npmPackDir],
		{
			cwd: root,
			env: nodeToolEnv,
		},
	);
	await run(
		bunBin,
		[
			"--no-env-file",
			"pm",
			"pack",
			"--ignore-scripts",
			"--destination",
			bunPackDir,
		],
		{ cwd: root },
	);
	const npmTarballName = (await readdir(npmPackDir)).find((name) =>
		name.endsWith(".tgz"),
	);
	const bunTarballName = (await readdir(bunPackDir)).find((name) =>
		name.endsWith(".tgz"),
	);
	if (!npmTarballName || !bunTarballName) {
		throw new Error("Package smoke did not create both npm and Bun tarballs");
	}
	const npmTarball = path.join(npmPackDir, npmTarballName);
	const bunTarball = path.join(bunPackDir, bunTarballName);
	const npmFiles = (await run("tar", ["-tzf", npmTarball])).stdout
		.trim()
		.split("\n")
		.sort();
	const bunFiles = (await run("tar", ["-tzf", bunTarball])).stdout
		.trim()
		.split("\n")
		.sort();
	if (JSON.stringify(npmFiles) !== JSON.stringify(bunFiles)) {
		throw new Error("npm pack and bun pm pack produced different file lists");
	}
	for (const required of [
		"package/bin/birdclaw.mjs",
		"package/dist/cli/birdclaw.js",
		"package/dist/server/server.js",
	]) {
		if (!npmFiles.includes(required))
			throw new Error(`Tarball missing ${required}`);
	}
	for (const forbidden of [
		"package/src/",
		"package/scripts/",
		"package/toolchains/",
		"tsx",
	]) {
		if (npmFiles.some((file) => file.includes(forbidden))) {
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
		["install", "--ignore-scripts", "--no-audit", "--no-fund", npmTarball],
		{ cwd: installDir, env: nodeToolEnv },
	);
	const installedRoot = path.join(installDir, "node_modules", "birdclaw");
	const manifest = JSON.parse(
		await readFile(path.join(installedRoot, "package.json"), "utf8"),
	);
	if (manifest.dependencies?.tsx || manifest.dependencies?.vite) {
		throw new Error("Installed runtime dependencies include tsx or vite");
	}
	const launcher = path.join(installedRoot, "bin", "birdclaw.mjs");
	const bin = path.join(installDir, "node_modules", ".bin", "birdclaw");
	const normalBinEnv = {
		...nodeToolEnv,
		BIRDCLAW_HOME: path.join(tempRoot, "home-bin"),
	};
	const { stdout: normalBinVersion } = await run(bin, ["--version"], {
		cwd: installDir,
		env: normalBinEnv,
	});
	if (normalBinVersion.trim() !== manifest.version) {
		throw new Error(`Installed Node shebang returned ${normalBinVersion}`);
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
	const runtimes = [
		{
			name: "bun",
			executable: bunBin,
			prefix: ["--no-env-file", launcher],
		},
		{
			name: "node",
			executable: nodeExecutablePath.trim(),
			prefix: [launcher],
		},
	];
	const runtimeResults = [];
	for (const runtime of runtimes) {
		runtimeResults.push(
			await smokeRuntime({
				runtime,
				manifest,
				installedRoot,
				installDir,
				Client,
				StreamableHTTPClientTransport,
			}),
		);
	}

	const result = {
		ok: true,
		files: npmFiles.length,
		nodeVersion,
		bunRevision: bunRevision.trim(),
		npmTarball: {
			name: npmTarballName,
			sha256: await sha256(npmTarball),
		},
		bunTarball: {
			name: bunTarballName,
			sha256: await sha256(bunTarball),
		},
		runtimes: runtimeResults,
	};
	if (jsonOutput) {
		console.log(JSON.stringify(result, null, 2));
	} else {
		const runtimeTimings = Object.fromEntries(
			runtimeResults.map((runtime) => [runtime.name, runtime.versionMs]),
		);
		console.log(
			`Package smoke passed: ${String(result.files)} files, Node ${runtimeTimings.node}ms, Bun ${runtimeTimings.bun}ms`,
		);
	}
} finally {
	if (process.env.BIRDCLAW_KEEP_PACKAGE_SMOKE === "1") {
		console.error(`Package smoke workspace retained at ${tempRoot}`);
	} else {
		await rm(tempRoot, { recursive: true, force: true });
	}
}
