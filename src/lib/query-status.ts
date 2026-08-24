import { Effect } from "effect";
import type { QueryEnvelope } from "./api-contracts";
import type { Database } from "./sqlite";
import { findArchivesCachedEffect } from "./archive-finder";
import { getReadDb } from "./db";
import { runEffectPromise, trySync } from "./effect-runtime";
import type { AccountRecord } from "./types";
import { getTransportStatusEffect } from "./xurl";

export type { QueryEnvelope } from "./api-contracts";

function countTimelineEdges(db: Database, kind: "home" | "mention") {
	const row = db
		.prepare(
			`
      select count(distinct tweet_id) as count
			from tweet_account_edges edge
			where edge.kind = ?
			  and exists (
				select 1 from tweets t
				where t.id = edge.tweet_id
				  and t.deleted_at is null
				  and t.superseded_at is null
			  )
      `,
		)
		.get(kind) as { count: number | bigint } | undefined;
	return Number(row?.count ?? 0);
}

function getAccountProfileMeta(
	db: Database,
	account: { handle: string; external_user_id: string | null },
) {
	const handle = account.handle.replace(/^@/, "");
	const externalProfileId = account.external_user_id
		? `profile_user_${account.external_user_id}`
		: "";
	return db
		.prepare(
			`
      select id, avatar_hue, avatar_url
      from profiles
      where id = ?
         or lower(handle) = lower(?)
      order by case
        when id = 'profile_me' then 0
        when id = ? then 1
        else 2
      end
      limit 1
    `,
		)
		.get(externalProfileId, handle, externalProfileId) as
		| { id: string; avatar_hue: number; avatar_url: string | null }
		| undefined;
}

function readLocalQueryEnvelope(db: Database) {
	return db.readTransaction(() => {
		const homeCount = countTimelineEdges(db, "home");
		const mentionCount = countTimelineEdges(db, "mention");
		const dms = db
			.prepare("select count(*) as count from dm_conversations")
			.get() as { count: number };
		const needsReply = db
			.prepare(
				"select count(*) as count from dm_conversations where needs_reply = 1",
			)
			.get() as { count: number };
		const accountRows = db
			.prepare("select * from accounts order by is_default desc, name asc")
			.all() as Array<{
			id: string;
			name: string;
			handle: string;
			external_user_id: string | null;
			transport: string;
			is_default: number;
			created_at: string;
		}>;
		const accounts = accountRows.map((row) => {
			const profile = getAccountProfileMeta(db, row);
			return {
				id: row.id,
				name: row.name,
				handle: row.handle,
				externalUserId: row.external_user_id,
				...(profile
					? {
							profileId: profile.id,
							avatarHue: Number(profile.avatar_hue),
							...(profile.avatar_url ? { avatarUrl: profile.avatar_url } : {}),
						}
					: {}),
				transport: row.transport,
				isDefault: row.is_default,
				createdAt: row.created_at,
			};
		}) satisfies AccountRecord[];

		return {
			stats: {
				home: homeCount,
				mentions: mentionCount,
				dms: Number(dms.count),
				needsReply: Number(needsReply.count),
				inbox: mentionCount + Number(needsReply.count),
			},
			accounts,
		};
	})();
}

export function getQueryEnvelopeEffect({
	includeArchives = true,
}: { includeArchives?: boolean } = {}): Effect.Effect<QueryEnvelope, unknown> {
	return Effect.gen(function* () {
		const local = yield* trySync(() => readLocalQueryEnvelope(getReadDb()));
		const external = yield* Effect.all({
			archives: includeArchives
				? findArchivesCachedEffect()
				: Effect.succeed([]),
			transport: getTransportStatusEffect(),
		});

		return {
			...local,
			archives: external.archives,
			transport: external.transport,
		};
	});
}

export function getQueryEnvelope(
	options: { includeArchives?: boolean } = {},
): Promise<QueryEnvelope> {
	return runEffectPromise(getQueryEnvelopeEffect(options));
}
