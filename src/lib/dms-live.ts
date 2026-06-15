import { Effect } from "effect";
import type { Database } from "./sqlite";
import {
	type BirdDmConversation,
	type BirdDmEvent,
	type BirdDmUser,
	getAuthenticatedBirdAccountEffect,
	listDirectMessagesViaBirdEffect,
} from "./bird";
import { getNativeDb } from "./db";
import { runEffectPromise } from "./effect-runtime";
import {
	assertLiveAccountMatches,
	resolveLiveSyncAccount,
	type LiveSyncAccount,
} from "./live-sync-engine";
import { collectPaginatedEffect } from "./paginated-sync";
import { readSyncCache, writeSyncCache } from "./sync-cache";
import type { XurlDmEventsResponse, XurlMentionUser } from "./types";
import {
	listDirectMessageEventsViaXurlEffect,
	lookupAuthenticatedOAuth2UserEffect,
} from "./xurl";
import {
	buildExternalProfileId,
	randomAvatarHue,
	upsertProfileFromXUser,
} from "./x-profile";

export const DEFAULT_DMS_CACHE_TTL_MS = 2 * 60_000;
const PREVIEW_MESSAGE_ID_PREFIX = "preview:";
const XURL_DMS_MAX_RESULTS = 100;

export type DirectMessagesSyncMode = "auto" | "bird" | "xurl";

