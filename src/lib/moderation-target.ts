import type { Database } from "./sqlite";
import { Effect } from "effect";
import { lookupProfileViaBirdEffect } from "./bird-actions";
import { getNativeDb } from "./db";
import { databaseWriteEffect } from "./database-writer";
import { runEffectPromise } from "./effect-runtime";
import { normalizeProfileHandle, profileFromDbRow } from "./profile-row";
import type { ProfileRecord, XurlMentionUser } from "./types";
import { getExternalUserId, upsertProfileFromXUser } from "./x-profile";
import {
	lookupAuthenticatedUserEffect,
	lookupUsersByHandlesEffect,
	lookupUsersByIdsEffect,
} from "./xurl";

export interface ResolvedModerationProfile {
	profile: ProfileRecord;
	externalUserId: string | null;
}

function toError(error: unknown) {
	return error instanceof Error ? error : new Error(String(error));
}

function trySync<T>(try_: () => T) {
	return Effect.try({
		try: try_,
		catch: toError,
	});
}

export function normalizeProfileQuery(value: string) {
	const trimmed = value.trim();
	if (!trimmed) return "";

	const withoutPrefix = trimmed.replace(/^@/, "");
	const urlMatch = withoutPrefix.match(
		/^(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\/([^/?#]+)/i,
	);
	return (urlMatch?.[1] ?? withoutPrefix).replace(/^@/, "").trim();
}

export function getDefaultAccountId(db: Database) {
	const row = db
		.prepare(
			`
      select id
      from accounts
      order by is_default desc, created_at asc
      limit 1
      `,
		)
		.get() as { id: string } | undefined;
	return row?.id ?? "acct_primary";
}

export function getAccountHandle(db: Database, accountId: string) {
	const row = db
		.prepare("select handle from accounts where id = ?")
		.get(accountId) as { handle: string } | undefined;
	return normalizeProfileHandle(row?.handle);
}

export function resolveLocalProfile(
	db: Database,
	normalizedQuery: string,
): ResolvedModerationProfile | null {
	const row = db
		.prepare(
			`
      select id, handle, display_name, bio, followers_count, following_count, avatar_hue, avatar_url, created_at
      from profiles
      where id = ? or handle = ?
      limit 1
      `,
		)
		.get(normalizedQuery, normalizedQuery) as
		| Record<string, unknown>
		| undefined;

	if (!row) {
		return null;
	}

	const profile = profileFromDbRow(row);
	return {
		profile,
		externalUserId: getExternalUserId(profile.id),
	};
}

export function resolveProfileEffect(
	query: string,
	providedDb?: Database,
): Effect.Effect<ResolvedModerationProfile, unknown> {
	return Effect.gen(function* () {
		const db = providedDb ?? (yield* trySync(() => getNativeDb()));
		const normalizedQuery = normalizeProfileQuery(query);
		if (!normalizedQuery) {
			return yield* Effect.fail(new Error("Missing profile handle or id"));
		}

		const local = yield* trySync(() =>
			resolveLocalProfile(db, normalizedQuery),
		);
		if (process.env.BIRDCLAW_DISABLE_LIVE_PROFILE_LOOKUP === "1") {
			if (local) {
				return local;
			}
			return yield* Effect.fail(
				new Error(`Profile not found locally: ${query}`),
			);
		}
		if (
			local &&
			!local.profile.id.startsWith("profile_group_") &&
			local.externalUserId
		) {
			return local;
		}

		let user: XurlMentionUser | undefined;
		let lastError: unknown;

		const birdResult = yield* lookupProfileViaBirdEffect(
			local?.profile.handle ?? normalizedQuery,
		).pipe(
			Effect.map((value) => ({ ok: true as const, value })),
			Effect.catchAll((error) => Effect.succeed({ ok: false as const, error })),
		);
		if (birdResult.ok) {
			user = birdResult.value ?? undefined;
		} else {
			lastError = birdResult.error;
		}

		if (!user) {
			const xurlResult = yield* (
				/^\d+$/.test(normalizedQuery)
					? lookupUsersByIdsEffect([normalizedQuery])
					: lookupUsersByHandlesEffect([
							local?.profile.handle ?? normalizedQuery,
						])
			).pipe(
				Effect.map((value) => ({ ok: true as const, value })),
				Effect.catchAll((error) =>
					Effect.succeed({ ok: false as const, error }),
				),
			);
			if (xurlResult.ok) {
				[user] = xurlResult.value;
			} else {
				lastError = xurlResult.error;
			}
		}

		if (!user && lastError) {
			if (local) {
				return local;
			}
			return yield* Effect.fail(lastError);
		}

		if (!user) {
			if (local) {
				return local;
			}
			return yield* Effect.fail(new Error(`Profile not found: ${query}`));
		}

		if (local) {
			return yield* databaseWriteEffect(
				(writeDb) => upsertProfileFromXUser(writeDb, user),
				db,
			);
		}

		const username = String(user.username ?? "").replace(/^@/, "");
		if (username) {
			const localByHandle = yield* trySync(() =>
				resolveLocalProfile(db, username),
			);
			if (localByHandle) {
				return yield* databaseWriteEffect(
					(writeDb) => upsertProfileFromXUser(writeDb, user),
					db,
				);
			}
		}

		return yield* databaseWriteEffect(
			(writeDb) => upsertProfileFromXUser(writeDb, user),
			db,
		);
	});
}

export function resolveProfile(
	query: string,
): Promise<ResolvedModerationProfile> {
	return runEffectPromise(resolveProfileEffect(query));
}

export function getAuthenticatedUserIdEffect() {
	return Effect.gen(function* () {
		const me = yield* lookupAuthenticatedUserEffect();
		const id = me?.id;
		return typeof id === "string" && id.length > 0 ? id : null;
	}).pipe(Effect.catchAll(() => Effect.succeed(null)));
}

export function getAuthenticatedUserId() {
	return runEffectPromise(getAuthenticatedUserIdEffect());
}
