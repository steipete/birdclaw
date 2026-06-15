import { useEffect } from "react";
import { avatarPath } from "./AvatarChip";

const MAX_CONCURRENT_PRELOADS = 4;
const IDLE_TIMEOUT_MS = 2500;

const queuedSources: string[] = [];
const knownSources = new Set<string>();
const activeImages = new Set<HTMLImageElement>();

let activePreloads = 0;
let listeningForLoad = false;
let idleId: number | null = null;
let fallbackTimerId: number | null = null;

function finishPreload(image: HTMLImageElement) {
	if (!activeImages.delete(image)) return;
	activePreloads -= 1;
	drainPreloads();
}

function drainPreloads() {
	while (activePreloads < MAX_CONCURRENT_PRELOADS && queuedSources.length > 0) {
		const src = queuedSources.shift();
		if (!src) return;

		const image = new Image();
		activePreloads += 1;
		activeImages.add(image);
		image.decoding = "async";
		image.onerror = () => finishPreload(image);
		image.onload = () => {
			if (typeof image.decode !== "function") {
				finishPreload(image);
				return;
			}
			void image
				.decode()
				.catch(() => undefined)
				.finally(() => finishPreload(image));
		};
		image.src = src;
	}
}

function runIdlePreloads() {
	idleId = null;
	fallbackTimerId = null;
	drainPreloads();
}

function scheduleIdlePreloads() {
	if (
		queuedSources.length === 0 ||
		idleId !== null ||
		fallbackTimerId !== null
	) {
		return;
	}

	const requestIdle = window.requestIdleCallback?.bind(window);
	if (requestIdle) {
		idleId = requestIdle(runIdlePreloads, {
			timeout: IDLE_TIMEOUT_MS,
		});
		return;
	}

	fallbackTimerId = window.setTimeout(runIdlePreloads, 0);
}

function handleWindowLoad() {
	listeningForLoad = false;
	scheduleIdlePreloads();
}

function scheduleAfterPageLoad() {
	if (document.readyState === "complete") {
		scheduleIdlePreloads();
		return;
	}
	if (listeningForLoad) return;
	listeningForLoad = true;
	window.addEventListener("load", handleWindowLoad, { once: true });
}

function queueAvatarPreload(profileId?: string, avatarUrl?: string) {
	if (!profileId || !avatarUrl || typeof window === "undefined") return;
	const src = avatarPath(profileId, avatarUrl);
	if (knownSources.has(src)) return;
	knownSources.add(src);
	queuedSources.push(src);
	scheduleAfterPageLoad();
}

export function useAvatarPreload(profileId?: string, avatarUrl?: string) {
	useEffect(() => {
		queueAvatarPreload(profileId, avatarUrl);
	}, [avatarUrl, profileId]);
}

function resetPreloader() {
	if (listeningForLoad) {
		window.removeEventListener("load", handleWindowLoad);
	}
	if (idleId !== null && "cancelIdleCallback" in window) {
		window.cancelIdleCallback(idleId);
	}
	if (fallbackTimerId !== null) {
		window.clearTimeout(fallbackTimerId);
	}
	for (const image of activeImages) {
		image.onload = null;
		image.onerror = null;
	}
	queuedSources.length = 0;
	knownSources.clear();
	activeImages.clear();
	activePreloads = 0;
	listeningForLoad = false;
	idleId = null;
	fallbackTimerId = null;
}

export const __test__ = {
	queueAvatarPreload,
	resetPreloader,
};
