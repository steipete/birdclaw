import { Effect } from "effect";
import type { Database } from "./sqlite";
import { findArchivesCachedEffect } from "./archive-finder";
import { getReadDb } from "./db";
import { runEffectPromise } from "./effect-runtime";
import type { AccountRecord, QueryEnvelope } from "./types";
import { getTransportStatusEffect } from "./xurl";

export type { QueryEnvelope } from "./types";

function toError(error: unknown) {
	return error instanceof Error ? error : new Error(String(error));
}

function trySync<T>(try_: () => T) {
	return Effect.try({ try: try_, catch: toError });
}

function countTimelineEdges(db: Database, kind: "home" | "mention") {
	const row = db
		.prepare(
			`
      select count(distinct tweet_id) as count
      from (
        select edge.tweet_id
        from tweet_account_edges edge
        where edge.kind = ?
          and exists (
            select 1
            from tweets t
            where t.id = edge.tweet_id
          )
        union all
        select legacy.id as tweet_id
        from tweets legacy
        where legacy.kind = ?
          and not exists (
            select 1
            from tweet_account_edges edge
            where edge.account_id = legacy.account_id
              and edge.tweet_id = legacy.id
              and edge.kind = legacy.kind
          )
      )
      `,
		)
		.get(kind, kind) as { count: number | bigint } | undefined;
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

export function getQueryEnvelopeEffect({
	includeArchives = true,
}: { includeArchives?: boolean } = {}): Effect.Effect<QueryEnvelope, unknown> {
	return Effect.gen(function* () {
		const nativeDb = yield* trySync(() => getReadDb());
		const homeCount = yield* trySync(() =>
			countTimelineEdges(nativeDb, "home"),
		);
		const mentionCount = yield* trySync(() =>
			countTimelineEdges(nativeDb, "mention"),
		);
		const counts = yield* Effect.all({
			dms: trySync(
				() =>
					nativeDb
						.prepare("select count(*) as count from dm_conversations")
						.get() as { count: number },
			),
			needsReply: trySync(
				() =>
					nativeDb
						.prepare(
							"select count(*) as count from dm_conversations where needs_reply = 1",
						)
						.get() as { count: number },
			),
			accounts: trySync(
				() =>
					nativeDb
						.prepare(
							"select * from accounts order by is_default desc, name asc",
						)
						.all() as Array<{
						id: string;
						name: string;
						handle: string;
						external_user_id: string | null;
						transport: string;
						is_default: number;
						created_at: string;
					}>,
			),
			archives: includeArchives
				? findArchivesCachedEffect()
				: Effect.succeed([]),
			transport: getTransportStatusEffect(),
		});

		return {
			stats: {
				home: homeCount,
				mentions: mentionCount,
				dms: Number(counts.dms.count),
				needsReply: Number(counts.needsReply.count),
				inbox: mentionCount + Number(counts.needsReply.count),
			},
			accounts: counts.accounts.map((row) => {
				const profile = getAccountProfileMeta(nativeDb, row);
				return {
					id: row.id,
					name: row.name,
					handle: row.handle,
					externalUserId: row.external_user_id,
					...(profile
						? {
								profileId: profile.id,
								avatarHue: Number(profile.avatar_hue),
								...(profile.avatar_url
									? { avatarUrl: profile.avatar_url }
									: {}),
							}
						: {}),
					transport: row.transport,
					isDefault: row.is_default,
					createdAt: row.created_at,
				};
			}) satisfies AccountRecord[],
			archives: counts.archives,
			transport: counts.transport,
		};
	});
}

export function getQueryEnvelope(): Promise<QueryEnvelope> {
	return runEffectPromise(getQueryEnvelopeEffect());
}
