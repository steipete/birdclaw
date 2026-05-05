import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getNativeDb } from "./db";
import { listTimelineItems } from "./queries";
import { lookupTweetsByIds } from "./tweet-lookup";
import { renderTweetMarkdown, renderTweetPlainText } from "./tweet-render";
import type { TweetEntities, XurlMentionUser } from "./types";

type ResearchNodeSource = "local" | "live";

export interface ResearchNode {
	id: string;
	url: string;
	authorHandle: string;
	authorName: string;
	createdAt: string;
	text: string;
	plainText: string;
	markdown: string;
	likeCount: number;
	bookmarked: boolean;
	liked: boolean;
	replyToTweetId?: string | null;
	quotedTweetId?: string | null;
	threadDepth: number;
	source: ResearchNodeSource;
}

export interface ResearchThread {
	seedTweetId: string;
	seedUrl: string;
	seedText: string;
	threadRootId: string;
	thread: ResearchNode[];
	links: string[];
	handles: string[];
}

export interface ResearchReport {
	query?: string;
	account?: string;
	generatedAt: string;
	seedCount: number;
	threadCount: number;
	items: ResearchThread[];
	markdown: string;
}

export interface ResearchOptions {
	account?: string;
	query?: string;
	limit?: number;
	maxThreadDepth?: number;
	outPath?: string;
}

interface ResearchRow {
	id: string;
	account_id: string;
	account_handle: string;
	kind: string;
	text: string;
	created_at: string;
	is_replied: number;
	like_count: number;
	bookmarked: number;
	liked: number;
	reply_to_id: string | null;
	quoted_tweet_id: string | null;
	entities_json: string;
	author_handle: string;
	author_name: string;
	author_bio: string;
	author_followers_count: number;
	author_avatar_hue: number;
	author_avatar_url: string | null;
	author_created_at: string;
	thread_depth?: number;
}

