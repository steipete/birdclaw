// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ensureBirdclawDirsMock = vi.fn();
const getBirdclawPathsMock = vi.fn();
const getQueryEnvelopeMock = vi.fn();
const findArchivesMock = vi.fn();
const importArchiveMock = vi.fn();
const addBlockMock = vi.fn();
const listBlocksMock = vi.fn();
const listInboxItemsMock = vi.fn();
const scoreInboxMock = vi.fn();
const listTimelineItemsMock = vi.fn();
const listDmConversationsMock = vi.fn();
const hydrateProfilesFromXMock = vi.fn();
const createPostMock = vi.fn();
const createTweetReplyMock = vi.fn();
const createDmReplyMock = vi.fn();
const removeBlockMock = vi.fn();
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
	getBirdclawPaths: () => getBirdclawPathsMock(),
}));

vi.mock("#/lib/archive-finder", () => ({
	findArchives: () => findArchivesMock(),
}));

vi.mock("#/lib/archive-import", () => ({
	importArchive: (...args: unknown[]) => importArchiveMock(...args),
}));

vi.mock("#/lib/blocks", () => ({
	addBlock: (...args: unknown[]) => addBlockMock(...args),
	listBlocks: (...args: unknown[]) => listBlocksMock(...args),
	removeBlock: (...args: unknown[]) => removeBlockMock(...args),
}));

vi.mock("#/lib/inbox", () => ({
	listInboxItems: (...args: unknown[]) => listInboxItemsMock(...args),
	scoreInbox: (...args: unknown[]) => scoreInboxMock(...args),
}));

vi.mock("#/lib/profile-hydration", () => ({
	hydrateProfilesFromX: (...args: unknown[]) =>
		hydrateProfilesFromXMock(...args),
}));

vi.mock("#/lib/queries", () => ({
	getQueryEnvelope: () => getQueryEnvelopeMock(),
	listTimelineItems: (...args: unknown[]) => listTimelineItemsMock(...args),
	listDmConversations: (...args: unknown[]) => listDmConversationsMock(...args),
	createPost: (...args: unknown[]) => createPostMock(...args),
	createTweetReply: (...args: unknown[]) => createTweetReplyMock(...args),
	createDmReply: (...args: unknown[]) => createDmReplyMock(...args),
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
		consoleLogMock.mockClear();
		ensureBirdclawDirsMock.mockReset();
		getBirdclawPathsMock.mockReset();
		getQueryEnvelopeMock.mockReset();
		findArchivesMock.mockReset();
		importArchiveMock.mockReset();
		addBlockMock.mockReset();
		listBlocksMock.mockReset();
		listInboxItemsMock.mockReset();
		scoreInboxMock.mockReset();
		listTimelineItemsMock.mockReset();
		listDmConversationsMock.mockReset();
		hydrateProfilesFromXMock.mockReset();
		createPostMock.mockReset();
		createTweetReplyMock.mockReset();
		createDmReplyMock.mockReset();
		removeBlockMock.mockReset();
		spawnMock.mockReset();
		execFileAsyncMock.mockReset();

		ensureBirdclawDirsMock.mockReturnValue({
			rootDir: "/tmp/.birdclaw",
			dbPath: "/tmp/.birdclaw/birdclaw.sqlite",
			mediaOriginalsDir: "/tmp/.birdclaw/media/originals",
			mediaThumbsDir: "/tmp/.birdclaw/media/thumbs",
		});
		getBirdclawPathsMock.mockReturnValue({
			rootDir: "/tmp/.birdclaw",
			dbPath: "/tmp/.birdclaw/birdclaw.sqlite",
		});
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
		addBlockMock.mockResolvedValue({ ok: true, action: "block" });
		listBlocksMock.mockReturnValue([{ accountId: "acct_primary" }]);
		listInboxItemsMock.mockReturnValue([{ id: "dm:1" }]);
		scoreInboxMock.mockResolvedValue({ ok: true });
		listTimelineItemsMock.mockReturnValue([{ id: "tweet_1" }]);
		listDmConversationsMock.mockReturnValue([{ id: "dm_1" }]);
		hydrateProfilesFromXMock.mockResolvedValue({
			ok: true,
			hydratedProfiles: 1,
		});
		createPostMock.mockResolvedValue({ ok: true, tweetId: "tweet_new" });
		createTweetReplyMock.mockResolvedValue({
			ok: true,
			replyId: "tweet_reply",
		});
		createDmReplyMock.mockResolvedValue({ ok: true, messageId: "msg_new" });
		removeBlockMock.mockResolvedValue({ ok: true, action: "unblock" });
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
		expect(spawnMock).toHaveBeenCalledWith("pnpm", ["dev"], {
			stdio: "inherit",
			shell: true,
		});
		expect(exitMock).toHaveBeenCalledWith(0);
	});

	it("imports the latest archive when no path is provided", async () => {
		findArchivesMock.mockResolvedValue([{ path: "/tmp/twitter.zip" }]);
		const { runCli } = await loadCli();

		await runCli(["node", "birdclaw", "--json", "import", "archive"]);

		expect(importArchiveMock).toHaveBeenCalledWith("/tmp/twitter.zip");
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
			"--limit",
			"5",
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
			limit: 5,
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
			"add",
			"@sam",
			"--account",
			"acct_studio",
		]);
		await runCli([
			"node",
			"birdclaw",
			"blocks",
			"remove",
			"@sam",
			"--account",
			"acct_studio",
		]);

		expect(listBlocksMock).toHaveBeenCalledWith({
			account: "acct_studio",
			search: "sam",
			limit: 50,
		});
		expect(addBlockMock).toHaveBeenCalledWith("acct_studio", "@sam");
		expect(removeBlockMock).toHaveBeenCalledWith("acct_studio", "@sam");
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
