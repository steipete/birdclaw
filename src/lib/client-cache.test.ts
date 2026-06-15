import { afterEach, describe, expect, it, vi } from "vitest";
import {
	clearClientCache,
	deleteClientCacheByPrefix,
	loadClientCache,
	readClientCache,
	writeClientCache,
} from "./client-cache";

describe("client cache", () => {
	afterEach(() => {
		clearClientCache();
		vi.useRealTimers();
	});

	it("returns fresh values and expires stale entries", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-06-15T00:00:00.000Z"));
		writeClientCache("status", { ok: true });

		expect(readClientCache("status", 1_000)).toEqual({ ok: true });
		vi.advanceTimersByTime(1_001);
		expect(readClientCache("status", 1_000)).toBeUndefined();
	});

	it("deduplicates concurrent loads", async () => {
		let resolveLoad: ((value: string) => void) | undefined;
		const load = vi.fn(
			() =>
				new Promise<string>((resolve) => {
					resolveLoad = resolve;
				}),
		);

		const first = loadClientCache("timeline", load);
		const second = loadClientCache("timeline", load);
		resolveLoad?.("ready");

		await expect(first).resolves.toBe("ready");
		await expect(second).resolves.toBe("ready");
		expect(load).toHaveBeenCalledTimes(1);
	});

	it("starts a new generation for forced loads", async () => {
		const resolvers: Array<(value: string) => void> = [];
		const load = vi.fn(
			() =>
				new Promise<string>((resolve) => {
					resolvers.push(resolve);
				}),
		);

		const stale = loadClientCache("status", load);
		const fresh = loadClientCache("status", load, { force: true });
		expect(load).toHaveBeenCalledTimes(2);

		resolvers[0]?.("stale");
		await expect(stale).resolves.toBe("stale");
		expect(readClientCache("status")).toBeUndefined();

		resolvers[1]?.("fresh");
		await expect(fresh).resolves.toBe("fresh");
		expect(readClientCache("status")).toBe("fresh");
	});

	it("invalidates related entries by prefix", () => {
		writeClientCache("timeline:home", 1);
		writeClientCache("timeline:mentions", 2);
		writeClientCache("status", 3);

		deleteClientCacheByPrefix("timeline:");

		expect(readClientCache("timeline:home")).toBeUndefined();
		expect(readClientCache("timeline:mentions")).toBeUndefined();
		expect(readClientCache("status")).toBe(3);
	});
});
