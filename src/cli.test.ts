// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ensureBirdclawDirsMock = vi.fn();
const getBirdclawPathsMock = vi.fn();
const resolveMentionsDataSourceMock = vi.fn();
const getQueryEnvelopeMock = vi.fn();
const findArchivesMock = vi.fn();
const importArchiveMock = vi.fn();
const importBlocklistMock = vi.fn();
const addBlockMock = vi.fn();
const recordBlockMock = vi.fn();
const syncBlocksMock = vi.fn();
const exportMentionItemsMock = vi.fn();
const exportMentionsViaCachedBirdMock = vi.fn();
const exportMentionsViaCachedXurlMock = vi.fn();
const syncDirectMessagesViaCachedBirdMock = vi.fn();
const listBlocksMock = vi.fn();
const addMuteMock = vi.fn();
const listMutesMock = vi.fn();
const recordMuteMock = vi.fn();
const listInboxItemsMock = vi.fn();
const scoreInboxMock = vi.fn();
const listTimelineItemsMock = vi.fn();
const listDmConversationsMock = vi.fn();
const hydrateProfilesFromXMock = vi.fn();
const inspectProfileRepliesMock = vi.fn();
const runResearchModeMock = vi.fn();
const syncTimelineCollectionMock = vi.fn();
const createPostMock = vi.fn();
const createTweetReplyMock = vi.fn();
const createDmReplyMock = vi.fn();
const removeBlockMock = vi.fn();
const removeMuteMock = vi.fn();
const maybeAutoUpdateBackupMock = vi.fn();
const maybeAutoSyncBackupMock = vi.fn();
const spawnMock = vi.fn();
const execFileAsyncMock = vi.fn();
const execFileMock = vi.fn();
const consoleLogMock = vi.spyOn(console, "log").mockImplementation(() => {});

Object.defineProperty(
	execFileMock,
	Symbol.for("nodejs.util.promisify.custom"),
	{
		value: execFileAsyncMock,
	},
);

vi.mock("#/lib/config", () => ({
	ensureBirdclawDirs: () => ensureBirdclawDirsMock(),
	getBirdclawConfig: () => ({}),
	getBirdclawPaths: () => getBirdclawPathsMock(),
	resolveMentionsDataSource: (...args: unknown[]) =>
		resolveMentionsDataSourceMock(...args),
}));

vi.mock("#/lib/archive-finder", () => ({
	findArchives: () => findArchivesMock(),
}));

vi.mock("#/lib/archive-import", () => ({
	importArchive: (...args: unknown[]) => importArchiveMock(...args),
}));

vi.mock("#/lib/backup", async (importOriginal) => {
	const actual = await importOriginal<typeof import("#/lib/backup")>();
	return {
		...actual,
		maybeAutoUpdateBackup: () => maybeAutoUpdateBackupMock(),
		maybeAutoSyncBackup: () => maybeAutoSyncBackupMock(),
	};
});

vi.mock("#/lib/blocklist", () => ({
	importBlocklist: (...args: unknown[]) => importBlocklistMock(...args),
}));

vi.mock("#/lib/blocks", () => ({
	addBlock: (...args: unknown[]) => addBlockMock(...args),
	listBlocks: (...args: unknown[]) => listBlocksMock(...args),
	recordBlock: (...args: unknown[]) => recordBlockMock(...args),
	removeBlock: (...args: unknown[]) => removeBlockMock(...args),
	syncBlocks: (...args: unknown[]) => syncBlocksMock(...args),
}));

vi.mock("#/lib/inbox", () => ({
	listInboxItems: (...args: unknown[]) => listInboxItemsMock(...args),
	scoreInbox: (...args: unknown[]) => scoreInboxMock(...args),
}));

vi.mock("#/lib/mutes", () => ({
	addMute: (...args: unknown[]) => addMuteMock(...args),
	listMutes: (...args: unknown[]) => listMutesMock(...args),
	recordMute: (...args: unknown[]) => recordMuteMock(...args),
	removeMute: (...args: unknown[]) => removeMuteMock(...args),
}));

vi.mock("#/lib/mentions-export", () => ({
	exportMentionItems: (...args: unknown[]) => exportMentionItemsMock(...args),
}));

vi.mock("#/lib/mentions-live", () => ({
	exportMentionsViaCachedBird: (...args: unknown[]) =>
		exportMentionsViaCachedBirdMock(...args),
	exportMentionsViaCachedXurl: (...args: unknown[]) =>
		exportMentionsViaCachedXurlMock(...args),
}));