function parseJsonField<T>(value: unknown, fallback: T): T {
	if (typeof value !== "string" || value.length === 0) {
		return fallback;
	}

	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

function normalizeTweetEntities(raw: unknown): TweetEntities {
	if (!raw || typeof raw !== "object") {
		return {};
	}

	const entities = raw as Record<string, unknown>;
	const mentions = Array.isArray(entities.mentions) ? entities.mentions : [];
	const urls = Array.isArray(entities.urls) ? entities.urls : [];
	const hashtags = Array.isArray(entities.hashtags) ? entities.hashtags : [];

	return {
		...(mentions.length
			? {
					mentions: mentions.map((mention) => {
						const value =
							mention && typeof mention === "object"
								? (mention as Record<string, unknown>)
								: {};
						return {
							username: String(value.username ?? ""),
							id: typeof value.id === "string" ? String(value.id) : undefined,
							start: Number(value.start ?? 0),
							end: Number(value.end ?? 0),
						};
					}),
				}
			: {}),
		...(urls.length
			? {
					urls: urls.map((url) => {
						const value =
							url && typeof url === "object"
								? (url as Record<string, unknown>)
								: {};
						return {
							url: String(value.url ?? ""),
							expandedUrl: String(
								value.expanded_url ?? value.expandedUrl ?? value.url ?? "",
							),
							displayUrl: String(
								value.display_url ?? value.displayUrl ?? value.url ?? "",
							),
							start: Number(value.start ?? 0),
							end: Number(value.end ?? 0),
						};
					}),
				}
			: {}),
		...(hashtags.length
			? {
					hashtags: hashtags.map((hashtag) => {
						const value =
							hashtag && typeof hashtag === "object"
								? (hashtag as Record<string, unknown>)
								: {};
						return {
							tag: String(value.tag ?? ""),
							start: Number(value.start ?? 0),
							end: Number(value.end ?? 0),
						};
					}),
				}
			: {}),
	};
}

function toProfile(record: ResearchRow) {
	return {
		id: record.author_handle,
		handle: record.author_handle,
		displayName: record.author_name,
		bio: record.author_bio,
		followersCount: Number(record.author_followers_count ?? 0),
		avatarHue: Number(record.author_avatar_hue ?? 0),
		avatarUrl:
			typeof record.author_avatar_url === "string"
				? record.author_avatar_url
				: undefined,
		createdAt: record.author_created_at,
	};
}

function toResearchNode(
	record: ResearchRow,
	source: ResearchNodeSource,
): ResearchNode {
	const author = toProfile(record);
	const entities = normalizeTweetEntities(
		parseJsonField(record.entities_json, {}),
	);
	return {
		id: record.id,
		url: `https://x.com/${author.handle}/status/${record.id}`,
		authorHandle: author.handle,
		authorName: author.displayName,
		createdAt: record.created_at,
		text: record.text,
		plainText: renderTweetPlainText(record.text, entities),
		markdown: renderTweetMarkdown(record.text, entities),
		likeCount: Number(record.like_count ?? 0),
		bookmarked: Boolean(record.bookmarked),
		liked: Boolean(record.liked),
		replyToTweetId: record.reply_to_id,
		quotedTweetId: record.quoted_tweet_id,
		threadDepth: Number(record.thread_depth ?? 0),
		source,
	};
}

function getTweetRowById(tweetId: string): ResearchRow | null {
	const db = getNativeDb();
	const row = db
		.prepare(
			`
      select
        t.id,
        t.account_id,
        a.handle as account_handle,
        t.kind,
        t.text,
        t.created_at,
        t.is_replied,
        t.like_count,
        t.bookmarked,
        t.liked,
        t.reply_to_id,
        t.quoted_tweet_id,
        t.entities_json,
        p.id as author_profile_id,
        p.handle as author_handle,
        p.display_name as author_name,
        p.bio as author_bio,
        p.followers_count as author_followers_count,
        p.avatar_hue as author_avatar_hue,
        p.avatar_url as author_avatar_url,
        p.created_at as author_created_at
      from tweets t
      join accounts a on a.id = t.account_id
      join profiles p on p.id = t.author_profile_id
      where t.id = ?
      `,
		)
		.get(tweetId) as ResearchRow | undefined;

	return row ?? null;
}

function getTweetDescendants(
	rootTweetId: string,
	maxThreadDepth: number,
): ResearchNode[] {
	const db = getNativeDb();
	const rows = db
		.prepare(
			`
      with recursive thread(id, depth, path) as (
        select id, 0 as depth, ',' || id || ',' as path
        from tweets
        where id = ?
        union all
        select child.id, thread.depth + 1, thread.path || child.id || ','
        from tweets child
        join thread on child.reply_to_id = thread.id
        where thread.depth < ?
          and instr(thread.path, ',' || child.id || ',') = 0
      )
      select
        t.id,
        t.account_id,
        a.handle as account_handle,
        t.kind,
        t.text,
        t.created_at,
        t.is_replied,
        t.like_count,
        t.bookmarked,
        t.liked,
        t.reply_to_id,
        t.quoted_tweet_id,
        t.entities_json,
        p.id as author_profile_id,
        p.handle as author_handle,
        p.display_name as author_name,
        p.bio as author_bio,
        p.followers_count as author_followers_count,
        p.avatar_hue as author_avatar_hue,
        p.avatar_url as author_avatar_url,
        p.created_at as author_created_at,
        thread.depth as thread_depth
      from thread
      join tweets t on t.id = thread.id
      join accounts a on a.id = t.account_id
      join profiles p on p.id = t.author_profile_id
      order by t.created_at asc, t.id asc
      `,
		)
		.all(rootTweetId, maxThreadDepth) as ResearchRow[];

	return rows.map((row) => toResearchNode(row, "local"));
}

async function lookupTweetNode(tweetId: string): Promise<ResearchNode | null> {
	const payload = await lookupTweetsByIds([tweetId]);
	const tweet = payload.data[0];
	if (!tweet) {
		return null;
	}
	const entities = normalizeTweetEntities(tweet.entities);

	const usersById = new Map(
		(payload.includes?.users ?? []).map((user: XurlMentionUser) => [
			user.id,
			user,
		]),
	);
	const author = usersById.get(tweet.author_id) ?? {
		id: tweet.author_id,
		username: `user_${tweet.author_id}`,
		name: `user_${tweet.author_id}`,
	};

	return {
		id: tweet.id,
		url: `https://x.com/${author.username}/status/${tweet.id}`,
		authorHandle: author.username,
		authorName: author.name,
		createdAt: tweet.created_at,
		text: tweet.text,
		plainText: renderTweetPlainText(tweet.text, entities),
		markdown: renderTweetMarkdown(tweet.text, entities),
		likeCount: Number(tweet.public_metrics?.like_count ?? 0),
		bookmarked: false,
		liked: false,
		replyToTweetId:
			tweet.referenced_tweets?.find((item) => item.type === "replied_to")?.id ??
			null,
		quotedTweetId:
			tweet.referenced_tweets?.find((item) => item.type === "quoted")?.id ??
			null,
		threadDepth: 0,
		source: "live",
	};
}

async function collectAncestorChain(
	tweetId: string,
	maxThreadDepth: number,
): Promise<ResearchNode[]> {
	const chain: ResearchNode[] = [];
	let currentId: string | undefined = tweetId;
	const visited = new Set<string>();
	let depth = 0;

	while (currentId && !visited.has(currentId) && depth < maxThreadDepth) {
		visited.add(currentId);
		const localRow = getTweetRowById(currentId);
		if (localRow) {
			chain.push(toResearchNode(localRow, "local"));
			currentId = localRow.reply_to_id ?? undefined;
			depth += 1;
			continue;
		}

		const remoteNode = await lookupTweetNode(currentId);
		if (!remoteNode) {
			break;
		}
		chain.push(remoteNode);
		currentId = remoteNode.replyToTweetId ?? undefined;
		depth += 1;
	}

	return chain
		.reverse()
		.map((node, index) => ({ ...node, threadDepth: index }));
}

function dedupeNodes(nodes: ResearchNode[]) {
	const seen = new Set<string>();
	const output: ResearchNode[] = [];
	for (const node of nodes) {
		if (seen.has(node.id)) {
			const existingIndex = output.findIndex((item) => item.id === node.id);
			if (
				existingIndex >= 0 &&
				output[existingIndex]?.source === "live" &&
				node.source === "local"
			) {
				output[existingIndex] = node;
			}
			continue;
		}
		seen.add(node.id);
		output.push(node);
	}
	return output;
}

function compareThreadNodes(a: ResearchNode, b: ResearchNode) {
	const byCreatedAt = a.createdAt.localeCompare(b.createdAt);
	return byCreatedAt === 0 ? a.id.localeCompare(b.id) : byCreatedAt;
}

function orderThreadNodes(rootId: string, nodes: ResearchNode[]) {
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const childrenByParentId = new Map<string, ResearchNode[]>();

	for (const node of nodes) {
		const parentId = node.replyToTweetId;
		if (!parentId || !byId.has(parentId) || node.id === rootId) {
			continue;
		}
		const siblings = childrenByParentId.get(parentId) ?? [];
		siblings.push(node);
		childrenByParentId.set(parentId, siblings);
	}

	for (const siblings of childrenByParentId.values()) {
		siblings.sort(compareThreadNodes);
	}

	const ordered: ResearchNode[] = [];
	const visited = new Set<string>();
	const visit = (node: ResearchNode, depth: number) => {
		if (visited.has(node.id)) {
			return;
		}
		visited.add(node.id);
		ordered.push({ ...node, threadDepth: depth });
		for (const child of childrenByParentId.get(node.id) ?? []) {
			visit(child, depth + 1);
		}
	};

	const root = byId.get(rootId);
	if (root) {
		visit(root, 0);
	}

	for (const node of [...nodes].sort(compareThreadNodes)) {
		if (!visited.has(node.id)) {
			visit(node, Math.max(0, node.threadDepth));
		}
	}

	return ordered;
}

function collectExternalLinks(nodes: ResearchNode[]) {
	const links = new Set<string>();
	for (const node of nodes) {
		for (const match of node.plainText.matchAll(/https?:\/\/[^\s<>\])"]+/g)) {
			links.add(match[0]);
		}
	}
	return Array.from(links);
}

function collectHandles(nodes: ResearchNode[]) {
	const handles = new Set<string>();
	for (const node of nodes) {
		handles.add(`@${node.authorHandle}`);
		for (const match of node.plainText.matchAll(/@([A-Za-z0-9_]+)/g)) {
			handles.add(`@${match[1]}`);
		}
	}
	return Array.from(handles);
}

function renderThreadMarkdown(thread: ResearchNode[]) {
	return thread
		.map((node) => {
			const indent = "  ".repeat(node.threadDepth);
			const source = node.source === "live" ? "live" : "local";
			return `${indent}- [@${node.authorHandle}](${node.url}) [${source}] ${node.markdown}`;
		})
		.join("\n");
}

function renderReportMarkdown(report: Omit<ResearchReport, "markdown">) {
	const lines = [
		"# Birdclaw Research",
		"",
		`- Generated: ${report.generatedAt}`,
		`- Query: ${report.query ? `\`${report.query}\`` : "(all bookmarks)"}`,
		`- Account: ${report.account ?? "all"}`,
		`- Seed bookmarks: ${report.seedCount}`,
		`- Threads expanded: ${report.threadCount}`,
		"",
	];

	report.items.forEach((item, index) => {
		lines.push(
			`## ${index + 1}. Seed tweet`,
			"",
			`- URL: ${item.seedUrl}`,
			`- Seed tweet: \`${item.seedTweetId}\``,
			`- Thread root: \`${item.threadRootId}\``,
			`- Seed text: ${item.seedText}`,
			"",
			"### Thread",
			"",
			renderThreadMarkdown(item.thread),
			"",
		);

		if (item.links.length > 0) {
			lines.push("### Links", "");
			for (const link of item.links) {
				lines.push(`- ${link}`);
			}
			lines.push("");
		}

		if (item.handles.length > 0) {
			lines.push("### Handles", "");
			lines.push(`- ${item.handles.join(", ")}`, "");
		}
	});

	return lines.join("\n").trimEnd() + "\n";
}

