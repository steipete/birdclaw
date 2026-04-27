import {
	accessSync,
	constants,
	existsSync,
	mkdirSync,
	readFileSync,
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

export type MentionsDataSource = "birdclaw" | "xurl" | "bird";
export type ActionsTransport = "auto" | "bird" | "xurl";

export interface BirdclawConfig {
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

export function resolveMentionsDataSource(
	requestedMode?: string,
): MentionsDataSource {
	if (
		requestedMode === "birdclaw" ||
		requestedMode === "xurl" ||
		requestedMode === "bird"
	) {
		return requestedMode;
	}

	const envMode = process.env.BIRDCLAW_MENTIONS_DATA_SOURCE?.trim();
	if (envMode === "birdclaw" || envMode === "xurl" || envMode === "bird") {
		return envMode;
	}

	const configMode = getBirdclawConfig().mentions?.dataSource;
	if (
		configMode === "birdclaw" ||
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

	return path.join(os.homedir(), "Projects", "bird", "bird");
}

export function ensureBirdclawDirs(): BirdclawPaths {
	const paths = getBirdclawPaths();

	mkdirSync(paths.rootDir, { recursive: true });
	mkdirSync(paths.mediaOriginalsDir, { recursive: true });
	mkdirSync(paths.mediaThumbsDir, { recursive: true });

	return paths;
}

export function resetBirdclawPathsForTests() {
	cachedPaths = undefined;
	cachedConfig = undefined;
}