vi.mock("#/lib/dms-live", () => ({
	syncDirectMessagesViaCachedBird: (...args: unknown[]) =>
		syncDirectMessagesViaCachedBirdMock(...args),
}));

vi.mock("#/lib/profile-hydration", () => ({
	hydrateProfilesFromX: (...args: unknown[]) =>
		hydrateProfilesFromXMock(...args),
}));

vi.mock("#/lib/profile-replies", () => ({
	inspectProfileReplies: (...args: unknown[]) =>
		inspectProfileRepliesMock(...args),
}));

vi.mock("#/lib/research", () => ({
	runResearchMode: (...args: unknown[]) => runResearchModeMock(...args),
}));

vi.mock("#/lib/queries", () => ({
	getQueryEnvelope: () => getQueryEnvelopeMock(),
	listTimelineItems: (...args: unknown[]) => listTimelineItemsMock(...args),
	listDmConversations: (...args: unknown[]) => listDmConversationsMock(...args),
	createPost: (...args: unknown[]) => createPostMock(...args),
	createTweetReply: (...args: unknown[]) => createTweetReplyMock(...args),
	createDmReply: (...args: unknown[]) => createDmReplyMock(...args),
}));

vi.mock("#/lib/timeline-collections-live", () => ({
	syncTimelineCollection: (...args: unknown[]) =>
		syncTimelineCollectionMock(...args),
}));

vi.mock("node:child_process", () => ({
	execFile: execFileMock,
	spawn: (...args: unknown[]) => spawnMock(...args),
}));

async function loadCli() {
	vi.resetModules();
	return import("./cli");
}