function resolveSeedTimelineItems({
	account,
	query,
	limit,
}: {
	account?: string;
	query?: string;
	limit: number;
}) {
	return listTimelineItems({
		resource: "home",
		account,
		search: query,
		bookmarkedOnly: true,
		includeReplies: true,
		qualityFilter: "all",
		limit,
	});
}

export async function runResearchMode(
	options: ResearchOptions = {},
): Promise<ResearchReport> {
	const limit = Number.isFinite(options.limit ?? 20)
		? Math.max(1, Math.floor(options.limit ?? 20))
		: 20;
	const maxThreadDepth = Number.isFinite(options.maxThreadDepth ?? 10)
		? Math.max(1, Math.floor(options.maxThreadDepth ?? 10))
		: 10;
	const seeds = resolveSeedTimelineItems({
		account: options.account,
		query: options.query,
		limit,
	});

	const items: ResearchThread[] = [];
	for (const seed of seeds) {
		const ancestorChain = await collectAncestorChain(seed.id, maxThreadDepth);
		const rootId = ancestorChain[0]?.id ?? seed.id;
		const localThread = getTweetDescendants(rootId, maxThreadDepth);
		const thread = orderThreadNodes(
			rootId,
			dedupeNodes([...ancestorChain, ...localThread]),
		);
		const links = collectExternalLinks(thread);
		const handles = collectHandles(thread);
		items.push({
			seedTweetId: seed.id,
			seedUrl: `https://x.com/${seed.author.handle}/status/${seed.id}`,
			seedText: renderTweetPlainText(seed.text, seed.entities),
			threadRootId: rootId,
			thread,
			links,
			handles,
		});
	}

	const reportBase = {
		query: options.query,
		account: options.account,
		generatedAt: new Date().toISOString(),
		seedCount: seeds.length,
		threadCount: items.length,
		items,
	};
	const markdown = renderReportMarkdown(reportBase);
	const report: ResearchReport = {
		...reportBase,
		markdown,
	};

	if (options.outPath) {
		const resolved = path.resolve(options.outPath);
		mkdirSync(path.dirname(resolved), { recursive: true });
		writeFileSync(resolved, markdown, "utf8");
	}

	return report;
}

export type { ResearchRow };
