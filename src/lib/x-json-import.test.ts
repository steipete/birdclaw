// @vitest-environment node
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runCliMain } from "../cli";
import { exportBackup, importBackup } from "./backup";
import { listTimelineItems } from "./timeline-read-model";
import { importXJsonText } from "./x-json-import";
import { useTestHome } from "../test/test-home";

const testHome = useTestHome({
	prefix: "birdclaw-x-json-",
	seedDemoData: false,
});

const SYNTH_AUTHOR = {
	id: "900001",
	username: "synth_lab",
	name: "Synth Lab",
};

function singleTweetResponse(
	overrides: {
		id?: string;
		text?: string;
		url?: string;
	} = {},
) {
	const id = overrides.id ?? "880001";
	return {
		data: {
			id,
			author_id: SYNTH_AUTHOR.id,
			text: overrides.text ?? "synth needle alpha",
			created_at: "2026-03-01T12:00:00.000Z",
			...(overrides.url ? { url: overrides.url } : {}),
		},
		includes: { users: [SYNTH_AUTHOR] },
	};
}

describe("importXJsonText", () => {
	it("imports a single-object data payload with provenance", () => {
		const home = testHome();
		const db = home.db;
		const result = importXJsonText(
			db,
			JSON.stringify(
				singleTweetResponse({
					url: "https://example.test/status/880001",
				}),
			),
		);
		expect(result).toEqual({ imported: 1, skipped: 0, errors: [] });
		expect(
			db.prepare("select id, text from tweets where id = ?").get("880001"),
		).toMatchObject({ id: "880001", text: "synth needle alpha" });
		expect(
			db
				.prepare("select handle from profiles where handle = ?")
				.get("synth_lab"),
		).toEqual({ handle: "synth_lab" });
		expect(
			db
				.prepare(
					"select source, source_url from tweet_sources where tweet_id = ?",
				)
				.get("880001"),
		).toEqual({
			source: "x-json",
			source_url: "https://example.test/status/880001",
		});
		expect(
			db
				.prepare(
					"select tweet_id from tweets_fts where tweets_fts match 'needle'",
				)
				.all(),
		).toEqual([{ tweet_id: "880001" }]);
	});

	it("imports array data with includes users, media, tweets, and note_tweet", () => {
		const home = testHome();
		const db = home.db;
		const payload = {
			data: [
				{
					id: "880010",
					author_id: SYNTH_AUTHOR.id,
					text: "short",
					created_at: "2026-03-01T12:00:00.000Z",
					note_tweet: {
						text: "synth longform needle beta",
						entities: { hashtags: [{ tag: "synth" }] },
					},
					attachments: { media_keys: ["media_1"] },
					referenced_tweets: [{ type: "quoted", id: "880011" }],
				},
			],
			includes: {
				users: [SYNTH_AUTHOR],
				media: [
					{
						media_key: "media_1",
						type: "photo",
						url: "https://example.test/photo.jpg",
					},
				],
				tweets: [
					{
						id: "880011",
						author_id: SYNTH_AUTHOR.id,
						text: "quoted synth context",
						created_at: "2026-03-01T11:00:00.000Z",
					},
				],
			},
		};
		const result = importXJsonText(db, JSON.stringify(payload));
		expect(result.errors).toEqual([]);
		expect(result.imported).toBe(1);
		expect(
			db
				.prepare("select quoted_tweet_id from tweets where id = ?")
				.get("880010"),
		).toEqual({ quoted_tweet_id: "880011" });
		const noteRow = db
			.prepare("select note_tweet_json from tweets where id = ?")
			.get("880010") as { note_tweet_json: string | null } | undefined;
		expect(noteRow?.note_tweet_json).toContain("longform");
		expect(
			listTimelineItems({ resource: "home", search: "longform", limit: 5 }, db),
		).toHaveLength(1);
	});

	it("rejects malformed JSONL lines without ingesting them", () => {
		const home = testHome();
		const db = home.db;
		const good = JSON.stringify(singleTweetResponse({ id: "880020" }));
		const result = importXJsonText(db, `${good}\n{not json}\n`);
		expect(result.imported).toBe(1);
		expect(result.errors).toEqual([
			{ line: 2, message: "Line 2: invalid JSON" },
		]);
		expect(db.prepare("select count(*) as count from tweets").get()).toEqual({
			count: 1,
		});
	});

	it("rejects documents with invalid tweet fields", () => {
		const home = testHome();
		const db = home.db;
		const result = importXJsonText(
			db,
			JSON.stringify({
				data: { id: "880030", author_id: "900001", text: "", created_at: "x" },
			}),
		);
		expect(result.imported).toBe(0);
		expect(result.errors.length).toBeGreaterThan(0);
		expect(db.prepare("select count(*) as count from tweets").get()).toEqual({
			count: 0,
		});
	});

	it("is idempotent on duplicate re-import", () => {
		const home = testHome();
		const db = home.db;
		const input = JSON.stringify(singleTweetResponse({ id: "880040" }));
		expect(importXJsonText(db, input)).toEqual({
			imported: 1,
			skipped: 0,
			errors: [],
		});
		expect(importXJsonText(db, input)).toEqual({
			imported: 0,
			skipped: 1,
			errors: [],
		});
	});

	it("rejects non-numeric author_id without aborting later valid lines", () => {
		const home = testHome();
		const db = home.db;
		const bad = JSON.stringify({
			data: {
				id: "880060",
				author_id: "abc",
				text: "bad author",
				created_at: "2026-03-01T12:00:00.000Z",
			},
		});
		const good = JSON.stringify(singleTweetResponse({ id: "880061" }));
		const result = importXJsonText(db, `${bad}\n${good}`);
		expect(result.imported).toBe(1);
		expect(result.errors).toEqual([
			expect.objectContaining({
				line: 1,
				message: expect.stringContaining("author_id must be a numeric string"),
			}),
		]);
		expect(
			db.prepare("select id from tweets where id = ?").get("880061"),
		).toEqual({ id: "880061" });
		expect(
			db.prepare("select id from tweets where id = ?").get("880060"),
		).toBeUndefined();
	});

	it("rejects invalid referenced_tweets before ingestion", () => {
		const home = testHome();
		const db = home.db;
		const result = importXJsonText(
			db,
			JSON.stringify({
				data: {
					id: "880070",
					author_id: SYNTH_AUTHOR.id,
					text: "broken reference",
					created_at: "2026-03-01T12:00:00.000Z",
					referenced_tweets: [{ type: "quoted", id: "not-a-tweet-id" }],
				},
				includes: { users: [SYNTH_AUTHOR] },
			}),
		);
		expect(result.imported).toBe(0);
		expect(result.errors[0]?.message).toContain("referenced_tweets.id");
		expect(db.prepare("select count(*) as count from tweets").get()).toEqual({
			count: 0,
		});
	});

	it("counts distinct primary tweet ids when data repeats an id", () => {
		const home = testHome();
		const db = home.db;
		const tweet = {
			id: "880080",
			author_id: SYNTH_AUTHOR.id,
			text: "duplicate primary",
			created_at: "2026-03-01T12:00:00.000Z",
		};
		const result = importXJsonText(
			db,
			JSON.stringify({
				data: [tweet, { ...tweet }],
				includes: { users: [SYNTH_AUTHOR] },
			}),
		);
		expect(result).toMatchObject({ imported: 1, skipped: 0, errors: [] });
		expect(db.prepare("select count(*) as count from tweets").get()).toEqual({
			count: 1,
		});
	});

	it("preserves original JSONL line numbers when leading lines are blank", () => {
		const home = testHome();
		const db = home.db;
		const good = JSON.stringify(singleTweetResponse({ id: "880090" }));
		const input = `\n\n${good}\n{not json}\n`;
		const result = importXJsonText(db, input);
		expect(result.imported).toBe(1);
		expect(result.errors).toEqual([
			{ line: 4, message: "Line 4: invalid JSON" },
		]);
	});
});

