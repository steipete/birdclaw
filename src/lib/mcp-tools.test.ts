// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
	useTestHome,
	insertTestAccount,
	insertTestProfile,
	insertTestTweet,
} from "../test/test-home";
import { __test__, MCP_MAX_FTS_MATCHES } from "./mcp-tools";
import { handleBirdclawMcpRequest } from "./mcp-http";
import { listTimelineItems } from "./timeline-read-model";
const home = useTestHome({
	seedDemoData: false,
	prefix: "birdclaw-mcp-pass11-",
});
const now = "2026-07-01T12:00:00.000Z";
function fixture(hidden: "deleted_at" | "superseded_at", count: number) {
	const db = home().db;
	insertTestAccount(db, { id: "acct_primary", handle: "@steipete" });
	insertTestProfile(db);
	db.transaction(() => {
		for (let i = 0; i <= count; i++) {
			const id = "p11_" + i;
			insertTestTweet(db, { id, text: "pass11needle", createdAt: now });
			db.prepare(
				"insert into tweets_fts(tweet_id, text) values (?, 'pass11needle')",
			).run(id);
			db.prepare(
				"insert into tweet_account_edges(account_id,tweet_id,kind,first_seen_at,last_seen_at,source,updated_at) values ('acct_primary',?,'home',?,?,'test',?)",
			).run(id, now, now, now);
			for (const kind of ["likes", "bookmarks"])
				db.prepare(
					"insert into tweet_collections(account_id,tweet_id,kind,collected_at,source,raw_json,updated_at) values ('acct_primary',?,?,?,'test','{}',?)",
				).run(id, kind, now, now);
			if (i > 0)
				db.prepare("update tweets set " + hidden + " = ? where id = ?").run(
					now,
					id,
				);
		}
	})();
	return db;
}
async function search() {
	const token = "birdclaw-pass11-test-token-0123456789abcdef";
	const response = await handleBirdclawMcpRequest(
		new Request("http://mcp.birdclaw.test/mcp", {
			method: "POST",
			headers: {
				host: "mcp.birdclaw.test",
				authorization: "Bearer " + token,
				accept: "application/json, text/event-stream",
				"content-type": "application/json",
				"mcp-protocol-version": "2025-06-18",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: {
					name: "search_tweets",
					arguments: { query: "pass11needle", limit: 1 },
				},
			}),
		}),
		{
			config: {
				token,
				publicUrl: new URL("https://mcp.birdclaw.test/mcp"),
				reserveHost: true,
			},
			account: { id: "acct_primary", handle: "@steipete" },
			serverVersion: "test",
		},
		{ isLoopbackPeer: true },
	);
	expect(response.status).toBe(200);
	return (await response.json()) as {
		result: {
			isError?: boolean;
			structuredContent?: { count: number; items: Array<{ id: string }> };
		};
	};
}
describe("Pass 11 MCP visible FTS scope", () => {
	for (const hidden of ["deleted_at", "superseded_at"] as const) {
		it.each([
			{ likedOnly: false, bookmarkedOnly: false },
			{ likedOnly: true, bookmarkedOnly: false },
			{ likedOnly: false, bookmarkedOnly: true },
			{ likedOnly: true, bookmarkedOnly: true },
		])("excludes " + hidden + " from scoped FTS counts with %j", (filters) => {
			const db = fixture(hidden, 2);
			const preflight = __test__.preflightFtsSearch(db, {
				query: "pass11needle",
				accountId: "acct_primary",
				resource: "home",
				includeReplies: true,
				...filters,
			});
			expect(preflight).toMatchObject({
				rawCandidateCount: 3,
				candidateCount: 3,
				scopedCount: 1,
			});
			expect(
				listTimelineItems(
					{
						account: "acct_primary",
						resource: "home",
						search: "pass11needle",
						qualityFilter: "all",
						...filters,
					},
					db,
				).map((t) => t.id),
			).toEqual(["p11_0"]);
		});
		it(
			"does not reject an otherwise small result because of " +
				hidden +
				" matches",
			async () => {
				const db = fixture(hidden, MCP_MAX_FTS_MATCHES);
				const accepted = await search();
				expect(accepted.result.isError).not.toBe(true);
				expect(accepted.result.structuredContent).toMatchObject({
					count: 1,
					items: [{ id: "p11_0" }],
				});
				db.prepare("update tweets set " + hidden + " = null").run();
				const rejected = await search();
				expect(rejected.result.isError).toBe(true);
				expect(JSON.stringify(rejected)).toContain("more than 1000");
			},
		);
	}
});