describe("cli", () => {
	beforeEach(() => {
		process.exitCode = undefined;
		consoleLogMock.mockClear();
		ensureBirdclawDirsMock.mockReset();
		getBirdclawPathsMock.mockReset();
		resolveMentionsDataSourceMock.mockReset();
		getQueryEnvelopeMock.mockReset();
		findArchivesMock.mockReset();
		importArchiveMock.mockReset();
		importBlocklistMock.mockReset();
		addBlockMock.mockReset();
		recordBlockMock.mockReset();
		syncBlocksMock.mockReset();
		exportMentionItemsMock.mockReset();
		exportMentionsViaCachedBirdMock.mockReset();
		exportMentionsViaCachedXurlMock.mockReset();
		syncDirectMessagesViaCachedBirdMock.mockReset();
		listBlocksMock.mockReset();
		addMuteMock.mockReset();
		listMutesMock.mockReset();
		recordMuteMock.mockReset();
		listInboxItemsMock.mockReset();
		scoreInboxMock.mockReset();
		listTimelineItemsMock.mockReset();
		listDmConversationsMock.mockReset();
		hydrateProfilesFromXMock.mockReset();
		inspectProfileRepliesMock.mockReset();
		runResearchModeMock.mockReset();
		syncTimelineCollectionMock.mockReset();
		createPostMock.mockReset();
		createTweetReplyMock.mockReset();
		createDmReplyMock.mockReset();
		removeBlockMock.mockReset();
		removeMuteMock.mockReset();
		maybeAutoUpdateBackupMock.mockReset();
		maybeAutoSyncBackupMock.mockReset();
		spawnMock.mockReset();
		execFileAsyncMock.mockReset();

		ensureBirdclawDirsMock.mockReturnValue({
			rootDir: "/tmp/.birdclaw",
			configPath: "/tmp/.birdclaw/config.json",
			dbPath: "/tmp/.birdclaw/birdclaw.sqlite",
			mediaOriginalsDir: "/tmp/.birdclaw/media/originals",
			mediaThumbsDir: "/tmp/.birdclaw/media/thumbs",
		});
		getBirdclawPathsMock.mockReturnValue({
			rootDir: "/tmp/.birdclaw",
			dbPath: "/tmp/.birdclaw/birdclaw.sqlite",
		});
		resolveMentionsDataSourceMock.mockImplementation(
			(mode?: string) => mode ?? "birdclaw",
		);
		getQueryEnvelopeMock.mockResolvedValue({
			stats: { home: 4, mentions: 2, dms: 4, needsReply: 2, inbox: 4 },
			transport: { statusText: "local", installed: false },
			accounts: [],
			archives: [],
		});
		findArchivesMock.mockResolvedValue([{ name: "twitter.zip" }]);
		importArchiveMock.mockResolvedValue({
			ok: true,
			archivePath: "/tmp/twitter.zip",
		});
		importBlocklistMock.mockResolvedValue({
			ok: true,
			accountId: "acct_primary",
			path: "/tmp/blocklist.txt",
			requestedCount: 2,
			blockedCount: 2,
			failedCount: 0,
			items: [],
		});
		addBlockMock.mockResolvedValue({ ok: true, action: "block" });
		recordBlockMock.mockResolvedValue({ ok: true, action: "record-block" });
		syncBlocksMock.mockResolvedValue({
			ok: true,
			synced: true,
			syncedCount: 3,
		});
		exportMentionItemsMock.mockReturnValue([
			{
				id: "tweet_mention_1",
				plainText: "plain",
				markdown: "markdown",
			},
		]);
		exportMentionsViaCachedBirdMock.mockResolvedValue({
			data: [{ id: "tweet_live_bird_1" }],
			includes: { users: [{ id: "42", username: "sam", name: "Sam" }] },
			meta: { result_count: 1 },
		});
		exportMentionsViaCachedXurlMock.mockResolvedValue({
			data: [{ id: "tweet_live_1" }],
			includes: { users: [{ id: "42", username: "sam", name: "Sam" }] },
			meta: { result_count: 1 },
		});
		syncDirectMessagesViaCachedBirdMock.mockResolvedValue({
			ok: true,
			source: "bird",
			accountId: "acct_primary",
			conversations: 1,
			messages: 2,
		});
		listBlocksMock.mockReturnValue([{ accountId: "acct_primary" }]);
		addMuteMock.mockResolvedValue({ ok: true, action: "mute" });
		listMutesMock.mockReturnValue([{ accountId: "acct_primary" }]);
		recordMuteMock.mockResolvedValue({ ok: true, action: "record-mute" });
		listInboxItemsMock.mockReturnValue([{ id: "dm:1" }]);
		scoreInboxMock.mockResolvedValue({ ok: true });
		listTimelineItemsMock.mockReturnValue([{ id: "tweet_1" }]);
		listDmConversationsMock.mockReturnValue([{ id: "dm_1" }]);
		hydrateProfilesFromXMock.mockResolvedValue({
			ok: true,
			hydratedProfiles: 1,
		});
		inspectProfileRepliesMock.mockResolvedValue({
			profile: { handle: "sam" },
			externalUserId: "42",
			items: [],
			meta: { scannedCount: 0, returnedCount: 0, nextToken: null },
		});
		runResearchModeMock.mockResolvedValue({
			query: undefined,
			account: undefined,
			generatedAt: "2026-05-02T00:00:00.000Z",
			seedCount: 1,
			threadCount: 1,
			items: [],
			markdown: "# Birdclaw Research\n",
		});
		syncTimelineCollectionMock.mockResolvedValue({
			ok: true,
			source: "bird",
			kind: "likes",
			count: 1,
		});
		createPostMock.mockResolvedValue({ ok: true, tweetId: "tweet_new" });
		createTweetReplyMock.mockResolvedValue({
			ok: true,
			replyId: "tweet_reply",
		});
		createDmReplyMock.mockResolvedValue({ ok: true, messageId: "msg_new" });
		removeBlockMock.mockResolvedValue({ ok: true, action: "unblock" });
		removeMuteMock.mockResolvedValue({ ok: true, action: "unmute" });
		maybeAutoUpdateBackupMock.mockResolvedValue({
			ok: true,
			enabled: false,
			skipped: true,
		});
		maybeAutoSyncBackupMock.mockResolvedValue({
			ok: true,
			enabled: false,
			skipped: true,
		});
		execFileAsyncMock.mockRejectedValue(new Error("missing"));
		spawnMock.mockReturnValue({
			on: (_event: string, handler: (code: number) => void) => handler(0),
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("prints init, auth status, archive results, and db stats as json", async () => {
		const exitMock = vi.spyOn(process, "exit").mockImplementation((() => {
			return undefined as never;
		}) as never);
		const { runCli } = await loadCli();

		await runCli(["node", "birdclaw", "--json", "init"]);
		await runCli(["node", "birdclaw", "--json", "auth", "status"]);
		await runCli(["node", "birdclaw", "--json", "archive", "find"]);
		await runCli(["node", "birdclaw", "--json", "db", "stats"]);
		await runCli(["node", "birdclaw", "serve"]);

		expect(consoleLogMock).toHaveBeenCalledWith(
			expect.stringContaining('"rootDir": "/tmp/.birdclaw"'),
		);
		expect(consoleLogMock).toHaveBeenCalledWith(
			expect.stringContaining('"statusText": "local"'),
		);
		expect(consoleLogMock).toHaveBeenCalledWith(
			expect.stringContaining('"name": "twitter.zip"'),
		);
		expect(consoleLogMock).toHaveBeenCalledWith(
			expect.stringContaining('"stats"'),
		);
		expect(spawnMock).toHaveBeenCalledWith(
			process.execPath,
			["node_modules/vite/bin/vite.js", "dev", "--port", "3000"],
			expect.objectContaining({
				cwd: expect.stringContaining("birdclaw"),
				stdio: "inherit",
			}),
		);
		expect(exitMock).toHaveBeenCalledWith(0);
	});

	it("prints tweet search snippets in json output", async () => {
		listTimelineItemsMock.mockReturnValue([
			{
				id: "tweet_006",
				searchSnippet:
					"<mark>Agents</mark> need retrieval surfaces with small, stable contracts.",
			},
		]);
		const { runCli } = await loadCli();

		await runCli(["node", "birdclaw", "--json", "search", "tweets", "agents"]);

		expect(consoleLogMock).toHaveBeenCalledWith(
			expect.stringContaining('"searchSnippet": "<mark>Agents</mark>'),
		);
	});

	it("prints the package version", async () => {
		const exitMock = vi.spyOn(process, "exit").mockImplementation((() => {
			return undefined as never;
		}) as never);
		const stdoutWriteMock = vi
			.spyOn(process.stdout, "write")
			.mockImplementation(() => true);
		const { runCli } = await loadCli();

		await runCli(["node", "birdclaw", "--version"]);

		expect(stdoutWriteMock).toHaveBeenCalledWith("0.2.1\n");
		expect(exitMock).toHaveBeenCalledWith(0);
		stdoutWriteMock.mockRestore();
	});

	it("imports the latest archive when no path is provided", async () => {
		findArchivesMock.mockResolvedValue([{ path: "/tmp/twitter.zip" }]);
		const { runCli } = await loadCli();

		await runCli(["node", "birdclaw", "--json", "import", "archive"]);

		expect(importArchiveMock).toHaveBeenCalledWith("/tmp/twitter.zip");
	});

	it("dispatches paged live mention exports", async () => {
		const { runCli } = await loadCli();

		await runCli([
			"node",
			"birdclaw",
			"mentions",
			"export",
			"--mode",
			"xurl",
			"--all",
			"--max-pages",
			"9",
			"--limit",
			"100",
			"--refresh",
		]);

		expect(exportMentionsViaCachedXurlMock).toHaveBeenCalledWith({
			account: undefined,
			search: undefined,
			replyFilter: "all",
			limit: 100,
			all: true,
			maxPages: 9,
			refresh: true,
			cacheTtlMs: 120000,
		});
	});

	it("uses configured bird mode for cached mention exports", async () => {
		resolveMentionsDataSourceMock.mockReturnValue("bird");
		const { runCli } = await loadCli();

		await runCli([
			"node",
			"birdclaw",
			"mentions",
			"export",
			"--refresh",
			"--limit",
			"12",
		]);

		expect(exportMentionsViaCachedBirdMock).toHaveBeenCalledWith({
			account: undefined,
			search: undefined,
			replyFilter: "all",
			limit: 12,
			all: false,
			maxPages: undefined,
			refresh: true,
			cacheTtlMs: 120000,
		});
		expect(exportMentionsViaCachedXurlMock).not.toHaveBeenCalled();
	});

	it("imports an explicit archive path without discovery", async () => {
		const { runCli } = await loadCli();

		await runCli([
			"node",
			"birdclaw",
			"--json",
			"import",
			"archive",
			"/tmp/explicit.zip",
		]);

		expect(importArchiveMock).toHaveBeenCalledWith("/tmp/explicit.zip");
		expect(findArchivesMock).not.toHaveBeenCalled();
	});

	it("reports backup auto-sync failures without hiding command output", async () => {
		const consoleErrorMock = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		maybeAutoUpdateBackupMock.mockResolvedValue({
			ok: false,
			enabled: true,
			skipped: false,
			error: "pull failed",
		});
		maybeAutoSyncBackupMock.mockResolvedValue({
			ok: false,
			enabled: true,
			skipped: false,
			error: "push failed",
		});
		const { runCli } = await loadCli();

		await runCli(["node", "birdclaw", "search", "tweets", "local"]);
		await runCli([
			"node",
			"birdclaw",
			"--json",
			"import",
			"archive",
			"/tmp/x.zip",
		]);

		expect(consoleErrorMock).toHaveBeenCalledWith(
			"birdclaw backup auto-sync failed: pull failed",
		);
		expect(consoleErrorMock).toHaveBeenCalledWith(
			"birdclaw backup sync failed: push failed",
		);
		expect(listTimelineItemsMock).toHaveBeenCalled();
		expect(importArchiveMock).toHaveBeenCalledWith("/tmp/x.zip");
		consoleErrorMock.mockRestore();
	});

	it("hydrates archive profiles and errors when no archive exists", async () => {
		findArchivesMock.mockResolvedValue([]);
		const { runCli } = await loadCli();

		await runCli(["node", "birdclaw", "--json", "import", "hydrate-profiles"]);
		await expect(
			runCli(["node", "birdclaw", "--json", "import", "archive"]),
		).rejects.toThrow("No archive found");

		expect(hydrateProfilesFromXMock).toHaveBeenCalled();
	});

	it("dispatches search commands with parsed filters", async () => {
		const { runCli } = await loadCli();

		await runCli([
			"node",
			"birdclaw",
			"search",
			"tweets",
			"local",
			"--resource",
			"mentions",
			"--unreplied",
			"--since",
			"2020-01-01",
			"--until",
			"2021-01-01",
			"--originals-only",
			"--hide-low-quality",
			"--min-likes",
			"200",
			"--quality-reason",
			"--liked",
			"--limit",
			"5",
		]);
		await runCli([
			"node",
			"birdclaw",
			"research",
			"codex",
			"--account",
			"acct_primary",
			"--limit",
			"4",
			"--thread-depth",
			"6",
		]);
		await runCli([
			"node",
			"birdclaw",
			"search",
			"dms",
			"sam",
			"--participant",
			"sam",
			"--min-followers",
			"500",
			"--max-influence-score",
			"120",
			"--sort",
			"influence",
			"--unreplied",
			"--limit",
			"9",
		]);
		await runCli([
			"node",
			"birdclaw",
			"dms",
			"list",
			"--participant",
			"des",
			"--max-followers",
			"200000",
		]);
		await runCli([
			"node",
			"birdclaw",
			"dms",
			"list",
			"--max-influence-score",
			"80",
		]);
		await runCli([
			"node",
			"birdclaw",
			"dms",
			"list",
			"--account",
			"acct_primary",
			"--refresh",
			"--limit",
			"12",
		]);
		await runCli([
			"node",
			"birdclaw",
			"dms",
			"sync",
			"--account",
			"acct_primary",
			"--limit",
			"7",
			"--refresh",
			"--cache-ttl",
			"45",
		]);
		await runCli([
			"node",
			"birdclaw",
			"sync",
			"bookmarks",
			"--mode",
			"bird",
			"--all",
			"--max-pages",
			"3",
			"--limit",
			"25",
			"--refresh",
			"--cache-ttl",
			"30",
		]);
		await runCli([
			"node",
			"birdclaw",
			"dms",
			"list",
			"--min-followers",
			"10",
			"--min-influence-score",
			"20",
			"--replied",
			"--sort",
			"influence",
		]);

		expect(listTimelineItemsMock).toHaveBeenCalledWith({
			resource: "mentions",
			search: "local",
			replyFilter: "unreplied",
			since: "2020-01-01",
			until: "2021-01-01",
			includeReplies: false,
			qualityFilter: "summary",
			lowQualityThreshold: 200,
			includeQualityReason: true,
			likedOnly: true,
			bookmarkedOnly: false,
			limit: 5,
		});
		expect(runResearchModeMock).toHaveBeenCalledWith({
			account: "acct_primary",
			query: "codex",
			limit: 4,
			maxThreadDepth: 6,
			outPath: undefined,
		});
		expect(listDmConversationsMock).toHaveBeenCalledWith({
			search: "sam",
			participant: "sam",
			minFollowers: 500,
			maxFollowers: undefined,
			minInfluenceScore: undefined,
			maxInfluenceScore: 120,
			sort: "influence",
			replyFilter: "unreplied",
			limit: 9,
		});
		expect(listDmConversationsMock).toHaveBeenCalledWith({
			account: undefined,
			participant: "des",
			minFollowers: undefined,
			maxFollowers: 200000,
			minInfluenceScore: undefined,
			maxInfluenceScore: undefined,
			sort: "recent",
			replyFilter: "all",
			limit: 20,
		});
		expect(listDmConversationsMock).toHaveBeenCalledWith({
			account: undefined,
			participant: undefined,
			minFollowers: undefined,
			maxFollowers: undefined,
			minInfluenceScore: undefined,
			maxInfluenceScore: 80,
			sort: "recent",
			replyFilter: "all",
			limit: 20,
		});
		expect(listDmConversationsMock).toHaveBeenCalledWith({
			account: "acct_primary",
			participant: undefined,
			minFollowers: undefined,
			maxFollowers: undefined,
			minInfluenceScore: undefined,
			maxInfluenceScore: undefined,
			sort: "recent",
			replyFilter: "all",
			limit: 12,
		});
		expect(syncDirectMessagesViaCachedBirdMock).toHaveBeenCalledWith({
			account: "acct_primary",
			limit: 12,
			refresh: true,
			cacheTtlMs: 120_000,
		});
		expect(syncDirectMessagesViaCachedBirdMock).toHaveBeenCalledWith({
			account: "acct_primary",
			limit: 7,
			refresh: true,
			cacheTtlMs: 45_000,
		});
		expect(syncTimelineCollectionMock).toHaveBeenCalledWith({
			kind: "bookmarks",
			account: undefined,
			mode: "bird",
			limit: 25,
			all: true,
			maxPages: 3,
			refresh: true,
			cacheTtlMs: 30_000,
		});
		expect(listDmConversationsMock).toHaveBeenCalledWith({
			account: undefined,
			participant: undefined,
			minFollowers: 10,
			maxFollowers: undefined,
			minInfluenceScore: 20,
			maxInfluenceScore: undefined,
			sort: "influence",
			replyFilter: "replied",
			limit: 20,
		});
	});

	it("falls back to default cli filters when flags are omitted", async () => {
		const { runCli } = await loadCli();

		await runCli(["node", "birdclaw", "search", "tweets", "default"]);
		await runCli(["node", "birdclaw", "search", "dms", "default"]);
		await runCli(["node", "birdclaw", "inbox", "--kind", "weird"]);
		await runCli(["node", "birdclaw", "compose", "post", "Ship it"]);
		await runCli([
			"node",
			"birdclaw",
			"compose",
			"reply",
			"tweet_2",
			"Reply text",
		]);

		expect(listTimelineItemsMock).toHaveBeenCalledWith({
			resource: "home",
			search: "default",
			replyFilter: "all",
			since: undefined,
			until: undefined,
			includeReplies: true,
			qualityFilter: "all",
			lowQualityThreshold: undefined,
			includeQualityReason: false,
			likedOnly: false,
			bookmarkedOnly: false,
			limit: 20,
		});
		expect(listDmConversationsMock).toHaveBeenCalledWith({
			search: "default",
			participant: undefined,
			minFollowers: undefined,
			maxFollowers: undefined,
			minInfluenceScore: undefined,
			maxInfluenceScore: undefined,
			sort: "recent",
			replyFilter: "all",
			limit: 20,
		});
		expect(listInboxItemsMock).toHaveBeenCalledWith({
			kind: "mixed",
			minScore: 0,
			hideLowSignal: false,
			limit: 20,
		});
		expect(scoreInboxMock).not.toHaveBeenCalled();
		expect(createPostMock).toHaveBeenCalledWith("acct_primary", "Ship it");
		expect(createTweetReplyMock).toHaveBeenCalledWith(
			"acct_primary",
			"tweet_2",
			"Reply text",
		);
	});

	it("prints quality reasons for tweet search when requested", async () => {
		listTimelineItemsMock.mockReturnValue([
			{ id: "tweet_1", qualityReason: "keep:high-likes" },
		]);
		const { runCli } = await loadCli();

		await runCli([
			"node",
			"birdclaw",
			"--json",
			"search",
			"tweets",
			"local",
			"--quality-reason",
		]);

		expect(consoleLogMock).toHaveBeenCalledWith(
			expect.stringContaining('"qualityReason": "keep:high-likes"'),
		);
	});

	it("rejects invalid min-likes values as json errors", async () => {
		const consoleErrorMock = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		const { runCli } = await loadCli();

		await runCli([
			"node",
			"birdclaw",
			"search",
			"tweets",
			"local",
			"--min-likes",
			"2.5",
		]);

		expect(consoleErrorMock).toHaveBeenCalledWith(
			JSON.stringify({ error: "--min-likes must be a non-negative integer" }),
		);
		expect(process.exitCode).toBe(1);
		expect(maybeAutoUpdateBackupMock).not.toHaveBeenCalled();
		expect(listTimelineItemsMock).not.toHaveBeenCalled();
		consoleErrorMock.mockRestore();
	});

	it("dispatches blocklist commands", async () => {
		const { runCli } = await loadCli();

		await runCli([
			"node",
			"birdclaw",
			"blocks",
			"list",
			"--account",
			"acct_studio",
			"--search",
			"sam",
		]);
		await runCli([
			"node",
			"birdclaw",
			"blocks",
			"import",
			"/tmp/blocklist.txt",
			"--account",
			"acct_studio",
		]);
		await runCli([
			"node",
			"birdclaw",
			"blocks",
			"add",
			"@sam",
			"--account",
			"acct_studio",
			"--transport",
			"xurl",
		]);
		await runCli([
			"node",
			"birdclaw",
			"blocks",
			"remove",
			"@sam",
			"--account",
			"acct_studio",
			"--transport",
			"bird",
		]);
		await runCli([
			"node",
			"birdclaw",
			"blocks",
			"sync",
			"--account",
			"acct_studio",
		]);
		await runCli([
			"node",
			"birdclaw",
			"blocks",
			"record",
			"@sam",
			"--account",
			"acct_studio",
		]);

		expect(listBlocksMock).toHaveBeenCalledWith({
			account: "acct_studio",
			search: "sam",
			limit: 50,
		});
		expect(importBlocklistMock).toHaveBeenCalledWith(
			"acct_studio",
			"/tmp/blocklist.txt",
		);
		expect(addBlockMock).toHaveBeenCalledWith("acct_studio", "@sam", {
			transport: "xurl",
		});
		expect(removeBlockMock).toHaveBeenCalledWith("acct_studio", "@sam", {
			transport: "bird",
		});
		expect(syncBlocksMock).toHaveBeenCalledWith("acct_studio");
		expect(recordBlockMock).toHaveBeenCalledWith("acct_studio", "@sam");
	});

	it("dispatches mute and ban commands", async () => {
		const { runCli } = await loadCli();

		await runCli([
			"node",
			"birdclaw",
			"mutes",
			"list",
			"--account",
			"acct_studio",
			"--search",
			"sam",
		]);
		await runCli([
			"node",
			"birdclaw",
			"mute",
			"@sam",
			"--account",
			"acct_studio",
			"--transport",
			"xurl",
		]);
		await runCli([
			"node",
			"birdclaw",
			"unmute",
			"@sam",
			"--account",
			"acct_studio",
			"--transport",
			"auto",
		]);
		await runCli([
			"node",
			"birdclaw",
			"mutes",
			"record",
			"@sam",
			"--account",
			"acct_studio",
		]);
		await runCli([
			"node",
			"birdclaw",
			"ban",
			"@sam",
			"--account",
			"acct_studio",
			"--transport",
			"xurl",
		]);
		await runCli([
			"node",
			"birdclaw",
			"unban",
			"@sam",
			"--account",
			"acct_studio",
			"--transport",
			"bird",
		]);

		expect(listMutesMock).toHaveBeenCalledWith({
			account: "acct_studio",
			search: "sam",
			limit: 50,
		});
		expect(addMuteMock).toHaveBeenCalledWith("acct_studio", "@sam", {
			transport: "xurl",
		});
		expect(removeMuteMock).toHaveBeenCalledWith("acct_studio", "@sam", {
			transport: "auto",
		});
		expect(recordMuteMock).toHaveBeenCalledWith("acct_studio", "@sam");
		expect(addBlockMock).toHaveBeenCalledWith("acct_studio", "@sam", {
			transport: "xurl",
		});
		expect(removeBlockMock).toHaveBeenCalledWith("acct_studio", "@sam", {
			transport: "bird",
		});
	});

	it("exports mentions as json with rendered text fields", async () => {
		const { runCli } = await loadCli();

		await runCli([
			"node",
			"birdclaw",
			"mentions",
			"export",
			"sam",
			"--unreplied",
			"--limit",
			"4",
		]);

		expect(exportMentionItemsMock).toHaveBeenCalledWith({
			account: undefined,
			search: "sam",
			replyFilter: "unreplied",
			limit: 4,
		});
		expect(consoleLogMock).toHaveBeenCalledWith(
			expect.stringContaining('"resource": "mentions"'),
		);
		expect(consoleLogMock).toHaveBeenCalledWith(
			expect.stringContaining('"plainText": "plain"'),
		);
		expect(consoleLogMock).toHaveBeenCalledWith(
			expect.stringContaining('"markdown": "markdown"'),
		);
	});

	it("exports mentions in cached xurl mode", async () => {
		const { runCli } = await loadCli();

		await runCli([
			"node",
			"birdclaw",
			"mentions",
			"export",
			"--mode",
			"xurl",
			"--account",
			"acct_primary",
			"--refresh",
			"--cache-ttl",
			"45",
			"--limit",
			"5",
		]);

		expect(exportMentionsViaCachedXurlMock).toHaveBeenCalledWith({
			account: "acct_primary",
			search: undefined,
			replyFilter: "all",
			limit: 5,
			all: false,
			maxPages: undefined,
			refresh: true,
			cacheTtlMs: 45_000,
		});
		expect(consoleLogMock).toHaveBeenCalledWith(
			expect.stringContaining('"result_count": 1'),
		);
	});

	it("exports mentions in cached bird mode", async () => {
		const { runCli } = await loadCli();

		await runCli([
			"node",
			"birdclaw",
			"mentions",
			"export",
			"--mode",
			"bird",
			"--account",
			"acct_primary",
			"--refresh",
			"--cache-ttl",
			"45",
			"--limit",
			"5",
		]);

		expect(exportMentionsViaCachedBirdMock).toHaveBeenCalledWith({
			account: "acct_primary",
			search: undefined,
			replyFilter: "all",
			limit: 5,
			all: false,
			maxPages: undefined,
			refresh: true,
			cacheTtlMs: 45_000,
		});
		expect(consoleLogMock).toHaveBeenCalledWith(
			expect.stringContaining('"result_count": 1'),
		);
	});

	it("prints research briefs as markdown by default", async () => {
		const { runCli } = await loadCli();

		await runCli(["node", "birdclaw", "research", "codex"]);

		expect(runResearchModeMock).toHaveBeenCalledWith({
			account: undefined,
			query: "codex",
			limit: 20,
			maxThreadDepth: 10,
			outPath: undefined,
		});
		expect(consoleLogMock).toHaveBeenCalledWith(
			expect.stringContaining("# Birdclaw Research"),
		);
	});

	it("inspects recent profile replies", async () => {
		const { runCli } = await loadCli();

		await runCli([
			"node",
			"birdclaw",
			"profiles",
			"replies",
			"@sam",
			"--limit",
			"7",
		]);

		expect(inspectProfileRepliesMock).toHaveBeenCalledWith("@sam", {
			limit: 7,
		});
	});

	it("dispatches compose and inbox commands", async () => {
		const { runCli } = await loadCli();

		await runCli(["node", "birdclaw", "compose", "post", "Ship it"]);
		await runCli([
			"node",
			"birdclaw",
			"compose",
			"reply",
			"tweet_1",
			"Strong point",
		]);
		await runCli(["node", "birdclaw", "compose", "dm", "dm_1", "Looks good"]);
		await runCli([
			"node",
			"birdclaw",
			"inbox",
			"--kind",
			"dms",
			"--min-score",
			"50",
			"--hide-low-signal",
			"--score",
			"--limit",
			"3",
		]);

		expect(createPostMock).toHaveBeenCalledWith("acct_primary", "Ship it");
		expect(createTweetReplyMock).toHaveBeenCalledWith(
			"acct_primary",
			"tweet_1",
			"Strong point",
		);
		expect(createDmReplyMock).toHaveBeenCalledWith("dm_1", "Looks good");
		expect(scoreInboxMock).toHaveBeenCalledWith({ kind: "dms", limit: 3 });
		expect(listInboxItemsMock).toHaveBeenCalledWith({
			kind: "dms",
			minScore: 50,
			hideLowSignal: true,
			limit: 3,
		});
	});
});
