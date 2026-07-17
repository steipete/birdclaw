import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import type { Database } from "./sqlite";
import { getReadDb } from "./db";
import { databaseWriteEffect } from "./database-writer";
import { getConversationThread } from "./dm-read-model";
import { runEffectPromise, tryPromise } from "./effect-runtime";
import { upsertTweetAccountEdge } from "./tweet-account-edges";
import {
	dmViaXurlEffect,
	lookupAuthenticatedUserFresh,
	postViaXurlEffect,
	replyViaXurlEffect,
} from "./xurl";

function toError(error: unknown) {
	return error instanceof Error ? error : new Error(String(error));
}

function trySync<T>(try_: () => T) {
	return Effect.try({ try: try_, catch: toError });
}

function e2eFakeLiveWritesEnabled() {
	return (
		process.env.BIRDCLAW_E2E === "1" &&
		process.env.BIRDCLAW_E2E_FAKE_LIVE_WRITES === "1"
	);
}

function liveWritesDisabled() {
	return process.env.BIRDCLAW_DISABLE_LIVE_WRITES === "1";
}

function verifySelectedXurlAccountEffect(accountId: string) {
	return Effect.gen(function* () {
		if (liveWritesDisabled()) return;
		if (e2eFakeLiveWritesEnabled()) return;
		const db = yield* trySync(() => getReadDb());
		const account = yield* trySync(
			() =>
				db
					.prepare("select handle, external_user_id from accounts where id = ?")
					.get(accountId) as
					| { handle: string; external_user_id: string | null }
					| undefined,
		);
		if (!account) {
			return yield* Effect.fail(new Error(`Unknown account: ${accountId}`));
		}
		const authenticated = yield* tryPromise(() =>
			lookupAuthenticatedUserFresh(),
		);
		const authenticatedId =
			typeof authenticated?.id === "string" ? authenticated.id : "";
		const authenticatedHandle =
			typeof authenticated?.username === "string"
				? authenticated.username.replace(/^@/, "")
				: "";
		const expectedHandle = account.handle.replace(/^@/, "");
		if (
			(account.external_user_id &&
				account.external_user_id !== authenticatedId) ||
			(!account.external_user_id &&
				(!authenticatedHandle ||
					authenticatedHandle.toLowerCase() !== expectedHandle.toLowerCase()))
		) {
			return yield* Effect.fail(
				new Error(
					`xurl is authenticated as @${authenticatedHandle || authenticatedId}, not @${expectedHandle}`,
				),
			);
		}
	});
}

function refreshDmConversationState(
	db: Database,
	conversationId: string,
	lastMessageAt: string,
	observedLastMessageAt = lastMessageAt,
) {
	db.prepare(
		`
    update dm_conversations
    set last_message_at = case
          when last_message_at < ? then ?
          else last_message_at
        end,
        unread_count = case
          when last_message_at = ? then 0
          when last_message_at <= ? then 0
          else unread_count
        end,
        needs_reply = case
          when last_message_at = ? then 0
          when last_message_at <= ? then 0
          else needs_reply
        end
    where id = ?
    `,
	).run(
		lastMessageAt,
		lastMessageAt,
		observedLastMessageAt,
		lastMessageAt,
		observedLastMessageAt,
		lastMessageAt,
		conversationId,
	);
}

function getLocalAuthorProfileId(accountId: string) {
	const db = getReadDb();
	const row = db
		.prepare(
			`
      select p.id
      from accounts a
      join profiles p on p.handle = replace(a.handle, '@', '')
      where a.id = ?
      `,
		)
		.get(accountId) as { id: string } | undefined;

	return row?.id;
}

let savepointCounter = 0;

function preflightWrite<T>(db: Database, write: (db: Database) => T) {
	const savepoint = `__birdclaw_preflight_${++savepointCounter}`;
	db.exec(`savepoint ${savepoint}`);
	try {
		const result = write(db);
		db.exec(`rollback to ${savepoint}`);
		db.exec(`release ${savepoint}`);
		return result;
	} catch (error) {
		try {
			db.exec(`rollback to ${savepoint}`);
			db.exec(`release ${savepoint}`);
		} catch {
			// Preserve the original staging error; cleanup is best effort here.
		}
		throw error;
	}
}

type PostDraft = {
	actionId: string;
	authorProfileId: string;
	createdAt: string;
	tweetId: string;
};