describe("importXJsonText backup compatibility", () => {
	const populatedHome = useTestHome({
		prefix: "birdclaw-x-json-backup-",
		seedDemoData: true,
	});

	it("survives backup export and restore in a populated workspace", async () => {
		const home = populatedHome();
		const db = home.db;
		const tweetsBefore = (
			db.prepare("select count(*) as count from tweets").get() as {
				count: number;
			}
		).count;
		const importResult = importXJsonText(
			db,
			JSON.stringify(
				singleTweetResponse({
					id: "880100",
					text: "backup needle",
					url: "https://example.test/status/880100",
				}),
			),
		);
		expect(importResult.errors).toEqual([]);
		expect(importResult.imported).toBe(1);
		const tweetsAfterImport = (
			db.prepare("select count(*) as count from tweets").get() as {
				count: number;
			}
		).count;
		expect(tweetsAfterImport).toBe(tweetsBefore + 1);

		const backupRoot = mkdtempSync(
			path.join(os.tmpdir(), "birdclaw-x-json-backup-repo-"),
		);
		await exportBackup({ repoPath: backupRoot, db });
		home.switchHome("birdclaw-x-json-restored-");
		await importBackup({ repoPath: backupRoot, mode: "replace" });
		const restoredDb = home.db;
		expect(
			restoredDb.prepare("select count(*) as count from tweets").get(),
		).toEqual({ count: tweetsAfterImport });
		expect(
			restoredDb
				.prepare("select id, text from tweets where id = ?")
				.get("880100"),
		).toMatchObject({ id: "880100", text: "backup needle" });
		expect(
			restoredDb
				.prepare(
					"select source from tweet_sources where tweet_id = ? and source = ?",
				)
				.get("880100", "x-json"),
		).toEqual({ source: "x-json" });
	});
});

