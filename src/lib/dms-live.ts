import { Effect } from "effect";
import type { Database } from "./sqlite";
import {
	type BirdDmConversation,
	type BirdDmEvent,
	type BirdDmUser,
	listDirectMessagesViaBirdEffect,
} from "./bird";
import { getNativeDb } from "./db";
import { runEffectPromise } from "./effect-runtime";
import { readSyncCache, writeSyncCache } from "./sync-cache";
import type { XurlMentionUser } from "./types";
import { upsertProfileFromXUser } from "./x-profile";

export const DEFAULT_DMS_CACHE_TTL_MS = 2 * 60_000;

export interface SyncDirectMessagesViaCachedBirdOptions {
	account?: string;
	limit?: number;
	inbox?: "all" | "accepted" | "requests";
	maxPages?: number;
	allPages?: boolean;
	refresh?: boolean;
	cacheTtlMs?: number;
}

function parseCacheTtlMs(value?: number) {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return DEFAULT_DMS_CACHE_TTL_MS;
	}
	return Math.floor(value);
}

function assertBirdLimit(limit: number) {
	if (!Number.isFinite(limit) || limit < 1) {
		throw new Error("bird DM mode requires --limit of at least 1");
	}
}

function resolveAccount(db: Database, accountId?: string) {
	const row = accountId
		? (db
				.prepare("select id, handle from accounts where id = ?")
				.get(accountId) as { id: string; handle: string } | undefined)
		: (db
				.prepare(
					`
          select id, handle
          from accounts
          order by is_default desc, created_at asc
          limit 1
          `,
				)
				.get() as { id: string; handle: string } | undefined);

	if (!row) {
		throw new Error(`Unknown account: ${accountId ?? "default"}`);
	}

	return {
		accountId: row.id,
		username: row.handle.replace(/^@/, ""),
	};
}

