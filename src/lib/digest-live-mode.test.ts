// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	defaultDigestLiveSyncMode,
	parseDigestLiveSyncMode,
} from "./digest-live-mode";

describe("digest live mode", () => {
	let previous: string | undefined;

	beforeEach(() => {
		previous = process.env.BIRDCLAW_DIGEST_LIVE_MODE;
	});

	afterEach(() => {
		delete process.env.BIRDCLAW_PREFERRED_TRANSPORT;
		if (previous === undefined) {
			delete process.env.BIRDCLAW_DIGEST_LIVE_MODE;
		} else {
			process.env.BIRDCLAW_DIGEST_LIVE_MODE = previous;
		}
	});

	it("uses global preference through auto while keeping explicit digest overrides", () => {
		delete process.env.BIRDCLAW_DIGEST_LIVE_MODE;
		process.env.BIRDCLAW_PREFERRED_TRANSPORT = "bird";
		expect(defaultDigestLiveSyncMode()).toBe("auto");
		process.env.BIRDCLAW_DIGEST_LIVE_MODE = "xurl";
		expect(defaultDigestLiveSyncMode()).toBe("xurl");
		expect(parseDigestLiveSyncMode("bird")).toBe("bird");
	});

	it("defaults to xurl when the env var is unset", () => {
		delete process.env.BIRDCLAW_DIGEST_LIVE_MODE;
		expect(defaultDigestLiveSyncMode()).toBe("xurl");
		expect(parseDigestLiveSyncMode(null)).toBe("xurl");
		expect(parseDigestLiveSyncMode(undefined)).toBe("xurl");
	});

	it.each(["auto", "bird", "xurl"])(
		"honors and normalizes the %s env default",
		(mode) => {
			process.env.BIRDCLAW_DIGEST_LIVE_MODE = ` ${mode.toUpperCase()} `;
			expect(defaultDigestLiveSyncMode()).toBe(mode);
			expect(parseDigestLiveSyncMode(null)).toBe(mode);
		},
	);

	it("falls back to xurl for an invalid env value", () => {
		process.env.BIRDCLAW_DIGEST_LIVE_MODE = "pigeon";
		expect(defaultDigestLiveSyncMode()).toBe("xurl");
	});

	it("parses explicit values case-insensitively", () => {
		process.env.BIRDCLAW_DIGEST_LIVE_MODE = "bird";
		expect(parseDigestLiveSyncMode("xurl")).toBe("xurl");
		expect(parseDigestLiveSyncMode(" Auto ")).toBe("auto");
		expect(parseDigestLiveSyncMode("smoke-signals")).toBe("bird");
	});
});
