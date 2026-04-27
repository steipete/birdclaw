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
	};
}

type ArchiveRecord = Record<string, unknown>;

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

function clearImportedData() {
	const db = getNativeDb();
	db.exec(`
    delete from ai_scores;
    delete from tweet_actions;
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
			avatarHue: number;
			createdAt: string;
		}
	>();
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

	const localProfile = {
		id: "profile_me",
		handle: accountPayload.username,
		displayName: accountPayload.displayName,
		bio: accountPayload.bio,
		followersCount: 0,
		avatarHue: 18,
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
						avatarHue: 220,
						createdAt: accountPayload.createdAt,
					});
				} else {
					const otherUserId = externalParticipantIds[0] ?? conversationId;
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
						avatarHue: 210,
						createdAt: accountPayload.createdAt,
					});
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
								avatarHue: 240,
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
				.sort(
					(left, right) =>
						new Date(left.createdAt).getTime() -
						new Date(right.createdAt).getTime(),
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

	const likeCount = likeEntries.reduce(async (countPromise, entry) => {
		const count = await countPromise;
		const content = await readArchiveEntry(archivePath, entry);
		const likes = parseArchiveArray(content);
		for (const like of likes) {
			const tweet = extractCollectionTweet(like, "like");
			if (!tweet) continue;
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
		return count + likes.length;
	}, Promise.resolve(0));

	const bookmarkCount = bookmarkEntries.reduce(async (countPromise, entry) => {
		const count = await countPromise;
		const content = await readArchiveEntry(archivePath, entry);
		const bookmarks = parseArchiveArray(content);
		for (const bookmark of bookmarks) {
			const tweet = extractCollectionTweet(bookmark, "bookmark");
			if (!tweet) continue;
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
		return count + bookmarks.length;
	}, Promise.resolve(0));

	await Promise.all([likeCount, bookmarkCount]);

	if (tweetRows.some((tweet) => tweet.authorProfileId === "profile_unknown")) {
		profiles.set("profile_unknown", {
			id: "profile_unknown",
			handle: "unknown",
			displayName: "Unknown",
			bio: "Imported from archive collection metadata",
			followersCount: 0,
			avatarHue: 210,
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
    insert into profiles (id, handle, display_name, bio, followers_count, avatar_hue, avatar_url, created_at)
    values (?, ?, ?, ?, ?, ?, ?, ?)
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
				profile.avatarHue,
				null,
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
			insertTweetFts.run(tweet.id, tweet.text);
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
			likes: await likeCount,
			bookmarks: await bookmarkCount,
			dmConversations: conversations.size,
			dmMessages: dmMessages.length,
			profiles: profiles.size,
		},
	};
}

export const __test__ = {
	extractArchiveJson,
	parseArchiveArray,
	parseTwitterDate,
	asRecord,
	asArray,
	toInt,
	getTweetMediaCount,
	extractTweetEntities,
	extractTweetMedia,
	buildAccountPayload,
	inferProfileFromDirectory,
};
