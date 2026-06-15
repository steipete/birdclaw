const DEFAULT_MAX_ENTRIES = 100;

interface ClientCacheEntry<T> {
	value: T;
	updatedAt: number;
}

interface LoadClientCacheOptions {
	force?: boolean;
	maxAgeMs?: number;
}

const values = new Map<string, ClientCacheEntry<unknown>>();
const pending = new Map<string, Promise<unknown>>();
const revisions = new Map<string, number>();
let generation = 0;

function cacheToken(key: string) {
	return `${String(generation)}:${String(revisions.get(key) ?? 0)}`;
}

function invalidateKey(key: string) {
	revisions.set(key, (revisions.get(key) ?? 0) + 1);
}

function pruneCache() {
	while (values.size > DEFAULT_MAX_ENTRIES) {
		const oldestKey = values.keys().next().value as string | undefined;
		if (!oldestKey) return;
		values.delete(oldestKey);
	}
}

export function readClientCache<T>(
	key: string,
	maxAgeMs = Number.POSITIVE_INFINITY,
) {
	const entry = values.get(key) as ClientCacheEntry<T> | undefined;
	if (!entry) return undefined;
	if (Date.now() - entry.updatedAt > maxAgeMs) {
		values.delete(key);
		return undefined;
	}
	return entry.value;
}

export function writeClientCache<T>(key: string, value: T) {
	values.delete(key);
	values.set(key, { value, updatedAt: Date.now() });
	pruneCache();
	return value;
}

export function loadClientCache<T>(
	key: string,
	load: () => Promise<T>,
	{
		force = false,
		maxAgeMs = Number.POSITIVE_INFINITY,
	}: LoadClientCacheOptions = {},
) {
	if (force) {
		invalidateKey(key);
		values.delete(key);
		pending.delete(key);
	} else {
		const cached = readClientCache<T>(key, maxAgeMs);
		if (cached !== undefined) return Promise.resolve(cached);
	}

	const active = pending.get(key) as Promise<T> | undefined;
	if (active) return active;

	const token = cacheToken(key);
	let request: Promise<T>;
	request = load()
		.then((value) => {
			if (cacheToken(key) === token) writeClientCache(key, value);
			return value;
		})
		.finally(() => {
			if (pending.get(key) === request) pending.delete(key);
		});
	pending.set(key, request);
	return request;
}

export function deleteClientCache(key: string) {
	invalidateKey(key);
	values.delete(key);
	pending.delete(key);
}

export function deleteClientCacheByPrefix(prefix: string) {
	const keys = new Set([...values.keys(), ...pending.keys()]);
	for (const key of keys) {
		if (!key.startsWith(prefix)) continue;
		invalidateKey(key);
		values.delete(key);
		pending.delete(key);
	}
}

export function clearClientCache() {
	generation += 1;
	values.clear();
	pending.clear();
	revisions.clear();
}
