// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileAsyncMock = vi.fn();
const execFile = vi.fn();
Object.defineProperty(execFile, Symbol.for("nodejs.util.promisify.custom"), {
	value: execFileAsyncMock,
});

vi.mock("node:child_process", () => ({
	execFile,
}));

describe("xurl transport wrapper", () => {
	beforeEach(() => {
		vi.resetModules();
		execFile.mockReset();
		execFileAsyncMock.mockReset();
	});

	it("falls back to local mode when xurl is missing", async () => {
		execFileAsyncMock.mockRejectedValue(new Error("missing"));
		const { getTransportStatus } = await import("./xurl");

		const result = await getTransportStatus();

		expect(result.availableTransport).toBe("local");
		expect(result.installed).toBe(false);
	});

	it("reports xurl auth state when available", async () => {
		execFileAsyncMock
			.mockResolvedValueOnce({ stdout: "xurl 1.0", stderr: "" })
			.mockResolvedValueOnce({ stdout: "ok", stderr: "" });
		const { getTransportStatus } = await import("./xurl");

		const result = await getTransportStatus();

		expect(result).toMatchObject({
			installed: true,
			availableTransport: "xurl",
			rawStatus: "ok",
		});
		expect(execFileAsyncMock).toHaveBeenNthCalledWith(1, "xurl", ["version"]);
	});

	it("falls back to local mode when xurl auth is broken", async () => {
		execFileAsyncMock
			.mockResolvedValueOnce({ stdout: "xurl 1.0", stderr: "" })
			.mockRejectedValueOnce(new Error("auth unavailable"));
		const { getTransportStatus } = await import("./xurl");

		const result = await getTransportStatus();

		expect(result.installed).toBe(true);
		expect(result.availableTransport).toBe("local");
		expect(result.statusText).toContain("auth unavailable");
	});

	it("looks up users and the authenticated account via raw json endpoints", async () => {
		execFileAsyncMock
			.mockResolvedValueOnce({
				stdout: JSON.stringify({ data: [{ id: "42", username: "sam" }] }),
				stderr: "",
			})
			.mockResolvedValueOnce({
				stdout: JSON.stringify({ data: { id: "1", username: "steipete" } }),
				stderr: "",
			});
		const { lookupAuthenticatedUser, lookupUsersByIds } = await import(
			"./xurl"
		);

		await expect(lookupUsersByIds(["42"])).resolves.toEqual([
			{ id: "42", username: "sam" },
		]);
		await expect(lookupAuthenticatedUser()).resolves.toEqual({
			id: "1",
			username: "steipete",
		});
	});

	it("returns an empty user list when asked to hydrate nothing", async () => {
		const { lookupUsersByIds } = await import("./xurl");

		await expect(lookupUsersByIds([])).resolves.toEqual([]);
		expect(execFileAsyncMock).not.toHaveBeenCalled();
	});

	it("formats dm handles with @", async () => {
		execFileAsyncMock.mockResolvedValue({ stdout: "", stderr: "sent" });
		const { dmViaXurl } = await import("./xurl");

		const result = await dmViaXurl("sam", "hello");

		expect(execFileAsyncMock).toHaveBeenCalledWith("xurl", [
			"dm",
			"@sam",
			"hello",
		]);
		expect(result).toEqual({ ok: true, output: "sent" });
	});

	it("passes through existing @ handles and reports shortcut failures", async () => {
		execFileAsyncMock.mockRejectedValue(new Error("bad shortcut"));
		const { dmViaXurl, postViaXurl, replyViaXurl } = await import("./xurl");

		await expect(dmViaXurl("@sam", "hello")).resolves.toEqual({
			ok: false,
			output: "bad shortcut",
		});
		await expect(postViaXurl("ship")).resolves.toEqual({
			ok: false,
			output: "bad shortcut",
		});
		await expect(replyViaXurl("tweet_1", "reply")).resolves.toEqual({
			ok: false,
			output: "bad shortcut",
		});
		expect(execFileAsyncMock).toHaveBeenCalledWith("xurl", [
			"dm",
			"@sam",
			"hello",
		]);
	});
});
