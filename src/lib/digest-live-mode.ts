import { defaultLiveSyncMode } from "./config";
import type { LiveSyncMode } from "./live-sync-engine";

export function defaultDigestLiveSyncMode(): LiveSyncMode {
	const raw = (
		process.env.BIRDCLAW_DIGEST_LIVE_MODE ?? defaultLiveSyncMode("xurl")
	)
		.trim()
		.toLowerCase();
	if (raw === "auto" || raw === "bird" || raw === "xurl") {
		return raw;
	}
	return defaultLiveSyncMode("xurl");
}

export function parseDigestLiveSyncMode(
	value: string | null | undefined,
): LiveSyncMode {
	if (value === null || value === undefined) {
		return defaultDigestLiveSyncMode();
	}
	const normalized = value.trim().toLowerCase();
	if (normalized === "auto" || normalized === "bird" || normalized === "xurl") {
		return normalized;
	}
	return defaultDigestLiveSyncMode();
}
