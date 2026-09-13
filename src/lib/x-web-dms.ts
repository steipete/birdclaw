import type {
	BirdDmConversation,
	BirdDmEvent,
	BirdDmUser,
	BirdDmsResponse,
	BirdDmMutationResponse,
} from "./bird";
import type { LiveAccountIdentity } from "./live-sync-engine";
import { XWebSession, webObject } from "./x-web";

type Inbox = "all" | "accepted" | "requests";
type Timeline = "trusted" | "untrusted";

const text = (value: unknown): string | undefined =>
	typeof value === "string" && value.length > 0 ? value : undefined;
const values = (value: unknown): unknown[] =>
	Array.isArray(value) ? value : Object.values(webObject(value));

function timestamp(value: unknown) {
	const raw =
		typeof value === "number" ||
		(typeof value === "string" && /^\d+$/.test(value))
			? Number(value)
			: text(value);
	if (raw === undefined) return undefined;
	const date = new Date(raw);
	return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

export function parseWebDirectMessages(
	pages: Record<string, unknown>[],
	inbox: Inbox,
	limit: number,
): BirdDmsResponse {
	const users = new Map<string, BirdDmUser>();
	const rawConversations = new Map<string, Record<string, unknown>>();
	const rawMessages = new Map<string, Record<string, unknown>>();
	function visit(value: unknown, depth = 0) {
		if (depth > 40)
			throw new Error("X web DM response exceeded its nesting limit");
		if (!value || typeof value !== "object") return;
		const item = webObject(value);
		for (const [key, raw] of Object.entries(webObject(item.users))) {
			const user = webObject(raw);
			const id = text(user.id_str) ?? text(user.id) ?? key;
			if (/^\d+$/.test(id))
				users.set(id, {
					id,
					username: text(user.screen_name) ?? users.get(id)?.username,
					name: text(user.name) ?? users.get(id)?.name,
					profileImageUrl:
						text(user.profile_image_url_https) ??
						text(user.profile_image_url) ??
						users.get(id)?.profileImageUrl,
				});
		}
		for (const raw of values(item.conversations)) {
			const conversation = webObject(raw);
			const id = text(conversation.conversation_id) ?? text(conversation.id);
			if (id)
				rawConversations.set(id, {
					...rawConversations.get(id),
					...conversation,
					trusted:
						typeof conversation.trusted === "boolean"
							? conversation.trusted
							: rawConversations.get(id)?.trusted,
				});
		}
		const data = webObject(item.message_data);
		const id = text(item.id) ?? text(item.id_str) ?? text(data.id);
		if (id && item.message_data) {
			rawMessages.set(id, item);
			return;
		}
		for (const child of Object.values(value)) visit(child, depth + 1);
	}
	for (const page of pages) visit(page);
	const events: BirdDmEvent[] = [];
	for (const [id, raw] of rawMessages) {
		const data = webObject(raw.message_data);
		const body = text(data.text) ?? text(raw.text);
		if (!body) continue;
		const senderId = text(raw.sender_id) ?? text(data.sender_id);
		const recipientId = text(raw.recipient_id) ?? text(data.recipient_id);
		const conversationId =
			text(raw.conversation_id) ??
			text(data.conversation_id) ??
			(senderId && recipientId
				? [senderId, recipientId].sort().join("-")
				: undefined);
		if (!conversationId) continue;
		const trusted = rawConversations.get(conversationId)?.trusted;
		if (inbox === "requests" && trusted !== false) continue;
		if (inbox === "accepted" && trusted === false) continue;
		const inboxKind =
			typeof trusted === "boolean"
				? trusted
					? "accepted"
					: "request"
				: undefined;
		events.push({
			id,
			conversationId,
			text: body,
			createdAt: timestamp(
				raw.time ?? raw.created_at ?? data.time ?? data.created_at,
			),
			senderId,
			recipientId,
			sender: senderId ? users.get(senderId) : undefined,
			recipient: recipientId ? users.get(recipientId) : undefined,
			...(inboxKind
				? { inboxKind, isMessageRequest: inboxKind === "request" }
				: {}),
		});
	}
	events.sort(
		(a, b) =>
			Date.parse(b.createdAt ?? "") - Date.parse(a.createdAt ?? "") ||
			b.id.localeCompare(a.id),
	);
	const selected = events.slice(0, limit);
	const conversations: BirdDmConversation[] = [];
	for (const id of new Set([
		...rawConversations.keys(),
		...selected.map((event) => event.conversationId!),
	])) {
		const raw = rawConversations.get(id) ?? {};
		if (inbox === "requests" && raw.trusted !== false) continue;
		if (inbox === "accepted" && raw.trusted === false) continue;
		const messages = selected.filter((event) => event.conversationId === id);
		const last = webObject(raw.last_message);
		const preview =
			messages[0]?.text ??
			text(raw.last_message_preview) ??
			text(raw.preview) ??
			text(webObject(last.message_data).text);
		if (!messages.length && !preview) continue;
		const ids = new Set(
			values(raw.participants)
				.map((participant) =>
					typeof participant === "string"
						? participant
						: (text(webObject(participant).user_id) ??
							text(webObject(participant).id)),
				)
				.filter((id): id is string => Boolean(id)),
		);
		for (const event of messages) {
			if (event.senderId) ids.add(event.senderId);
			if (event.recipientId) ids.add(event.recipientId);
		}
		const inboxKind =
			typeof raw.trusted === "boolean"
				? raw.trusted
					? "accepted"
					: "request"
				: undefined;
		conversations.push({
			id,
			participants: [...ids].map((id) => users.get(id) ?? { id }),
			messages,
			lastMessagePreview: preview,
			lastMessageAt:
				messages[0]?.createdAt ??
				timestamp(last.time ?? raw.last_message_time ?? raw.updated_at),
			...(inboxKind
				? { inboxKind, isMessageRequest: inboxKind === "request" }
				: {}),
		});
	}
	return { success: true, events: selected, conversations };
}

function params(inbox: Inbox, cursor?: string) {
	return new URLSearchParams({
		include_groups: "true",
		include_inbox_timelines: "true",
		dm_users: "true",
		skip_status: "1",
		filter_low_quality: String(inbox === "accepted"),
		nsfw_filtering_enabled: "false",
		include_quality: "all",
		dm_secret_conversations_enabled: "false",
		krs_registration_enabled: "false",
		...(cursor ? { max_id: cursor } : {}),
	});
}

function cursorFrom(page: Record<string, unknown>, kind: Timeline) {
	const initial = webObject(
		webObject(webObject(page.inbox_initial_state).inbox_timelines)[kind],
	);
	const timeline = Object.keys(initial).length
		? initial
		: webObject(page.inbox_timeline);
	if (timeline.status !== "HAS_MORE") return undefined;
	const cursor = text(timeline.min_entry_id);
	if (!cursor || !/^\d+$/.test(cursor))
		throw new Error("X web DM pagination returned an invalid cursor");
	return cursor;
}

export async function readWebDirectMessages({
	account,
	limit,
	inbox = "all",
	maxPages = 0,
	allPages = false,
	pageDelayMs = 0,
}: {
	account: LiveAccountIdentity;
	limit: number;
	inbox?: Inbox;
	maxPages?: number;
	allPages?: boolean;
	pageDelayMs?: number;
}) {
	if (
		!Number.isSafeInteger(limit) ||
		limit < 1 ||
		!Number.isSafeInteger(maxPages) ||
		maxPages < 0 ||
		!Number.isSafeInteger(pageDelayMs) ||
		pageDelayMs < 0
	)
		throw new Error("Invalid X web DM pagination options");
	const session = new XWebSession();
	const authenticated = await session.verifyAccount(account);
	const first = await session.json(
		`/i/api/1.1/dm/inbox_initial_state.json?${params(inbox)}`,
	);
	if (
		!first.inbox_initial_state ||
		typeof first.inbox_initial_state !== "object" ||
		Array.isArray(first.inbox_initial_state)
	)
		throw new Error("X web returned an invalid DM inbox");
	const pages = [first];
	const kinds: Timeline[] =
		inbox === "accepted"
			? ["trusted"]
			: inbox === "requests"
				? ["untrusted"]
				: ["trusted", "untrusted"];
	for (const kind of kinds) {
		let cursor = cursorFrom(first, kind);
		const seen = new Set<string>();
		for (let page = 0; cursor && page < (allPages ? 250 : maxPages); page++) {
			if (seen.has(cursor))
				throw new Error("X web DM pagination repeated a cursor");
			if (
				!allPages &&
				inbox !== "all" &&
				parseWebDirectMessages(pages, inbox, limit).events.length >= limit
			)
				break;
			seen.add(cursor);
			if (pageDelayMs)
				await new Promise((resolve) => setTimeout(resolve, pageDelayMs));
			const next = await session.json(
				`/i/api/1.1/dm/inbox_timeline/${kind}.json?${params(inbox, cursor)}`,
			);
			if (
				!next.inbox_timeline ||
				typeof next.inbox_timeline !== "object" ||
				Array.isArray(next.inbox_timeline)
			)
				throw new Error("X web returned an invalid DM timeline");
			pages.push(next);
			cursor = cursorFrom(next, kind);
			if (cursor && seen.has(cursor))
				throw new Error("X web DM pagination repeated a cursor");
		}
	}
	return {
		authenticated,
		payload: parseWebDirectMessages(pages, inbox, limit),
	};
}

export async function mutateWebDirectMessage({
	account,
	conversationId,
	action,
	targetUserId,
}: {
	account: LiveAccountIdentity;
	conversationId: string;
	action: "accept" | "reject" | "block";
	targetUserId?: string;
}): Promise<BirdDmMutationResponse> {
	if (process.env.BIRDCLAW_DISABLE_LIVE_WRITES === "1")
		return { success: false, error: "live writes disabled" };
	if (!/^\d+(?:-\d+)?$/.test(conversationId))
		throw new Error("Invalid X DM conversation id");
	const session = new XWebSession();
	const authenticated = await session.verifyAccount(account);
	if (action === "block") {
		// The local conversation supplies a target, but the authenticated pair
		// must independently agree before any block request is sent.
		if (
			!targetUserId ||
			!/^\d+$/.test(targetUserId) ||
			targetUserId === authenticated.id
		)
			throw new Error("A single other DM participant is required for blocking");
		const participants = conversationId.split("-");
		if (
			participants.length !== 2 ||
			!participants.includes(authenticated.id) ||
			!participants.includes(targetUserId)
		)
			throw new Error("Cannot block an ambiguous DM participant");
		const result = await session.json(
			"/i/api/1.1/blocks/create.json",
			new URLSearchParams({ user_id: targetUserId }),
		);
		if (
			(result.id_str ?? result.id) !== targetUserId ||
			result.blocking !== true
		)
			throw new Error("X web did not confirm the DM participant block");
		return { success: true, conversationId, blockedUserId: targetUserId };
	}
	await session.json(
		`/i/api/1.1/dm/conversation/${conversationId}/${action === "accept" ? "accept" : "delete"}.json`,
		new URLSearchParams({ conversation_id: conversationId }),
		true,
	);
	return { success: true, conversationId };
}
