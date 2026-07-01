process.env.BIRDCLAW_DISABLE_LIVE_WRITES ??= "1";

export {};

function installMemoryStorage(
	target: object,
	key: "localStorage" | "sessionStorage",
) {
	const store = new Map<string, string>();
	const memoryStorage = {
		getItem(key: string) {
			return store.has(key) ? (store.get(key) ?? null) : null;
		},
		setItem(key: string, value: string) {
			store.set(key, String(value));
		},
		removeItem(key: string) {
			store.delete(key);
		},
		clear() {
			store.clear();
		},
		key(index: number) {
			return Array.from(store.keys())[index] ?? null;
		},
		get length() {
			return store.size;
		},
	};

	Object.defineProperty(target, key, {
		configurable: true,
		value: memoryStorage,
	});
}

installMemoryStorage(globalThis, "localStorage");
installMemoryStorage(globalThis, "sessionStorage");

if (typeof window !== "undefined") {
	installMemoryStorage(window, "localStorage");
	installMemoryStorage(window, "sessionStorage");
}

await import("@testing-library/jest-dom/vitest");