export interface SyncDirectMessagesViaCachedBirdOptions {
	account?: string;
	mode?: DirectMessagesSyncMode;
	limit?: number;
	inbox?: "all" | "accepted" | "requests";
	maxPages?: number;
	allPages?: boolean;
	pageDelayMs?: number;
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

function assertXurlLimit(limit: number) {
	if (!Number.isFinite(limit) || limit < 1 || limit > XURL_DMS_MAX_RESULTS) {
		throw new Error("xurl DM mode requires --limit between 1 and 100");
	}
}

function parseSyncMode(mode: DirectMessagesSyncMode | undefined) {
	if (!mode || mode === "bird" || mode === "xurl" || mode === "auto") {
		return mode ?? "bird";
	}
	throw new Error("--mode must be auto, bird, or xurl");
}

function makePreviewMessageId(conversationId: string): string {
	return `${PREVIEW_MESSAGE_ID_PREFIX}${conversationId}`;
}

function deleteDmFtsRows(db: Database, messageIds: string[]) {
	const chunkSize = 500;
	for (let index = 0; index < messageIds.length; index += chunkSize) {
		const chunk = messageIds.slice(index, index + chunkSize);
		if (chunk.length === 0) continue;
		db.prepare(
			`delete from dm_fts where message_id in (${chunk.map(() => "?").join(",")})`,
		).run(...chunk);
	}
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

function collectUsers(
	payload: {
		conversations: BirdDmConversation[];
		events: BirdDmEvent[];
	},
	accountExternalUserId?: string,
) {
	const users = new Map<string, BirdDmUser>();
	const add = (user?: BirdDmUser) => {
		if (!user?.id) return;
		if (
			accountExternalUserId &&
			user.id === accountExternalUserId &&
			!user.username &&
			!user.name
		) {
			return;
		}
		users.set(user.id, { ...users.get(user.id), ...user });
	};
	const addId = (id?: string) => {
		if (!id || users.has(id) || id === accountExternalUserId) return;
		users.set(id, { id });
	};

	for (const conversation of payload.conversations) {
		for (const participant of conversation.participants) {
			add(participant);
		}
	}
	for (const event of payload.events) {
		add(event.sender);
		add(event.recipient);
		addId(event.senderId);
		addId(event.recipientId);
	}
	return users;
}

function getLocalExternalUserId(
	users: Map<string, BirdDmUser>,
	accountUsername: string,
	accountExternalUserId?: string,
) {
	if (accountExternalUserId) {
		return accountExternalUserId;
	}
	const normalizedAccountUsername = accountUsername.toLowerCase();
	for (const user of users.values()) {
		if (user.username?.toLowerCase() === normalizedAccountUsername) {
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

function assertAuthenticatedBirdAccountMatches({
	source,
	account,
	liveUsername,
	liveExternalUserId,
}: {
	source: "bird" | "xurl";
	account: LiveSyncAccount;
	liveUsername: string;
	liveExternalUserId?: string;
}) {
	assertLiveAccountMatches({
		source,
		account,
		liveUsername,
		liveExternalUserId,
	});
}

function getAuthenticatedXurlAccount(payload: Record<string, unknown> | null): {
	id?: string;
	username?: string;
} {
	if (!payload) return {};
	return {
		...(typeof payload.id === "string" ? { id: payload.id } : {}),
		...(typeof payload.username === "string"
			? { username: payload.username }
			: {}),
	};
}

function persistAccountExternalUserId(
	db: Database,
	accountId: string,
	externalUserId: string,
) {
	db.prepare(
		`
    update accounts
    set external_user_id = ?
    where id = ?
      and (external_user_id is null or trim(external_user_id) = '')
    `,
	).run(externalUserId, accountId);
}

function conversationIdReferencesExternalUserId(
	conversationId: string,
	externalUserId: string,
) {
	return conversationId.split(/[^0-9]+/).includes(externalUserId);
}

function payloadReferencesExternalUserId(
	payload: {
		conversations: BirdDmConversation[];
		events: BirdDmEvent[];
	},
	externalUserId: string,
) {
	for (const conversation of payload.conversations) {
		if (
			conversationIdReferencesExternalUserId(conversation.id, externalUserId)
		) {
			return true;
		}
		if (conversation.participants.some((user) => user.id === externalUserId)) {
			return true;
		}
	}
	for (const event of payload.events) {
		if (
			event.senderId === externalUserId ||
			event.recipientId === externalUserId
		) {
			return true;
		}
		if (
			event.sender?.id === externalUserId ||
			event.recipient?.id === externalUserId
		) {
			return true;
		}
		if (
			event.conversationId &&
			conversationIdReferencesExternalUserId(
				event.conversationId,
				externalUserId,
			)
		) {
			return true;
		}
	}
	return false;
}

function ensureSparseLocalProfile(
	db: Database,
	externalUserId: string,
	accountUsername: string,
) {
	const profileId = buildExternalProfileId(externalUserId);
	const existing = db
		.prepare("select id from profiles where id = ? or handle = ? limit 1")
		.get(profileId, accountUsername) as { id: string } | undefined;
	if (existing) {
		return existing.id;
	}

	const createdAt = new Date().toISOString();
	db.prepare(
		`
    insert into profiles (
      id, handle, display_name, bio, followers_count, following_count,
      public_metrics_json, avatar_hue, entities_json, raw_json, created_at
    ) values (?, ?, ?, '', 0, 0, '{}', ?, '{}', '{}', ?)
    `,
	).run(
		profileId,
		accountUsername,
		accountUsername,
		randomAvatarHue(accountUsername),
		createdAt,
	);
	return profileId;
}

function mergeDirectMessagesIntoLocalStore(
	db: Database,
	accountId: string,
	accountUsername: string,
	accountExternalUserId: string | undefined,
	payload: {
		conversations: BirdDmConversation[];
		events: BirdDmEvent[];
	},
) {
	const users = collectUsers(payload, accountExternalUserId);
	const localExternalUserId = getLocalExternalUserId(
		users,
		accountUsername,
		accountExternalUserId,
	);
	if (
		accountExternalUserId &&
		(payload.conversations.length > 0 || payload.events.length > 0) &&
		!payloadReferencesExternalUserId(payload, accountExternalUserId)
	) {
		throw new Error(
			`bird DM payload does not include @${accountUsername}; refusing to sync into ${accountId}`,
		);
	}
	if (
		!localExternalUserId &&
		(payload.conversations.length > 0 || payload.events.length > 0)
	) {
		throw new Error(
			`bird DM payload does not include @${accountUsername}; refusing to sync into ${accountId}`,
		);
	}
	if (!localExternalUserId) {
		return;
	}
	const profilesByExternalId = new Map<string, string>();
	for (const user of users.values()) {
		const resolved = upsertProfileFromXUser(db, toXUser(user));
		profilesByExternalId.set(user.id, resolved.profile.id);
	}
	if (
		accountExternalUserId &&
		!profilesByExternalId.has(accountExternalUserId)
	) {
		profilesByExternalId.set(
			accountExternalUserId,
			ensureSparseLocalProfile(db, accountExternalUserId, accountUsername),
		);
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
	const insertFts = db.prepare(
		"insert into dm_fts (message_id, text) values (?, ?)",
	);
	const deleteMessage = db.prepare("delete from dm_messages where id = ?");
	const ftsMessageIdsToReplace = new Set<string>();
	for (const conversation of payload.conversations) {
		const events = eventsByConversation.get(conversation.id) ?? [];
		if (events.length === 0 && !conversation.lastMessagePreview) {
			continue;
		}
		const participant =
			conversation.participants.find(
				(user) =>
					user.id !== localExternalUserId &&
					user.username?.toLowerCase() !== accountUsername.toLowerCase(),
			) ?? conversation.participants[0];
		if (!participant || !profilesByExternalId.has(participant.id)) {
			continue;
		}
		if (events.length === 0) {
			ftsMessageIdsToReplace.add(makePreviewMessageId(conversation.id));
			continue;
		}
		ftsMessageIdsToReplace.add(makePreviewMessageId(conversation.id));
		for (const event of events) {
			const senderId = event.senderId ?? event.sender?.id;
			if (senderId && profilesByExternalId.has(senderId)) {
				ftsMessageIdsToReplace.add(event.id);
			}
		}
	}

	db.transaction(() => {
		deleteDmFtsRows(db, [...ftsMessageIdsToReplace]);
		const ftsTextByMessageId = new Map<string, string>();

		for (const conversation of payload.conversations) {
			const events = eventsByConversation.get(conversation.id) ?? [];
			if (events.length === 0 && !conversation.lastMessagePreview) {
				continue;
			}

			const participant =
				conversation.participants.find(
					(user) =>
						user.id !== localExternalUserId &&
						user.username?.toLowerCase() !== accountUsername.toLowerCase(),
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
			const inboxKind =
				conversation.inboxKind ??
				(conversation.isMessageRequest ? "request" : "accepted");
			const latestInbound = latest
				? latest.senderId !== localExternalUserId &&
					latest.sender?.username?.toLowerCase() !==
						accountUsername.toLowerCase()
				: inboxKind === "request";
			upsertConversation.run(
				conversation.id,
				accountId,
				participantProfileId,
				participant.username ?? participant.name ?? participant.id,
				inboxKind,
				lastMessageAt,
				latestInbound ? 1 : 0,
			);

			const previewMessageId = makePreviewMessageId(conversation.id);
			if (events.length === 0 && conversation.lastMessagePreview) {
				const previewSenderProfileId = latestInbound
					? participantProfileId
					: (profilesByExternalId.get(localExternalUserId) ??
						participantProfileId);
				upsertMessage.run(
					previewMessageId,
					conversation.id,
					previewSenderProfileId,
					conversation.lastMessagePreview,
					lastMessageAt,
					latestInbound ? "inbound" : "outbound",
				);
				ftsTextByMessageId.set(
					previewMessageId,
					conversation.lastMessagePreview,
				);
				continue;
			}

			deleteMessage.run(previewMessageId);

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
					event.sender?.username?.toLowerCase() ===
						accountUsername.toLowerCase()
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
				ftsTextByMessageId.set(event.id, event.text);
			}
		}

		for (const [messageId, text] of ftsTextByMessageId) {
			insertFts.run(messageId, text);
		}
	})();
}

function getMetaNextToken(meta?: Record<string, unknown>) {
	const token = meta?.next_token;
	return typeof token === "string" && token.length > 0 ? token : undefined;
}

function xurlUserToBirdDmUser(user: XurlMentionUser): BirdDmUser {
	return {
		id: String(user.id),
		username: user.username,
		name: user.name,
		profileImageUrl: user.profile_image_url,
	};
}

function uniqueDefined(values: Array<string | undefined>) {
	return [
		...new Set(values.filter((value): value is string => Boolean(value))),
	];
}

function conversationIdForXurlEvent(
	event: XurlDmEventsResponse["data"][number],
	localExternalUserId: string,
) {
	if (event.dm_conversation_id) {
		return event.dm_conversation_id;
	}
	const ids = uniqueDefined([
		localExternalUserId,
		event.sender_id,
		...(event.participant_ids ?? []),
	]).sort();
	return ids.length > 1 ? ids.join("-") : `dm-${event.id}`;
}

function adaptXurlDmEventsToBirdPayload({
	payload,
	localExternalUserId,
	accountUsername,
}: {
	payload: XurlDmEventsResponse;
	localExternalUserId: string;
	accountUsername: string;
}): { conversations: BirdDmConversation[]; events: BirdDmEvent[] } {
	const users = new Map<string, BirdDmUser>();
	const addUser = (user?: BirdDmUser) => {
		if (!user?.id) return;
		users.set(user.id, { ...users.get(user.id), ...user });
	};
	for (const user of payload.includes?.users ?? []) {
		addUser(xurlUserToBirdDmUser(user));
	}
	addUser({
		id: localExternalUserId,
		username: accountUsername,
		name: accountUsername,
	});

	const eventsByConversation = new Map<string, BirdDmEvent[]>();
	const events: BirdDmEvent[] = [];
	for (const event of payload.data) {
		if (event.event_type && event.event_type !== "MessageCreate") continue;
		if (!event.id || !event.sender_id || event.text === undefined) continue;
		const conversationId = conversationIdForXurlEvent(
			event,
			localExternalUserId,
		);
		const participantIds = uniqueDefined([
			localExternalUserId,
			event.sender_id,
			...(event.participant_ids ?? []),
		]);
		for (const id of participantIds) {
			addUser({ id });
		}
		const recipientId =
			event.sender_id === localExternalUserId
				? participantIds.find((id) => id !== localExternalUserId)
				: localExternalUserId;
		const dmEvent: BirdDmEvent = {
			id: event.id,
			conversationId,
			text: event.text,
			createdAt: event.created_at,
			senderId: event.sender_id,
			...(recipientId ? { recipientId } : {}),
			sender: users.get(event.sender_id) ?? { id: event.sender_id },
			...(recipientId
				? { recipient: users.get(recipientId) ?? { id: recipientId } }
				: {}),
			inboxKind: "accepted",
			isMessageRequest: false,
		};
		events.push(dmEvent);
		const conversationEvents = eventsByConversation.get(conversationId) ?? [];
		conversationEvents.push(dmEvent);
		eventsByConversation.set(conversationId, conversationEvents);
	}

	const conversations = [...eventsByConversation].map(
		([conversationId, conversationEvents]) => {
			const latest = getLatestEvent(conversationEvents);
			const participantIds = uniqueDefined([
				localExternalUserId,
				...conversationEvents.flatMap((event) => [
					event.senderId,
					event.recipientId,
				]),
			]);
			const participants = participantIds.map((id) => users.get(id) ?? { id });
			return {
				id: conversationId,
				participants,
				messages: conversationEvents,
				lastMessageAt: latest?.createdAt,
				lastMessagePreview: latest?.text,
				inboxKind: "accepted" as const,
				isMessageRequest: false,
			};
		},
	);

	return { conversations, events };
}

function mergeXurlDmPages(pages: XurlDmEventsResponse[]): XurlDmEventsResponse {
	const usersById = new Map<string, XurlMentionUser>();
	const eventsById = new Map<string, XurlDmEventsResponse["data"][number]>();
	let meta: Record<string, unknown> | undefined;
	for (const page of pages) {
		for (const user of page.includes?.users ?? []) {
			usersById.set(user.id, { ...usersById.get(user.id), ...user });
		}
		for (const event of page.data) {
			eventsById.set(event.id, event);
		}
		meta = page.meta ?? meta;
	}
	return {
		data: [...eventsById.values()],
		...(usersById.size > 0
			? { includes: { users: [...usersById.values()] } }
			: {}),
		...(meta ? { meta } : {}),
	};
}

function fetchDirectMessagesViaXurlEffect({
	limit,
	username,
	maxPages,
	allPages,
	pageDelayMs,
}: {
	limit: number;
	username: string;
	maxPages?: number;
	allPages: boolean;
	pageDelayMs?: number;
}) {
	return Effect.gen(function* () {
		const pageLimit = allPages
			? Number.POSITIVE_INFINITY
			: Math.max(1, (maxPages ?? 0) + 1);
		const result = yield* collectPaginatedEffect({
			fetchPage: ({ cursor }) =>
				listDirectMessageEventsViaXurlEffect({
					maxResults: limit,
					username,
					...(cursor ? { paginationToken: cursor } : {}),
				}),
			getNextCursor: (page) => getMetaNextToken(page.meta),
			maxPages: pageLimit,
			pageDelayMs,
		});
		return mergeXurlDmPages(result.pages);
	});
}

export function syncDirectMessagesViaCachedBirdEffect({
	account,
	mode,
	limit = 20,
	inbox = "all",
	maxPages,
	allPages = false,
	pageDelayMs,
	refresh = false,
	cacheTtlMs,
}: SyncDirectMessagesViaCachedBirdOptions = {}): Effect.Effect<
	{
		ok: true;
		source: "bird" | "cache" | "xurl";
		accountId: string;
		conversations: number;
		messages: number;
	},
	unknown
> {
	return Effect.gen(function* () {
		const parsedMode = parseSyncMode(mode);
		if (parsedMode === "xurl") {
			assertXurlLimit(limit);
		} else {
			assertBirdLimit(limit);
		}
		if (inbox === "requests" && parsedMode === "xurl") {
			throw new Error(
				"xurl DM mode cannot read the message-request inbox or accept/reject state; use --mode bird",
			);
		}
		const db = getNativeDb();
		const resolvedAccount = resolveLiveSyncAccount(db, account);
		const pageKey = allPages
			? "all-pages"
			: `max-pages:${String(maxPages ?? 0)}`;
		const cacheMode = parsedMode === "auto" ? "auto" : parsedMode;
		const cacheKey = `dms:${cacheMode}:${resolvedAccount.accountId}:${String(limit)}:${inbox}:${pageKey}`;
		const ttlMs = parseCacheTtlMs(cacheTtlMs);
		const cached = readSyncCache<{
			conversations: BirdDmConversation[];
			events: BirdDmEvent[];
		}>(cacheKey, db);
		const cacheAgeMs = cached
			? Date.now() - new Date(cached.updatedAt).getTime()
			: Number.POSITIVE_INFINITY;

		const cacheHit = !refresh && cached && cacheAgeMs <= ttlMs;
		let accountExternalUserId = resolvedAccount.externalUserId;
		let payload:
			| {
					conversations: BirdDmConversation[];
					events: BirdDmEvent[];
			  }
			| undefined;
		let source: "bird" | "xurl" | undefined;
		if (cacheHit) {
			payload = cached.value;
		} else {
			const tryXurl =
				(parsedMode === "xurl" || parsedMode === "auto") &&
				inbox !== "requests";
			if (tryXurl) {
				const xurlPayload = yield* Effect.gen(function* () {
					const authenticated = getAuthenticatedXurlAccount(
						yield* lookupAuthenticatedOAuth2UserEffect(
							resolvedAccount.username,
						),
					);
					if (!authenticated.username && !authenticated.id) {
						return yield* Effect.fail(
							new Error("xurl authenticated user unavailable"),
						);
					}
					assertAuthenticatedBirdAccountMatches({
						source: "xurl",
						account: resolvedAccount,
						liveUsername: authenticated.username ?? resolvedAccount.username,
						liveExternalUserId: authenticated.id,
					});
					accountExternalUserId ??= authenticated.id;
					if (!resolvedAccount.externalUserId && accountExternalUserId) {
						persistAccountExternalUserId(
							db,
							resolvedAccount.accountId,
							accountExternalUserId,
						);
					}
					if (!accountExternalUserId) {
						return yield* Effect.fail(
							new Error(
								"xurl authenticated user id unavailable; refusing to sync DMs",
							),
						);
					}
					return yield* fetchDirectMessagesViaXurlEffect({
						limit,
						username: resolvedAccount.username,
						...(typeof maxPages === "number" ? { maxPages } : {}),
						allPages,
						...(typeof pageDelayMs === "number" ? { pageDelayMs } : {}),
					});
				}).pipe(
					Effect.catchAll((error) => {
						if (parsedMode === "xurl") return Effect.fail(error);
						return Effect.succeed(undefined);
					}),
				);
				if (xurlPayload) {
					const localExternalUserId = accountExternalUserId;
					if (!localExternalUserId) {
						throw new Error(
							"xurl authenticated user id unavailable; refusing to sync DMs",
						);
					}
					payload = adaptXurlDmEventsToBirdPayload({
						payload: xurlPayload,
						localExternalUserId,
						accountUsername: resolvedAccount.username,
					});
					source = "xurl";
				}
			}
			if (!payload) {
				const authenticated = yield* getAuthenticatedBirdAccountEffect();
				assertAuthenticatedBirdAccountMatches({
					source: "bird",
					account: resolvedAccount,
					liveUsername: authenticated.username,
					liveExternalUserId: authenticated.id,
				});
				accountExternalUserId ??= authenticated.id;
				if (!resolvedAccount.externalUserId && accountExternalUserId) {
					persistAccountExternalUserId(
						db,
						resolvedAccount.accountId,
						accountExternalUserId,
					);
				}
				payload = yield* listDirectMessagesViaBirdEffect({
					maxResults: limit,
					...(inbox !== "all" ? { inbox } : {}),
					...(typeof maxPages === "number" ? { maxPages } : {}),
					...(allPages ? { allPages } : {}),
					...(typeof pageDelayMs === "number" ? { pageDelayMs } : {}),
				});
				source = "bird";
			}
		}
		if (!payload) {
			throw new Error("DM sync produced no payload");
		}

		mergeDirectMessagesIntoLocalStore(
			db,
			resolvedAccount.accountId,
			resolvedAccount.username,
			accountExternalUserId,
			payload,
		);
		if (!cached || refresh || cacheAgeMs > ttlMs) {
			writeSyncCache(cacheKey, payload, db);
		}

		return {
			ok: true,
			source: cacheHit ? "cache" : source!,
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