function preparePostDraft(accountId: string): PostDraft {
	const authorProfileId = getLocalAuthorProfileId(accountId);
	if (!authorProfileId) {
		throw new Error("No local author profile for account");
	}

	return {
		actionId: randomUUID(),
		authorProfileId,
		createdAt: new Date().toISOString(),
		tweetId: `tweet_${randomUUID()}`,
	};
}

function writePostDraft(
	db: Database,
	accountId: string,
	text: string,
	draft: PostDraft,
) {
	db.prepare(
		`
    insert into tweets (
      id, author_profile_id, text, created_at,
      is_replied, reply_to_id, like_count, media_count
    ) values (?, ?, ?, ?, 0, null, 0, 0)
    `,
	).run(draft.tweetId, draft.authorProfileId, text, draft.createdAt);
	upsertTweetAccountEdge(db, {
		accountId,
		tweetId: draft.tweetId,
		kind: "home",
		source: "local",
		seenAt: draft.createdAt,
	});

	db.prepare("insert into tweets_fts (tweet_id, text) values (?, ?)").run(
		draft.tweetId,
		text,
	);
	db.prepare(
		"insert into tweet_actions (id, account_id, tweet_id, kind, body, created_at) values (?, ?, ?, ?, ?, ?)",
	).run(
		draft.actionId,
		accountId,
		draft.tweetId,
		"post",
		text,
		draft.createdAt,
	);
}

export function createPostEffect(accountId: string, text: string) {
	return Effect.gen(function* () {
		const draft = yield* trySync(() => preparePostDraft(accountId));
		yield* databaseWriteEffect((db) =>
			preflightWrite(db, (writeDb) =>
				writePostDraft(writeDb, accountId, text, draft),
			),
		);

		yield* verifySelectedXurlAccountEffect(accountId);
		const transport = yield* postViaXurlEffect(text);
		if (!transport.ok) {
			return yield* Effect.fail(new Error(transport.output || "post failed"));
		}
		yield* databaseWriteEffect((db) =>
			writePostDraft(db, accountId, text, draft),
		);

		return { ok: true, transport, tweetId: draft.tweetId };
	});
}

export function createPost(accountId: string, text: string) {
	return runEffectPromise(createPostEffect(accountId, text));
}

export function createTweetReplyEffect(
	accountId: string,
	tweetId: string,
	text: string,
) {
	type ReplyDraft = PostDraft & { replyId: string };

	function prepareReplyDraft(): ReplyDraft {
		const postDraft = preparePostDraft(accountId);
		return {
			...postDraft,
			replyId: postDraft.tweetId,
		};
	}

	function writeReplyDraft(db: Database, draft: ReplyDraft) {
		db.prepare("update tweets set is_replied = 1 where id = ?").run(tweetId);

		db.prepare(
			`
    insert into tweets (
      id, author_profile_id, text, created_at,
      is_replied, reply_to_id, like_count, media_count
    ) values (?, ?, ?, ?, 1, ?, 0, 0)
    `,
		).run(draft.replyId, draft.authorProfileId, text, draft.createdAt, tweetId);
		upsertTweetAccountEdge(db, {
			accountId,
			tweetId: draft.replyId,
			kind: "home",
			source: "local",
			seenAt: draft.createdAt,
		});
		db.prepare("insert into tweets_fts (tweet_id, text) values (?, ?)").run(
			draft.replyId,
			text,
		);

		db.prepare(
			"insert into tweet_actions (id, account_id, tweet_id, kind, body, created_at) values (?, ?, ?, ?, ?, ?)",
		).run(draft.actionId, accountId, tweetId, "reply", text, draft.createdAt);
	}

	return Effect.gen(function* () {
		const draft = yield* trySync(() => prepareReplyDraft());
		yield* databaseWriteEffect((db) =>
			preflightWrite(db, (writeDb) => writeReplyDraft(writeDb, draft)),
		);

		yield* verifySelectedXurlAccountEffect(accountId);
		const transport = yield* replyViaXurlEffect(tweetId, text);
		if (!transport.ok) {
			return yield* Effect.fail(new Error(transport.output || "reply failed"));
		}
		yield* databaseWriteEffect((db) => writeReplyDraft(db, draft));

		return { ok: true, transport, replyId: draft.replyId };
	});
}

