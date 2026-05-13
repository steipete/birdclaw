import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { getNativeDb } from "./db";

const execFileAsync = promisify(execFile);
const ARCHIVE_JSON_PAYLOAD = /=\s*(\[[\s\S]*\]|\{[\s\S]*\})/s;

interface ArchiveAccountPayload {
	accountId: string;
	username: string;
	displayName: string;
	createdAt: string;
	bio: string;
}

interface ImportedArchiveSummary {
	ok: true;
	archivePath: string;
	account: {
		id: string;
		handle: string;
		displayName: string;
	};
	counts: {
		tweets: number;
		likes: number;
		bookmarks: number;
		dmConversations: number;
		dmMessages: number;
		profiles: number;
		followers: number;
		following: number;
	};
}

type ArchiveRecord = Record<string, unknown>;
type ArchiveFollowDirection = "followers" | "following";
type ArchiveFollowKey = "follower" | "following";

function normalizeArchivePath(value: string) {
	return value.replaceAll("\\", "/");
}

function extractArchiveJson(content: string): unknown {
	const match = ARCHIVE_JSON_PAYLOAD.exec(content);
	if (!match) {
		return [];
	}

	return JSON.parse(match[1]);
}

function parseArchiveArray(content: string): ArchiveRecord[] {
	const parsed = extractArchiveJson(content);
	return Array.isArray(parsed)
		? parsed.filter((item): item is ArchiveRecord => Boolean(item))
		: [];
}

async function runUnzip(
	_archivePath: string,
	args: string[],
	maxBuffer = 1024 * 1024 * 256,
) {
	const { stdout } = await execFileAsync("unzip", args, {
		maxBuffer,
	});
	return stdout;
}

async function listArchiveEntries(archivePath: string) {
	const stdout = await runUnzip(
		archivePath,
		["-Z1", archivePath],
		1024 * 1024 * 64,
	);
	return stdout
		.split("\n")
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}

async function readArchiveEntry(archivePath: string, entryPath: string) {
	return runUnzip(archivePath, ["-p", archivePath, entryPath]);
}

function getFirstEntry(entries: string[], pattern: RegExp) {
	return entries.find((entry) => pattern.test(normalizeArchivePath(entry)));
}

function getMatchingEntries(entries: string[], pattern: RegExp) {
	return entries.filter((entry) => pattern.test(normalizeArchivePath(entry)));
}

function parseTwitterDate(value: unknown) {
	if (typeof value !== "string" || value.length === 0) {
		return new Date(0).toISOString();
	}

	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime())
		? new Date(0).toISOString()
		: parsed.toISOString();
}

