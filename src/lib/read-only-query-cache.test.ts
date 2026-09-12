// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NativeSqliteDatabase } from "./sqlite";
import { ReadOnlyQueryCache } from "./read-only-query-cache";

let dir: string;
let writer: NativeSqliteDatabase;
let reader: NativeSqliteDatabase;
beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "birdclaw-query-cache-"));
	const file = path.join(dir, "archive.sqlite");
	writer = new NativeSqliteDatabase(file);
	writer.exec(
		"create table sample (value text); insert into sample values ('before')",
	);
	reader = new NativeSqliteDatabase(file, { readonly: true });
});
afterEach(() => {
	reader.close();
	writer.close();
	rmSync(dir, { recursive: true, force: true });
});
const read = () =>
	JSON.stringify(reader.prepare("select value from sample").get());

describe("read-only query cache", () => {
	it("reuses serialized reads and invalidates after an external writer commits", () => {
		const cache = new ReadOnlyQueryCache();
		const produce = vi.fn(read);
		expect(cache.read(reader, "home:demo", produce)).toContain("before");
		expect(cache.read(reader, "home:demo", produce)).toContain("before");
		expect(produce).toHaveBeenCalledTimes(1);
		writer.exec("update sample set value = 'after'");
		expect(cache.read(reader, "home:demo", produce)).toContain("after");
		expect(produce).toHaveBeenCalledTimes(2);
	});
	it("does not retain a value when a writer commits during its production", () => {
		const cache = new ReadOnlyQueryCache();
		const produce = vi.fn(() => {
			const value = read();
			writer.exec("update sample set value = 'after'");
			return value;
		});
		expect(cache.read(reader, "home", produce)).toContain("before");
		expect(cache.read(reader, "home", read)).toContain("after");
	});
	it("separates database connections and account/filter keys", () => {
		const cache = new ReadOnlyQueryCache();
		const other = new NativeSqliteDatabase(":memory:");
		try {
			expect(cache.read(reader, "account-a", () => "a")).toBe("a");
			expect(cache.read(reader, "account-b", () => "b")).toBe("b");
			expect(cache.read(other, "account-a", () => "other")).toBe("other");
		} finally {
			other.close();
		}
	});
	it("evicts least-recently-used entries at the count bound", () => {
		const cache = new ReadOnlyQueryCache({
			entries: 2,
			bytes: 100,
			entryBytes: 50,
			keyBytes: 20,
		});
		const produce = vi.fn(() => "value");
		cache.read(reader, "a", produce);
		cache.read(reader, "b", produce);
		cache.read(reader, "a", produce);
		cache.read(reader, "c", produce);
		cache.read(reader, "a", produce);
		cache.read(reader, "b", produce);
		expect(produce).toHaveBeenCalledTimes(4);
	});
	it("bounds encoded keys and values including multi-byte text", () => {
		const cache = new ReadOnlyQueryCache({
			entries: 20,
			bytes: 10,
			entryBytes: 10,
			keyBytes: 3,
		});
		const produce = vi.fn(() => "éé");
		cache.read(reader, "a", produce);
		cache.read(reader, "b", produce);
		cache.read(reader, "c", produce);
		cache.read(reader, "a", produce);
		expect(produce).toHaveBeenCalledTimes(4);
		const large = vi.fn(() => "é".repeat(6));
		cache.read(reader, "x", large);
		cache.read(reader, "x", large);
		expect(large).toHaveBeenCalledTimes(2);
		cache.read(reader, "large-key", produce);
		cache.read(reader, "large-key", produce);
		expect(produce).toHaveBeenCalledTimes(6);
	});
	it("does not cache exceptions", () => {
		const cache = new ReadOnlyQueryCache();
		expect(() =>
			cache.read(reader, "a", () => {
				throw Error("invalid");
			}),
		).toThrow("invalid");
		expect(cache.read(reader, "a", () => "valid")).toBe("valid");
	});
});