export function createTweetReply(
	accountId: string,
	tweetId: string,
	text: string,
) {
	return runEffectPromise(createTweetReplyEffect(accountId, tweetId, text));
}

export function createDmReplyEffect(
	conversationId: string,
	text: string,
	accountId?: string,
) {
	return Effect.gen(function* () {
		const draft = yield* trySync(() => {
			const conversation = getConversationThread(conversationId);
			if (!conversation) {
				throw new Error("Conversation not found");
			}
			if (accountId && conversation.conversation.accountId !== accountId) {
				throw new Error(
					`Conversation belongs to ${conversation.conversation.accountId}, not ${accountId}`,
				);
			}
			const authorProfileId = getLocalAuthorProfileId(
				conversation.conversation.accountId,
			);
			if (!authorProfileId) {
				throw new Error("No local author profile for account");
			}

			const dmDraft = {
				accountId: conversation.conversation.accountId,
				authorProfileId,
				createdAt: new Date().toISOString(),
				handle: conversation.conversation.participant.handle,
				observedLastMessageAt: conversation.conversation.lastMessageAt,
				outboundId: `msg_${randomUUID()}`,
			};
			return dmDraft;
		});
		yield* databaseWriteEffect((db) =>
			preflightWrite(db, (writeDb) => {
				writeDb
					.prepare(
						`
    insert into dm_messages (
      id, conversation_id, sender_profile_id, text, created_at, direction, is_replied, media_count
    ) values (?, ?, ?, ?, ?, 'outbound', 1, 0)
    `,
					)
					.run(
						draft.outboundId,
						conversationId,
						draft.authorProfileId,
						text,
						draft.createdAt,
					);
				writeDb
					.prepare("insert into dm_fts (message_id, text) values (?, ?)")
					.run(draft.outboundId, text);

				refreshDmConversationState(
					writeDb,
					conversationId,
					draft.createdAt,
					draft.observedLastMessageAt,
				);
			}),
		);

		yield* verifySelectedXurlAccountEffect(draft.accountId);
		const transport = yield* dmViaXurlEffect(draft.handle, text);
		if (!transport.ok) {
			return yield* Effect.fail(new Error(transport.output || "dm failed"));
		}
		yield* databaseWriteEffect((db) => {
			db.prepare(
				`
    insert into dm_messages (
      id, conversation_id, sender_profile_id, text, created_at, direction, is_replied, media_count
    ) values (?, ?, ?, ?, ?, 'outbound', 1, 0)
    `,
			).run(
				draft.outboundId,
				conversationId,
				draft.authorProfileId,
				text,
				draft.createdAt,
			);
			db.prepare("insert into dm_fts (message_id, text) values (?, ?)").run(
				draft.outboundId,
				text,
			);

			refreshDmConversationState(
				db,
				conversationId,
				draft.createdAt,
				draft.observedLastMessageAt,
			);
		});

		return { ok: true, transport, messageId: draft.outboundId };
	});
}

export function createDmReply(
	conversationId: string,
	text: string,
	accountId?: string,
) {
	return runEffectPromise(createDmReplyEffect(conversationId, text, accountId));
}

export type DmRequestMutationAction = "accept" | "reject" | "block";

export async function applyDmRequestMutationToLocalStore(
	conversationId: string,
	action: DmRequestMutationAction,
) {
	return runEffectPromise(
		databaseWriteEffect((db) => {
			db.prepare(
				"delete from sync_cache where cache_key like 'dms:bird:%'",
			).run();
			if (action === "accept") {
				return db
					.prepare(
						`
    update dm_conversations
    set inbox_kind = 'accepted'
    where id = ?
    `,
					)
					.run(conversationId).changes;
			}

			db.prepare(
				`
    delete from link_occurrences
    where source_kind = 'dm'
      and source_id in (
        select id from dm_messages where conversation_id = ?
      )
    `,
			).run(conversationId);
			db.prepare(
				`
    delete from dm_fts
    where message_id in (
      select id from dm_messages where conversation_id = ?
    )
    `,
			).run(conversationId);
			db.prepare("delete from dm_messages where conversation_id = ?").run(
				conversationId,
			);
			return db
				.prepare("delete from dm_conversations where id = ?")
				.run(conversationId).changes;
		}),
	);
}