function toIsoTimestamp(value?: string) {
	if (!value) {
		return new Date().toISOString();
	}
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

function toXUser(user: BirdDmUser): XurlMentionUser {
	return {
		id: user.id,
		username: user.username ?? `user_${user.id}`,
		name: user.name ?? user.username ?? `user_${user.id}`,
		profile_image_url: user.profileImageUrl,
		public_metrics: { followers_count: 0 },
	};
}

function collectUsers(payload: {
	conversations: BirdDmConversation[];
	events: BirdDmEvent[];
}) {
	const users = new Map<string, BirdDmUser>();
	const add = (user?: BirdDmUser) => {
		if (!user?.id) return;
		users.set(user.id, { ...users.get(user.id), ...user });
	};

	for (const conversation of payload.conversations) {
		for (const participant of conversation.participants) {
			add(participant);
		}
	}
	for (const event of payload.events) {
		add(event.sender);
		add(event.recipient);
	}
	return users;
}

function getLocalExternalUserId(
	users: Map<string, BirdDmUser>,
	accountUsername: string,
) {
	for (const user of users.values()) {
		if (user.username === accountUsername) {
			return user.id;
		}
	}
	return undefined;
}

function getLatestEvent(events: BirdDmEvent[]) {
	return [...events].sort(
		(left, right) =>
			new Date(right.createdAt ?? 0).getTime() -
			new Date(left.createdAt ?? 0).getTime(),
	)[0];
}

function mergeDirectMessagesIntoLocalStore(
	db: Database,
	accountId: string,
	accountUsername: string,
	payload: {
		conversations: BirdDmConversation[];
		events: BirdDmEvent[];
	},
) {
	const users = collectUsers(payload);
	const localExternalUserId = getLocalExternalUserId(users, accountUsername);
	const profilesByExternalId = new Map<string, string>();
	for (const user of users.values()) {
		const resolved = upsertProfileFromXUser(db, toXUser(user));
		profilesByExternalId.set(user.id, resolved.profile.id);
	}

	const eventsByConversation = new Map<string, BirdDmEvent[]>();
	for (const event of payload.events) {
		if (!event.conversationId) continue;
		const events = eventsByConversation.get(event.conversationId) ?? [];
		events.push(event);
		eventsByConversation.set(event.conversationId, events);
	}

	const upsertConversation = db.prepare(`
    insert into dm_conversations (
      id, account_id, participant_profile_id, title, inbox_kind, last_message_at, unread_count, needs_reply
    ) values (?, ?, ?, ?, ?, ?, 0, ?)
    on conflict(id) do update set
      account_id = excluded.account_id,
      participant_profile_id = excluded.participant_profile_id,
      title = excluded.title,
      inbox_kind = excluded.inbox_kind,
      last_message_at = excluded.last_message_at,
      needs_reply = excluded.needs_reply
  `);
	const upsertMessage = db.prepare(`
    insert into dm_messages (
      id, conversation_id, sender_profile_id, text, created_at, direction, is_replied, media_count
    ) values (?, ?, ?, ?, ?, ?, 0, 0)
    on conflict(id) do update set
      conversation_id = excluded.conversation_id,
      sender_profile_id = excluded.sender_profile_id,
      text = excluded.text,
      created_at = excluded.created_at,
      direction = excluded.direction,
      media_count = excluded.media_count
  `);
	const replaceFts = db.prepare("delete from dm_fts where message_id = ?");
	const insertFts = db.prepare(
		"insert into dm_fts (message_id, text) values (?, ?)",
	);

	db.transaction(() => {
		for (const conversation of payload.conversations) {
			const events = eventsByConversation.get(conversation.id) ?? [];
			if (events.length === 0) {
				continue;
			}

			const participant =
				conversation.participants.find(
					(user) =>
						user.id !== localExternalUserId &&
						user.username !== accountUsername,
				) ?? conversation.participants[0];
			if (!participant) {
				continue;
			}
			const participantProfileId = profilesByExternalId.get(participant.id);
			if (!participantProfileId) {
				continue;
			}

			const latest = getLatestEvent(events);
			const lastMessageAt = toIsoTimestamp(
				latest?.createdAt ?? conversation.lastMessageAt,
			);
			const latestInbound =
				latest?.senderId !== localExternalUserId &&
				latest?.sender?.username !== accountUsername;
			const inboxKind =
				conversation.inboxKind ??
				(conversation.isMessageRequest ? "request" : "accepted");
			upsertConversation.run(
				conversation.id,
				accountId,
				participantProfileId,
				participant.username ?? participant.name ?? participant.id,
				inboxKind,
				lastMessageAt,
				latestInbound ? 1 : 0,
			);

			for (const event of events) {
				const senderId = event.senderId ?? event.sender?.id;
				if (!senderId) {
					continue;
				}
				const senderProfileId = profilesByExternalId.get(senderId);
				if (!senderProfileId) {
					continue;
				}
				const direction =
					senderId === localExternalUserId ||
					event.sender?.username === accountUsername
						? "outbound"
						: "inbound";
				upsertMessage.run(
					event.id,
					conversation.id,
					senderProfileId,
					event.text,
					toIsoTimestamp(event.createdAt),
					direction,
				);
				replaceFts.run(event.id);
				insertFts.run(event.id, event.text);
			}
		}
	})();
}

export function syncDirectMessagesViaCachedBirdEffect({
	account,
	limit = 20,
	inbox = "all",
	maxPages,
	allPages = false,
	refresh = false,
	cacheTtlMs,
}: SyncDirectMessagesViaCachedBirdOptions = {}): Effect.Effect<
	{
		ok: true;
		source: "bird" | "cache";
		accountId: string;
		conversations: number;
		messages: number;
	},
	unknown
> {
	return Effect.gen(function* () {
		assertBirdLimit(limit);
		const db = getNativeDb();
		const resolvedAccount = resolveAccount(db, account);
		const pageKey = allPages
			? "all-pages"
			: `max-pages:${String(maxPages ?? 0)}`;
		const cacheKey = `dms:bird:${resolvedAccount.accountId}:${String(limit)}:${inbox}:${pageKey}`;
		const ttlMs = parseCacheTtlMs(cacheTtlMs);
		const cached = readSyncCache<{
			conversations: BirdDmConversation[];
			events: BirdDmEvent[];
		}>(cacheKey, db);
		const cacheAgeMs = cached
			? Date.now() - new Date(cached.updatedAt).getTime()
			: Number.POSITIVE_INFINITY;

		const payload =
			!refresh && cached && cacheAgeMs <= ttlMs
				? cached.value
				: yield* listDirectMessagesViaBirdEffect({
						maxResults: limit,
						...(inbox !== "all" ? { inbox } : {}),
						...(typeof maxPages === "number" ? { maxPages } : {}),
						...(allPages ? { allPages } : {}),
					});

		mergeDirectMessagesIntoLocalStore(
			db,
			resolvedAccount.accountId,
			resolvedAccount.username,
			payload,
		);
		if (!cached || refresh || cacheAgeMs > ttlMs) {
			writeSyncCache(cacheKey, payload, db);
		}

		return {
			ok: true,
			source: cached && !refresh && cacheAgeMs <= ttlMs ? "cache" : "bird",
			accountId: resolvedAccount.accountId,
			conversations: payload.conversations.length,
			messages: payload.events.length,
		} as const;
	});
}

export function syncDirectMessagesViaCachedBird(
	options: SyncDirectMessagesViaCachedBirdOptions = {},
) {
	return runEffectPromise(syncDirectMessagesViaCachedBirdEffect(options));
}