describe("import x-json CLI", () => {
	it("imports from stdin and finds the tweet via search tweets", async () => {
		const input = JSON.stringify(
			singleTweetResponse({
				id: "880050",
				text: "stdin synth needle gamma",
			}),
		);
		const stdin = Readable.from([input]);
		const stdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");
		Object.defineProperty(process, "stdin", {
			configurable: true,
			value: stdin,
		});
		try {
			const log = vi.spyOn(console, "log").mockImplementation(() => {});
			await runCliMain(["node", "birdclaw", "import", "x-json", "-", "--json"]);
			expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({
				imported: 1,
				skipped: 0,
				errors: [],
			});
			log.mockClear();
			await runCliMain([
				"node",
				"birdclaw",
				"search",
				"tweets",
				"gamma",
				"--json",
			]);
			const rows = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
			expect(rows.map((row: { id: string }) => row.id)).toContain("880050");
		} finally {
			if (stdinDescriptor) {
				Object.defineProperty(process, "stdin", stdinDescriptor);
			}
		}
	});

	it("exits non-zero when errors are present but still prints JSON", async () => {
		const stdin = Readable.from(['{"data":{"id":"1"}}\n']);
		const stdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");
		Object.defineProperty(process, "stdin", {
			configurable: true,
			value: stdin,
		});
		try {
			process.exitCode = 0;
			const log = vi.spyOn(console, "log").mockImplementation(() => {});
			await runCliMain(["node", "birdclaw", "import", "x-json", "-", "--json"]);
			const payload = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
			expect(payload.errors.length).toBeGreaterThan(0);
			expect(payload).toMatchObject({
				imported: 0,
				skipped: 0,
			});
			expect(process.exitCode).toBe(1);
		} finally {
			if (stdinDescriptor) {
				Object.defineProperty(process, "stdin", stdinDescriptor);
			}
		}
	});
});
