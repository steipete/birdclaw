import {
	accessSync,
	constants,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

export interface BirdclawPaths {
	rootDir: string;
	dbPath: string;
	mediaOriginalsDir: string;
	mediaThumbsDir: string;
	configPath: string;
}

export type MentionsDataSource = "birdclaw" | "auto" | "xurl" | "bird";
export type ActionsTransport = "auto" | "bird" | "xurl";
export type LiveTransport = "bird" | "xurl";

export function isReadOnlyDeployment() {
	return process.env.BIRDCLAW_DEPLOYMENT_READ_ONLY === "1";
}

export function assertWritableDeployment() {
	if (isReadOnlyDeployment()) {
		throw new Error("This archive deployment is read-only");
	}
}

export interface BirdclawConfig {
	transport?: {
		preferred?: LiveTransport;
	};
	accounts?: {
		default?: string;
	};
	mentions?: {
		dataSource?: MentionsDataSource;
		birdCommand?: string;
	};
	actions?: {
		transport?: ActionsTransport;
	};
	backup?: {
		repoPath?: string;
		remote?: string;
		autoSync?: boolean;
		staleAfterSeconds?: number;
	};
}

export function getPreferredTransport(): LiveTransport | undefined {
	const envPreferred =
		process.env.BIRDCLAW_PREFERRED_TRANSPORT?.trim().toLowerCase();
	if (envPreferred === "bird" || envPreferred === "xurl") return envPreferred;
	const preferred = getBirdclawConfig().transport?.preferred;
	if (preferred === "bird" || preferred === "xurl") return preferred;
	return undefined;
}

export function getAutoTransportOrder(
	defaultPrimary: LiveTransport = "xurl",
): readonly [LiveTransport, LiveTransport] {
	const primary = getPreferredTransport() ?? defaultPrimary;
	return [primary, primary === "bird" ? "xurl" : "bird"];
}

export function defaultLiveSyncMode(
	defaultMode: ActionsTransport,
): ActionsTransport {
	return getPreferredTransport() ? "auto" : defaultMode;
}

export function autoTransportCacheSuffix(mode: string) {
	const preferred = mode === "auto" ? getPreferredTransport() : undefined;
	return preferred ? `:preferred:${preferred}` : "";
}

export function setPreferredTransport(preferred: LiveTransport | "auto") {
	const config = getBirdclawConfig();
	const transport = { ...config.transport };
	if (preferred === "auto") delete transport.preferred;
	else transport.preferred = preferred;
	const configPath = writeBirdclawConfig({ ...config, transport });
	return { configPath, preferred: transport.preferred ?? null };
}

export function getDefaultAccountSelector() {
	const selector = getBirdclawConfig().accounts?.default?.trim();
	return selector || undefined;
}

let cachedPaths: BirdclawPaths | undefined;
let cachedConfig: BirdclawConfig | undefined;

export function getBirdclawPaths(): BirdclawPaths {
	if (cachedPaths) {
		return cachedPaths;
	}

	const rootDir =
		process.env.BIRDCLAW_HOME?.trim() || path.join(os.homedir(), ".birdclaw");

	cachedPaths = {
		rootDir,
		dbPath: path.join(rootDir, "birdclaw.sqlite"),
		mediaOriginalsDir: path.join(rootDir, "media", "originals"),
		mediaThumbsDir: path.join(rootDir, "media", "thumbs"),
		configPath: path.join(rootDir, "config.json"),
	};

	return cachedPaths;
}

function parseConfigFile(configPath: string): BirdclawConfig {
	if (!existsSync(configPath)) {
		return {};
	}

	const raw = readFileSync(configPath, "utf8").trim();
	if (!raw) {
		return {};
	}

	const parsed = JSON.parse(raw) as BirdclawConfig;
	return parsed && typeof parsed === "object" ? parsed : {};
}

export function getBirdclawConfig(): BirdclawConfig {
	if (cachedConfig) {
		return cachedConfig;
	}

	const configPath =
		process.env.BIRDCLAW_CONFIG?.trim() || getBirdclawPaths().configPath;
	cachedConfig = parseConfigFile(configPath);
	return cachedConfig;
}

function getConfigPath() {
	return process.env.BIRDCLAW_CONFIG?.trim() || getBirdclawPaths().configPath;
}

export function writeBirdclawConfig(config: BirdclawConfig) {
	assertWritableDeployment();
	const configPath = getConfigPath();
	mkdirSync(path.dirname(configPath), { recursive: true });
	writeFileSync(configPath, `${JSON.stringify(config, null, "\t")}\n`, "utf8");
	cachedConfig = config;
	return configPath;
}

export function setActionsTransport(transport: ActionsTransport) {
	const config = getBirdclawConfig();
	const nextConfig: BirdclawConfig = {
		...config,
		actions: {
			...config.actions,
			transport,
		},
	};
	const configPath = writeBirdclawConfig(nextConfig);
	return { configPath, transport };
}

export function resolveMentionsDataSource(
	requestedMode?: string,
): MentionsDataSource {
	if (
		requestedMode === "birdclaw" ||
		requestedMode === "auto" ||
		requestedMode === "xurl" ||
		requestedMode === "bird"
	) {
		return requestedMode;
	}

	const envMode = process.env.BIRDCLAW_MENTIONS_DATA_SOURCE?.trim();
	if (
		envMode === "birdclaw" ||
		envMode === "auto" ||
		envMode === "xurl" ||
		envMode === "bird"
	) {
		return envMode;
	}

	const configMode = getBirdclawConfig().mentions?.dataSource;
	if (
		configMode === "birdclaw" ||
		configMode === "auto" ||
		configMode === "xurl" ||
		configMode === "bird"
	) {
		return configMode;
	}

	return "birdclaw";
}

export function resolveActionsTransport(
	requestedMode?: string,
): ActionsTransport {
	if (
		requestedMode === "auto" ||
		requestedMode === "bird" ||
		requestedMode === "xurl"
	) {
		return requestedMode;
	}

	const envMode = process.env.BIRDCLAW_ACTIONS_TRANSPORT?.trim();
	if (envMode === "auto" || envMode === "bird" || envMode === "xurl") {
		return envMode;
	}

	const configMode = getBirdclawConfig().actions?.transport;
	if (configMode === "auto" || configMode === "bird" || configMode === "xurl") {
		return configMode;
	}

	return "auto";
}

function findCommandOnPath(command: string) {
	const pathValue = process.env.PATH;
	if (!pathValue) {
		return undefined;
	}

	for (const directory of pathValue.split(path.delimiter)) {
		if (!directory) {
			continue;
		}
		const candidate = path.join(directory, command);
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			continue;
		}
	}

	return undefined;
}

export function getBirdCommand() {
	const envCommand = process.env.BIRDCLAW_BIRD_COMMAND?.trim();
	if (envCommand) {
		return envCommand;
	}

	const configuredCommand = getBirdclawConfig().mentions?.birdCommand?.trim();
	if (configuredCommand) {
		return configuredCommand;
	}

	const pathCommand = findCommandOnPath("bird");
	if (pathCommand) {
		return pathCommand;
	}

	return "bird";
}

export function ensureBirdclawDirs(): BirdclawPaths {
	const paths = getBirdclawPaths();
	if (isReadOnlyDeployment()) return paths;

	mkdirSync(paths.rootDir, { recursive: true });
	mkdirSync(paths.mediaOriginalsDir, { recursive: true });
	mkdirSync(paths.mediaThumbsDir, { recursive: true });

	return paths;
}

export function resetBirdclawPathsForTests() {
	cachedPaths = undefined;
	cachedConfig = undefined;
}