function compareIsoTimestamp(left: string, right: string) {
	return left < right ? -1 : left > right ? 1 : 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function asArray<T>(value: unknown): T[] {
	return Array.isArray(value) ? (value as T[]) : [];
}

function toInt(value: unknown) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function getTweetMediaCount(tweet: Record<string, unknown>) {
	const entities = asRecord(tweet.entities);
	const extendedEntities = asRecord(tweet.extended_entities);
	const entitiesMedia = asArray(entities?.media);
	const extendedMedia = asArray(extendedEntities?.media);
	return Math.max(entitiesMedia.length, extendedMedia.length);
}

function extractTweetEntities(tweet: Record<string, unknown>) {
	const entities = asRecord(tweet.entities);
	const urls = asArray<Record<string, unknown>>(entities?.urls)
		.map((entry) => ({
			url: String(entry.url ?? ""),
			expandedUrl: String(
				entry.expanded_url ?? entry.expandedUrl ?? entry.url ?? "",
			),
			displayUrl: String(
				entry.display_url ??
					entry.displayUrl ??
					entry.expanded_url ??
					entry.url ??
					"",
			),
			start: Number(asArray<number>(entry.indices)[0] ?? 0),
			end: Number(asArray<number>(entry.indices)[1] ?? 0),
			title: typeof entry.title === "string" ? entry.title : undefined,
			description:
				typeof entry.description === "string" ? entry.description : null,
			imageUrl:
				typeof entry.image_url === "string"
					? entry.image_url
					: typeof entry.imageUrl === "string"
						? entry.imageUrl
						: typeof entry.thumbnail_url === "string"
							? entry.thumbnail_url
							: undefined,
			siteName:
				typeof entry.site_name === "string"
					? entry.site_name
					: typeof entry.siteName === "string"
						? entry.siteName
						: undefined,
		}))
		.filter((entry) => entry.url.length > 0 || entry.expandedUrl.length > 0);
	const mentions = asArray<Record<string, unknown>>(entities?.user_mentions)
		.map((entry) => ({
			username: String(entry.screen_name ?? ""),
			id: String(entry.id_str ?? entry.id ?? ""),
			start: Number(asArray<number>(entry.indices)[0] ?? 0),
			end: Number(asArray<number>(entry.indices)[1] ?? 0),
		}))
		.filter((entry) => entry.username.length > 0);
	const hashtags = asArray<Record<string, unknown>>(entities?.hashtags)
		.map((entry) => ({
			tag: String(entry.text ?? ""),
			start: Number(asArray<number>(entry.indices)[0] ?? 0),
			end: Number(asArray<number>(entry.indices)[1] ?? 0),
		}))
		.filter((entry) => entry.tag.length > 0);

	return {
		...(urls.length > 0 ? { urls } : {}),
		...(mentions.length > 0 ? { mentions } : {}),
		...(hashtags.length > 0 ? { hashtags } : {}),
	};
}

function extractTweetMedia(tweet: Record<string, unknown>) {
	const extendedEntities = asRecord(tweet.extended_entities);
	const entities = asRecord(tweet.entities);
	const sourceMedia = [
		...asArray<Record<string, unknown>>(extendedEntities?.media),
		...asArray<Record<string, unknown>>(entities?.media),
	];
	const seen = new Set<string>();

	return sourceMedia
		.map((entry) => {
			const url = String(
				entry.media_url_https ?? entry.media_url ?? entry.url ?? "",
			);
			const thumbnailUrl = String(
				entry.media_url_https ?? entry.media_url ?? url,
			);
			const type = String(entry.type ?? "image");
			return {
				url,
				type:
					type === "photo"
						? "image"
						: type === "video" || type === "animated_gif"
							? type === "animated_gif"
								? "gif"
								: "video"
							: "unknown",
				altText:
					typeof entry.ext_alt_text === "string"
						? entry.ext_alt_text
						: undefined,
				thumbnailUrl,
			};
		})
		.filter((entry) => {
			if (!entry.url || seen.has(entry.url)) {
				return false;
			}
			seen.add(entry.url);
			return true;
		});
}

function extractCollectionTweet(
	wrapper: ArchiveRecord,
	key: "like" | "bookmark",
) {
	const entry = asRecord(wrapper[key]) ?? asRecord(wrapper.tweet);
	if (!entry) return null;

	const id = String(
		entry.tweetId ?? entry.tweet_id ?? entry.id_str ?? entry.id ?? "",
	);
	if (!id) return null;

	return {
		id,
		text: String(
			entry.fullText ??
				entry.full_text ??
				entry.text ??
				entry.expandedUrl ??
				entry.expanded_url ??
				"",
		),
		createdAt: parseTwitterDate(
			entry.likedAt ??
				entry.bookmarkedAt ??
				entry.createdAt ??
				entry.created_at ??
				new Date(0).toISOString(),
		),
		likeCount: toInt(entry.favorite_count ?? entry.like_count),
	};
}

function buildAccountPayload(
	accountRecord: Record<string, unknown> | null,
	profileRecord: Record<string, unknown> | null,
): ArchiveAccountPayload {
	const account = asRecord(accountRecord?.account);
	const profile = asRecord(profileRecord?.profile);
	const description = asRecord(profile?.description);

	return {
		accountId: String(account?.accountId ?? "unknown"),
		username: String(account?.username ?? "unknown"),
		displayName: String(
			account?.accountDisplayName ??
				account?.name ??
				account?.username ??
				"Unknown",
		),
		createdAt: parseTwitterDate(account?.createdAt),
		bio: String(description?.bio ?? ""),
	};
}

function inferProfileFromDirectory(
	userId: string,
	directory: Map<string, { handle?: string; displayName?: string }>,
) {
	const match = directory.get(userId);
	const handle = match?.handle?.replace(/^@/, "") || `id${userId}`;
	const displayName = match?.displayName || handle;
	return { handle, displayName };
}

function getArchiveFollowRows(content: string, key: ArchiveFollowKey) {
	const rows: Array<{ profileId: string; externalUserId: string }> = [];

	for (const wrapper of parseArchiveArray(content)) {
		const item = asRecord(wrapper[key]);
		const externalUserId = String(item?.accountId ?? "");
		if (!externalUserId) continue;

		rows.push({
			profileId: `profile_user_${externalUserId}`,
			externalUserId,
		});
	}

	return rows;
}

function clearImportedData() {
	const db = getNativeDb();
	db.exec(`
    delete from ai_scores;
    delete from tweet_actions;
    delete from tweet_account_edges;
    delete from tweet_collections;
    delete from link_occurrences;
    delete from url_expansions;
    delete from dm_fts;
    delete from tweets_fts;
    delete from dm_messages;
    delete from dm_conversations;
    delete from tweets;
    delete from profiles;
    delete from accounts;
  `);
}

export async function importArchive(
	archivePath: string,
): Promise<ImportedArchiveSummary> {
	const entries = await listArchiveEntries(archivePath);
	const accountEntry = getFirstEntry(entries, /(?:^|\/)data\/account\.js$/i);
	const profileEntry = getFirstEntry(entries, /(?:^|\/)data\/profile\.js$/i);
	const tweetEntries = getMatchingEntries(
		entries,
		/(?:^|\/)data\/(?:tweets|community-tweet)(?:-part\d+)?\.js$/i,
	);
	const noteTweetEntries = getMatchingEntries(
		entries,
		/(?:^|\/)data\/note-tweet(?:-part\d+)?\.js$/i,
	);
	const likeEntries = getMatchingEntries(
		entries,
		/(?:^|\/)data\/(?:like|likes)(?:-part\d+)?\.js$/i,
	);
	const bookmarkEntries = getMatchingEntries(
		entries,
		/(?:^|\/)data\/(?:bookmark|bookmarks)(?:-part\d+)?\.js$/i,
	);
	const dmEntries = getMatchingEntries(
		entries,
		/(?:^|\/)data\/direct-messages(?:-group)?(?:-part\d+)?\.js$/i,
	);
	const followerEntries = getMatchingEntries(
		entries,
		/(?:^|\/)data\/follower(?:-part\d+)?\.js$/i,
	);
	const followingEntries = getMatchingEntries(
		entries,
		/(?:^|\/)data\/following(?:-part\d+)?\.js$/i,
	);

	if (!accountEntry) {
		throw new Error("Archive missing data/account.js");
	}

	const [accountContent, profileContent] = await Promise.all([
		readArchiveEntry(archivePath, accountEntry),
		profileEntry
			? readArchiveEntry(archivePath, profileEntry)
			: Promise.resolve("[]"),
	]);

	const accountPayload = buildAccountPayload(
		parseArchiveArray(accountContent)[0] ?? null,
		parseArchiveArray(profileContent)[0] ?? null,
	);

	const mentionDirectory = new Map<
		string,
		{ handle?: string; displayName?: string }
	>();
	const tweetRows: Array<{
		id: string;
		kind: "home" | "like" | "bookmark";
		authorProfileId: string;
		text: string;
		createdAt: string;
		isReplied: number;
		replyToId: string | null;
		likeCount: number;
		mediaCount: number;
		bookmarked: number;
		liked: number;
		entitiesJson: string;
		mediaJson: string;
		quotedTweetId: string | null;
	}> = [];
	const collectionRows: Array<{
		tweetId: string;
		kind: "likes" | "bookmarks";
		collectedAt: string | null;
		source: string;
		rawJson: string;
	}> = [];
	const tweetRowsById = new Map<string, (typeof tweetRows)[number]>();

	function addTweetRow(row: (typeof tweetRows)[number]) {
		const existing = tweetRowsById.get(row.id);
		if (existing) {
			existing.bookmarked = Math.max(existing.bookmarked, row.bookmarked);
			existing.liked = Math.max(existing.liked, row.liked);
			if (!existing.text && row.text) existing.text = row.text;
			return;
		}
		tweetRows.push(row);
		tweetRowsById.set(row.id, row);
	}

	for (const entry of tweetEntries) {
		const content = await readArchiveEntry(archivePath, entry);
		for (const wrapper of parseArchiveArray(content)) {
			const tweet = asRecord(wrapper.tweet);
			if (!tweet) continue;

			for (const mention of asArray<Record<string, unknown>>(
				asRecord(tweet.entities)?.user_mentions,
			)) {
				const mentionId = String(mention.id_str ?? mention.id ?? "");
				if (!mentionId) continue;
				mentionDirectory.set(mentionId, {
					handle: String(mention.screen_name ?? ""),
					displayName: String(mention.name ?? mention.screen_name ?? mentionId),
				});
			}

			const replyUserId = String(
				tweet.in_reply_to_user_id_str ?? tweet.in_reply_to_user_id ?? "",
			);
			const replyScreenName = String(tweet.in_reply_to_screen_name ?? "");
			if (replyUserId && replyScreenName) {
				mentionDirectory.set(replyUserId, {
					handle: replyScreenName,
					displayName: replyScreenName,
				});
			}

			addTweetRow({
				id: String(tweet.id_str ?? tweet.id),
				kind: "home",
				authorProfileId: "profile_me",
				text: String(tweet.full_text ?? tweet.text ?? ""),
				createdAt: parseTwitterDate(tweet.created_at),
				isReplied: tweet.in_reply_to_status_id_str ? 1 : 0,
				replyToId: tweet.in_reply_to_status_id_str
					? String(tweet.in_reply_to_status_id_str)
					: null,
				likeCount: toInt(tweet.favorite_count),
				mediaCount: getTweetMediaCount(tweet),
				bookmarked: 0,
				liked: 0,
				entitiesJson: JSON.stringify(extractTweetEntities(tweet)),
				mediaJson: JSON.stringify(extractTweetMedia(tweet)),
				quotedTweetId: tweet.quoted_status_id_str
					? String(tweet.quoted_status_id_str)
					: null,
			});
		}
	}

	for (const entry of noteTweetEntries) {
		const content = await readArchiveEntry(archivePath, entry);
		for (const wrapper of parseArchiveArray(content)) {
			const noteTweet = asRecord(wrapper.noteTweet);
			if (!noteTweet) continue;
			const core = asRecord(noteTweet.core);
			addTweetRow({
				id: String(noteTweet.noteTweetId ?? noteTweet.id ?? randomUUID()),
				kind: "home",
				authorProfileId: "profile_me",
				text: String(core?.text ?? ""),
				createdAt: parseTwitterDate(noteTweet.createdAt),
				isReplied: 0,
				replyToId: null,
				likeCount: 0,
				mediaCount: 0,
				bookmarked: 0,
				liked: 0,
				entitiesJson: "{}",
				mediaJson: "[]",
				quotedTweetId: null,
			});
		}
	}
	const authoredTweetCount = tweetRows.length;

	type MessageRow = {
		id: string;
		conversationId: string;
		senderProfileId: string;
		text: string;
		createdAt: string;
		direction: "inbound" | "outbound";
		mediaCount: number;
	};

	const profiles = new Map<
		string,
		{
			id: string;
			handle: string;
			displayName: string;
			bio: string;
			followersCount: number;
			followingCount: number;
			publicMetricsJson: string;
			avatarHue: number;
			avatarUrl: string | null;
			location: string | null;
			url: string | null;
			verifiedType: string | null;
			entitiesJson: string;
			rawJson: string;
			createdAt: string;
		}
	>();
	const defaultProfileMetadata = {
		publicMetricsJson: "{}",
		location: null,
		url: null,
		verifiedType: null,
		entitiesJson: "{}",
		rawJson: "{}",
	};
	const conversations = new Map<
		string,
		{
			id: string;
			title: string;
			accountId: string;
			participantProfileId: string;
			lastMessageAt: string;
			unreadCount: number;
			needsReply: number;
		}
	>();
	const dmMessages: MessageRow[] = [];
	const followerRows: Array<{ profileId: string; externalUserId: string }> = [];
	const followingRows: Array<{ profileId: string; externalUserId: string }> =
		[];
	const followerIds = new Set<string>();
	const followingIds = new Set<string>();
	const existingProfiles = new Map(
		(
			getNativeDb()
				.prepare(
					`
	        select id, handle, display_name, bio, followers_count, following_count,
	          public_metrics_json, avatar_hue, avatar_url, location, url,
	          verified_type, entities_json, raw_json, created_at
	        from profiles
	      `,
				)
				.all() as Array<{
				id: string;
				handle: string;
				display_name: string;
				bio: string;
				followers_count: number;
				following_count: number;
				public_metrics_json: string;
				avatar_hue: number;
				avatar_url: string | null;
				location: string | null;
				url: string | null;
				verified_type: string | null;
				entities_json: string;
				raw_json: string;
				created_at: string;
			}>
		).map((profile) => [profile.id, profile]),
	);

	function addArchiveFollowProfile(profileId: string, externalUserId: string) {
		if (!profileId) return;
		const existing = existingProfiles.get(profileId);
		if (existing) {
			profiles.set(profileId, {
				id: profileId,
				handle: existing.handle,
				displayName: existing.display_name,
				bio: existing.bio,
				followersCount: existing.followers_count,
				followingCount: existing.following_count,
				publicMetricsJson: existing.public_metrics_json,
				avatarHue: existing.avatar_hue,
				avatarUrl: existing.avatar_url,
				location: existing.location,
				url: existing.url,
				verifiedType: existing.verified_type,
				entitiesJson: existing.entities_json,
				rawJson: existing.raw_json,
				createdAt: existing.created_at,
			});
			return;
		}
		if (profiles.has(profileId)) return;
		const fallbackId =
			externalUserId || profileId.replace(/^profile_user_/, "");
		profiles.set(profileId, {
			id: profileId,
			handle: fallbackId ? `id${fallbackId}` : profileId,
			displayName: "",
			bio: "",
			followersCount: 0,
			followingCount: 0,
			...defaultProfileMetadata,
			avatarHue: 210,
			avatarUrl: null,
			createdAt: accountPayload.createdAt,
		});
	}

	const localProfile = {
		id: "profile_me",
		handle: accountPayload.username,
		displayName: accountPayload.displayName,
		bio: accountPayload.bio,
		followersCount: 0,
		followingCount: 0,
		...defaultProfileMetadata,
		avatarHue: 18,
		avatarUrl: null,
		createdAt: accountPayload.createdAt,
	};
	profiles.set(localProfile.id, localProfile);

	for (const entry of dmEntries) {
		const content = await readArchiveEntry(archivePath, entry);
		for (const wrapper of parseArchiveArray(content)) {
			const dmConversation = asRecord(wrapper.dmConversation);
			if (!dmConversation) continue;

			const conversationId = String(dmConversation.conversationId ?? "");
			if (!conversationId) continue;

			const conversationName = String(dmConversation.name ?? "").trim();
			const participantIds = new Set<string>();
			const rawMessages = asArray<Record<string, unknown>>(
				dmConversation.messages,
			);

			for (const event of rawMessages) {
				const messageCreate = asRecord(event.messageCreate);
				if (messageCreate) {
					const senderId = String(messageCreate.senderId ?? "");
					const recipientId = String(messageCreate.recipientId ?? "");
					if (senderId) participantIds.add(senderId);
					if (recipientId) participantIds.add(recipientId);
				}

				const joinConversation = asRecord(event.joinConversation);
				if (joinConversation) {
					for (const userId of asArray<string>(
						joinConversation.participantsSnapshot,
					)) {
						participantIds.add(String(userId));
					}
				}

				const participantsJoin = asRecord(event.participantsJoin);
				if (participantsJoin) {
					for (const userId of asArray<string>(participantsJoin.userIds)) {
						participantIds.add(String(userId));
					}
					const initiatingUserId = String(
						participantsJoin.initiatingUserId ?? "",
					);
					if (initiatingUserId) {
						participantIds.add(initiatingUserId);
					}
				}

				const participantsLeave = asRecord(event.participantsLeave);
				if (participantsLeave) {
					for (const userId of asArray<string>(participantsLeave.userIds)) {
						participantIds.add(String(userId));
					}
					const initiatingUserId = String(
						participantsLeave.initiatingUserId ?? "",
					);
					if (initiatingUserId) {
						participantIds.add(initiatingUserId);
					}
				}
			}

			const externalParticipantIds = [...participantIds].filter(
				(userId) => userId && userId !== accountPayload.accountId,
			);
			const isGroup =
				conversationName.length > 0 || externalParticipantIds.length > 1;
			const participantProfileId = isGroup
				? `profile_group_${conversationId}`
				: `profile_user_${externalParticipantIds[0] ?? conversationId}`;

			if (!profiles.has(participantProfileId)) {
				if (isGroup) {
					profiles.set(participantProfileId, {
						id: participantProfileId,
						handle: `group-${conversationId}`,
						displayName:
							conversationName || `Group DM ${externalParticipantIds.length}`,
						bio: `Group DM with ${externalParticipantIds.length} participants`,
						followersCount: 0,
						followingCount: 0,
						...defaultProfileMetadata,
						avatarHue: 220,
						avatarUrl: null,
						createdAt: accountPayload.createdAt,
					});
				} else {
					const otherUserId = externalParticipantIds[0] ?? conversationId;
					const existing = existingProfiles.get(participantProfileId);
					if (existing) {
						profiles.set(participantProfileId, {
							id: participantProfileId,
							handle: existing.handle,
							displayName: existing.display_name,
							bio: existing.bio,
							followersCount: existing.followers_count,
							followingCount: existing.following_count,
							publicMetricsJson: existing.public_metrics_json,
							avatarHue: existing.avatar_hue,
							avatarUrl: existing.avatar_url,
							location: existing.location,
							url: existing.url,
							verifiedType: existing.verified_type,
							entitiesJson: existing.entities_json,
							rawJson: existing.raw_json,
							createdAt: existing.created_at,
						});
					} else {
						const inferred = inferProfileFromDirectory(
							otherUserId,
							mentionDirectory,
						);
						profiles.set(participantProfileId, {
							id: participantProfileId,
							handle: inferred.handle,
							displayName: inferred.displayName,
							bio: `Imported from archive user ${otherUserId}`,
							followersCount: 0,
							followingCount: 0,
							...defaultProfileMetadata,
							avatarHue: 210,
							avatarUrl: null,
							createdAt: accountPayload.createdAt,
						});
					}
				}
			}

			const messageEvents = rawMessages
				.map((event) => asRecord(event.messageCreate))
				.filter((event): event is Record<string, unknown> => event !== null)
				.map((messageCreate) => {
					const senderId = String(messageCreate.senderId ?? "");
					const senderProfileId =
						senderId === accountPayload.accountId
							? "profile_me"
							: `profile_user_${senderId}`;

					if (senderId && senderId !== accountPayload.accountId) {
						const inferred = inferProfileFromDirectory(
							senderId,
							mentionDirectory,
						);
						if (!profiles.has(senderProfileId)) {
							profiles.set(senderProfileId, {
								id: senderProfileId,
								handle: inferred.handle,
								displayName: inferred.displayName,
								bio: `Imported from archive user ${senderId}`,
								followersCount: 0,
								followingCount: 0,
								...defaultProfileMetadata,
								avatarHue: 240,
								avatarUrl: null,
								createdAt: accountPayload.createdAt,
							});
						}
					}

					return {
						id: String(messageCreate.id ?? `${conversationId}-${senderId}`),
						conversationId,
						senderProfileId,
						text: String(messageCreate.text ?? ""),
						createdAt: parseTwitterDate(messageCreate.createdAt),
						direction:
							senderId === accountPayload.accountId ? "outbound" : "inbound",
						mediaCount: asArray(messageCreate.mediaUrls).length,
					} satisfies MessageRow;
				})
				.sort((left, right) =>
					compareIsoTimestamp(left.createdAt, right.createdAt),
				);

			if (messageEvents.length === 0) {
				continue;
			}

			const lastMessage = messageEvents.at(-1);
			if (!lastMessage) continue;

			dmMessages.push(...messageEvents);
			conversations.set(conversationId, {
				id: conversationId,
				title:
					profiles.get(participantProfileId)?.displayName ||
					conversationName ||
					conversationId,
				accountId: "acct_primary",
				participantProfileId,
				lastMessageAt: lastMessage.createdAt,
				unreadCount: 0,
				needsReply: lastMessage.direction === "inbound" ? 1 : 0,
			});
		}
	}

	let likeCount = 0;
	for (const entry of likeEntries) {
		const content = await readArchiveEntry(archivePath, entry);
		const likes = parseArchiveArray(content);
		for (const like of likes) {
			const tweet = extractCollectionTweet(like, "like");
			if (!tweet) continue;
			collectionRows.push({
				tweetId: tweet.id,
				kind: "likes",
				collectedAt: tweet.createdAt,
				source: "archive",
				rawJson: JSON.stringify(like),
			});
			addTweetRow({
				id: tweet.id,
				kind: "like",
				authorProfileId: "profile_unknown",
				text: tweet.text,
				createdAt: tweet.createdAt,
				isReplied: 0,
				replyToId: null,
				likeCount: tweet.likeCount,
				mediaCount: 0,
				bookmarked: 0,
				liked: 1,
				entitiesJson: "{}",
				mediaJson: "[]",
				quotedTweetId: null,
			});
		}
		likeCount += likes.length;
	}

	let bookmarkCount = 0;
	for (const entry of bookmarkEntries) {
		const content = await readArchiveEntry(archivePath, entry);
		const bookmarks = parseArchiveArray(content);
		for (const bookmark of bookmarks) {
			const tweet = extractCollectionTweet(bookmark, "bookmark");
			if (!tweet) continue;
			collectionRows.push({
				tweetId: tweet.id,
				kind: "bookmarks",
				collectedAt: tweet.createdAt,
				source: "archive",
				rawJson: JSON.stringify(bookmark),
			});
			addTweetRow({
				id: tweet.id,
				kind: "bookmark",
				authorProfileId: "profile_unknown",
				text: tweet.text,
				createdAt: tweet.createdAt,
				isReplied: 0,
				replyToId: null,
				likeCount: tweet.likeCount,
				mediaCount: 0,
				bookmarked: 1,
				liked: 0,
				entitiesJson: "{}",
				mediaJson: "[]",
				quotedTweetId: null,
			});
		}
		bookmarkCount += bookmarks.length;
	}

	for (const entry of followerEntries) {
		const content = await readArchiveEntry(archivePath, entry);
		for (const row of getArchiveFollowRows(content, "follower")) {
			if (followerIds.has(row.externalUserId)) continue;
			followerIds.add(row.externalUserId);
			followerRows.push(row);
		}
	}

	for (const entry of followingEntries) {
		const content = await readArchiveEntry(archivePath, entry);
		for (const row of getArchiveFollowRows(content, "following")) {
			if (followingIds.has(row.externalUserId)) continue;
			followingIds.add(row.externalUserId);
			followingRows.push(row);
		}
	}

	for (const row of [...followerRows, ...followingRows]) {
		addArchiveFollowProfile(row.profileId, row.externalUserId);
	}

	const clearedFollowDirections = new Set<ArchiveFollowDirection>();
	if (followerEntries.length === 0) clearedFollowDirections.add("followers");
	if (followingEntries.length === 0) clearedFollowDirections.add("following");
	const retainedFollowProfiles = getNativeDb()
		.prepare(
			`
      select direction, profile_id, external_user_id, source, null as snapshot_id, null as snapshot_source
      from follow_edges
      union
      select ev.direction, ev.profile_id, ev.external_user_id, null as source, ev.snapshot_id, snap.source as snapshot_source
      from follow_events ev
      left join follow_snapshots snap on snap.id = ev.snapshot_id
      `,
		)
		.all() as Array<{
		direction: ArchiveFollowDirection;
		profile_id: string;
		external_user_id: string;
		source: string | null;
		snapshot_id: string | null;
		snapshot_source: string | null;
	}>;
	for (const row of retainedFollowProfiles) {
		const isClearedArchiveRow =
			clearedFollowDirections.has(row.direction) &&
			(row.source === "archive" ||
				row.snapshot_source === "archive" ||
				row.snapshot_id ===
					`follow_snapshot_archive_acct_primary_${row.direction}`);
		if (isClearedArchiveRow) continue;
		addArchiveFollowProfile(row.profile_id, row.external_user_id);
	}

	if (tweetRows.some((tweet) => tweet.authorProfileId === "profile_unknown")) {
		profiles.set("profile_unknown", {
			id: "profile_unknown",
			handle: "unknown",
			displayName: "Unknown",
			bio: "Imported from archive collection metadata",
			followersCount: 0,
			followingCount: 0,
			...defaultProfileMetadata,
			avatarHue: 210,
			avatarUrl: null,
			createdAt: accountPayload.createdAt,
		});
	}

	clearImportedData();

	const db = getNativeDb();
	const insertAccount = db.prepare(`
    insert into accounts (id, name, handle, external_user_id, transport, is_default, created_at)
    values (?, ?, ?, ?, ?, 1, ?)
  `);
	const insertProfile = db.prepare(`
	    insert into profiles (
	      id, handle, display_name, bio, followers_count, following_count,
	      public_metrics_json, avatar_hue, avatar_url, location, url, verified_type,
	      entities_json, raw_json, created_at
	    )
	    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	  `);
	const insertTweet = db.prepare(`
    insert into tweets (
      id, account_id, author_profile_id, kind, text, created_at, is_replied,
      reply_to_id, like_count, media_count, bookmarked, liked, entities_json, media_json, quoted_tweet_id
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
	const insertTweetFts = db.prepare(
		"insert into tweets_fts (tweet_id, text) values (?, ?)",
	);
	const insertTimelineEdge = db.prepare(`
    insert into tweet_account_edges (
      account_id, tweet_id, kind, first_seen_at, last_seen_at, seen_count, source,
      raw_json, updated_at
    ) values (?, ?, ?, ?, ?, 1, 'archive', '{}', ?)
    on conflict(account_id, tweet_id, kind) do update set
      first_seen_at = min(tweet_account_edges.first_seen_at, excluded.first_seen_at),
      last_seen_at = max(tweet_account_edges.last_seen_at, excluded.last_seen_at),
      updated_at = max(tweet_account_edges.updated_at, excluded.updated_at)
  `);
	const insertCollection = db.prepare(`
    insert into tweet_collections (
      account_id, tweet_id, kind, collected_at, source, raw_json, updated_at
    ) values (?, ?, ?, ?, ?, ?, ?)
    on conflict(account_id, tweet_id, kind) do update set
      collected_at = coalesce(excluded.collected_at, tweet_collections.collected_at),
      source = excluded.source,
      raw_json = excluded.raw_json,
      updated_at = excluded.updated_at
  `);
	const insertConversation = db.prepare(`
    insert into dm_conversations (
      id, account_id, participant_profile_id, title, last_message_at, unread_count, needs_reply
    ) values (?, ?, ?, ?, ?, ?, ?)
  `);
	const insertMessage = db.prepare(`
    insert into dm_messages (
      id, conversation_id, sender_profile_id, text, created_at, direction, is_replied, media_count
    ) values (?, ?, ?, ?, ?, ?, ?, ?)
  `);
	const insertDmFts = db.prepare(
		"insert into dm_fts (message_id, text) values (?, ?)",
	);
	const insertFollowSnapshot = db.prepare(`
    insert into follow_snapshots (
      id, account_id, direction, source, status, page_count, result_count,
      started_at, completed_at, raw_meta_json
    ) values (?, ?, ?, 'archive', 'complete', ?, ?, ?, ?, ?)
    on conflict(id) do update set
      account_id = excluded.account_id,
      direction = excluded.direction,
      source = excluded.source,
      status = excluded.status,
      page_count = excluded.page_count,
      result_count = excluded.result_count,
      started_at = excluded.started_at,
      completed_at = excluded.completed_at,
      raw_meta_json = excluded.raw_meta_json
  `);
	const insertFollowSnapshotMember = db.prepare(`
    insert into follow_snapshot_members (
      snapshot_id, profile_id, external_user_id, position
    ) values (?, ?, ?, ?)
  `);
	const selectFollowSnapshotMembers = db.prepare(`
    select profile_id, external_user_id
    from follow_snapshot_members
    where snapshot_id = ?
    order by position, profile_id
  `);
	const deleteFollowSnapshotMembers = db.prepare(
		"delete from follow_snapshot_members where snapshot_id = ?",
	);
	const deleteArchiveFollowEvents = db.prepare(`
    delete from follow_events
    where account_id = ? and direction = ? and (
      snapshot_id = ? or snapshot_id in (
        select id from follow_snapshots
        where account_id = ? and direction = ? and source = 'archive'
      )
    )
  `);
	const deleteArchiveFollowSnapshotMembers = db.prepare(`
    delete from follow_snapshot_members
    where snapshot_id in (
      select id from follow_snapshots
      where account_id = ? and direction = ? and source = 'archive'
    )
  `);
	const deleteArchiveFollowSnapshots = db.prepare(`
    delete from follow_snapshots
    where account_id = ? and direction = ? and source = 'archive'
  `);
	const deleteArchiveFollowEdges = db.prepare(`
    delete from follow_edges
    where account_id = ? and direction = ? and source = 'archive'
  `);
	const selectFollowEdges = db.prepare(`
    select profile_id, external_user_id, current
    from follow_edges
    where account_id = ? and direction = ?
  `);
	const insertFollowEdge = db.prepare(`
    insert into follow_edges (
      account_id, direction, profile_id, external_user_id, source, current,
      first_seen_at, last_seen_at, ended_at, updated_at
    ) values (?, ?, ?, ?, 'archive', 1, ?, ?, null, ?)
    on conflict(account_id, direction, profile_id) do update set
      external_user_id = excluded.external_user_id,
      source = case
        when follow_edges.source = 'archive' then excluded.source
        else follow_edges.source
      end,
      current = 1,
      last_seen_at = excluded.last_seen_at,
      ended_at = null,
      updated_at = excluded.updated_at
  `);
	const endFollowEdge = db.prepare(`
    update follow_edges
    set current = 0, ended_at = ?, updated_at = ?
    where account_id = ? and direction = ? and profile_id = ?
  `);
	const insertFollowEvent = db.prepare(`
    insert into follow_events (
      id, account_id, direction, profile_id, external_user_id, kind, event_at, snapshot_id
    ) values (?, ?, ?, ?, ?, ?, ?, ?)
  `);

	function importFollowRows(
		direction: ArchiveFollowDirection,
		rows: Array<{ profileId: string; externalUserId: string }>,
		entryCount: number,
		now: string,
	) {
		const snapshotId = `follow_snapshot_archive_acct_primary_${direction}`;
		const existingEdges = new Map(
			(
				selectFollowEdges.all("acct_primary", direction) as Array<{
					profile_id: string;
					external_user_id: string;
					current: number;
				}>
			).map((row) => [row.profile_id, row]),
		);
		const existingMemberKey = (
			selectFollowSnapshotMembers.all(snapshotId) as Array<{
				profile_id: string;
				external_user_id: string;
			}>
		)
			.map(
				(row, index) =>
					`${String(index)}:${row.profile_id}:${row.external_user_id}`,
			)
			.join("\n");
		const nextMemberKey = rows
			.map(
				(row, index) =>
					`${String(index)}:${row.profileId}:${row.externalUserId}`,
			)
			.join("\n");
		const membersChanged = existingMemberKey !== nextMemberKey;
		const currentProfileIds = new Set<string>();

		insertFollowSnapshot.run(
			snapshotId,
			"acct_primary",
			direction,
			entryCount,
			rows.length,
			now,
			now,
			JSON.stringify({ archivePath, result_count: rows.length }),
		);

		if (membersChanged) {
			deleteFollowSnapshotMembers.run(snapshotId);
		}
		rows.forEach((row, index) => {
			currentProfileIds.add(row.profileId);
			if (membersChanged) {
				insertFollowSnapshotMember.run(
					snapshotId,
					row.profileId,
					row.externalUserId,
					index,
				);
			}

			const previous = existingEdges.get(row.profileId);
			insertFollowEdge.run(
				"acct_primary",
				direction,
				row.profileId,
				row.externalUserId,
				now,
				now,
				now,
			);
			if (!previous || previous.current === 0) {
				insertFollowEvent.run(
					`follow_event_${randomUUID()}`,
					"acct_primary",
					direction,
					row.profileId,
					row.externalUserId,
					"started",
					now,
					snapshotId,
				);
			}
		});

		for (const [profileId, previous] of existingEdges) {
			if (previous.current === 0 || currentProfileIds.has(profileId)) {
				continue;
			}
			endFollowEdge.run(now, now, "acct_primary", direction, profileId);
			insertFollowEvent.run(
				`follow_event_${randomUUID()}`,
				"acct_primary",
				direction,
				profileId,
				previous.external_user_id,
				"ended",
				now,
				snapshotId,
			);
		}
	}

	function clearArchiveFollowRows(direction: ArchiveFollowDirection) {
		deleteArchiveFollowEvents.run(
			"acct_primary",
			direction,
			`follow_snapshot_archive_acct_primary_${direction}`,
			"acct_primary",
			direction,
		);
		deleteArchiveFollowSnapshotMembers.run("acct_primary", direction);
		deleteArchiveFollowSnapshots.run("acct_primary", direction);
		deleteArchiveFollowEdges.run("acct_primary", direction);
	}

	db.transaction(() => {
		insertAccount.run(
			"acct_primary",
			accountPayload.displayName,
			`@${accountPayload.username}`,
			accountPayload.accountId,
			"archive",
			accountPayload.createdAt,
		);

		for (const profile of profiles.values()) {
			insertProfile.run(
				profile.id,
				profile.handle,
				profile.displayName,
				profile.bio,
				profile.followersCount,
				profile.followingCount,
				profile.publicMetricsJson,
				profile.avatarHue,
				profile.avatarUrl,
				profile.location,
				profile.url,
				profile.verifiedType,
				profile.entitiesJson,
				profile.rawJson,
				profile.createdAt,
			);
		}

		for (const tweet of tweetRows) {
			insertTweet.run(
				tweet.id,
				"acct_primary",
				tweet.authorProfileId,
				tweet.kind,
				tweet.text,
				tweet.createdAt,
				tweet.isReplied,
				tweet.replyToId,
				tweet.likeCount,
				tweet.mediaCount,
				tweet.bookmarked,
				tweet.liked,
				tweet.entitiesJson,
				tweet.mediaJson,
				tweet.quotedTweetId,
			);
			if (tweet.kind === "home") {
				insertTimelineEdge.run(
					"acct_primary",
					tweet.id,
					tweet.kind,
					tweet.createdAt,
					tweet.createdAt,
					new Date().toISOString(),
				);
			}
			insertTweetFts.run(tweet.id, tweet.text);
		}

		const importedAt = new Date().toISOString();
		for (const collection of collectionRows) {
			insertCollection.run(
				"acct_primary",
				collection.tweetId,
				collection.kind,
				collection.collectedAt,
				collection.source,
				collection.rawJson,
				importedAt,
			);
		}

		for (const conversation of conversations.values()) {
			insertConversation.run(
				conversation.id,
				conversation.accountId,
				conversation.participantProfileId,
				conversation.title,
				conversation.lastMessageAt,
				conversation.unreadCount,
				conversation.needsReply,
			);
		}

		for (const message of dmMessages) {
			insertMessage.run(
				message.id,
				message.conversationId,
				message.senderProfileId,
				message.text,
				message.createdAt,
				message.direction,
				message.direction === "outbound" ? 1 : 0,
				message.mediaCount,
			);
			insertDmFts.run(message.id, message.text);
		}

		if (followerEntries.length > 0) {
			importFollowRows(
				"followers",
				followerRows,
				followerEntries.length,
				importedAt,
			);
		} else {
			clearArchiveFollowRows("followers");
		}
		if (followingEntries.length > 0) {
			importFollowRows(
				"following",
				followingRows,
				followingEntries.length,
				importedAt,
			);
		} else {
			clearArchiveFollowRows("following");
		}
	})();

	return {
		ok: true,
		archivePath,
		account: {
			id: accountPayload.accountId,
			handle: accountPayload.username,
			displayName: accountPayload.displayName,
		},
		counts: {
			tweets: authoredTweetCount,
			likes: likeCount,
			bookmarks: bookmarkCount,
			dmConversations: conversations.size,
			dmMessages: dmMessages.length,
			profiles: profiles.size,
			followers: followerRows.length,
			following: followingRows.length,
		},
	};
}

export const __test__ = {
	normalizeArchivePath,
	extractArchiveJson,
	parseArchiveArray,
	getFirstEntry,
	getMatchingEntries,
	parseTwitterDate,
	asRecord,
	asArray,
	toInt,
	compareIsoTimestamp,
	getTweetMediaCount,
	extractTweetEntities,
	extractTweetMedia,
	extractCollectionTweet,
	buildAccountPayload,
	inferProfileFromDirectory,
};
