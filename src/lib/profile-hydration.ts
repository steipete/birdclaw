import { normalizeAvatarUrl } from "./avatar-cache";
import { getNativeDb } from "./db";
import {
	getTransportStatus,
	lookupAuthenticatedUser,
	lookupUsersByIds,
} from "./xurl";
import { upsertProfileFromXUser } from "./x-profile";

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function toInt(value: unknown) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

export async function hydrateProfilesFromX() {
	const transport = await getTransportStatus();
	if (transport.availableTransport !== "xurl") {
		return {
			ok: true,
			hydratedProfiles: 0,
			hydratedAccount: false,
			reason: transport.statusText,
		};
	}

	const db = getNativeDb();
	const candidateRows = db
		.prepare(
			`
      select id
      from profiles
      where id like 'profile_user_%'
        and (followers_count = 0 or bio like 'Imported from archive user %' or handle like 'id%')
      order by id asc
      `,
		)
		.all() as Array<{ id: string }>;

	const candidateIds = candidateRows
		.map((row) => row.id.replace(/^profile_user_/, ""))
		.filter((id) => /^\d+$/.test(id));

	const updateConversationTitle = db.prepare(`
    update dm_conversations
    set title = ?
    where participant_profile_id = ?
  `);
	const updateLocalProfile = db.prepare(`
    update profiles
    set handle = ?,
        display_name = ?,
        bio = ?,
        followers_count = ?,
        following_count = coalesce(?, following_count),
        avatar_url = coalesce(?, avatar_url),
        created_at = coalesce(?, created_at)
    where id = 'profile_me'
  `);
	const updateAccount = db.prepare(`
    update accounts
    set name = ?,
        handle = ?,
        transport = 'xurl'
    where id = 'acct_primary'
  `);

	let hydratedProfiles = 0;

	for (let index = 0; index < candidateIds.length; index += 100) {
		const batch = candidateIds.slice(index, index + 100);
		const users = await lookupUsersByIds(batch);

		db.transaction(() => {
			for (const user of users) {
				const profileId = `profile_user_${String(user.id ?? "")}`;
				if (profileId === "profile_user_") continue;

				const resolved = upsertProfileFromXUser(db, user);
				updateConversationTitle.run(
					resolved.profile.displayName || resolved.profile.handle,
					resolved.profile.id,
				);
				hydratedProfiles += 1;
			}
		})();
	}

	let hydratedAccount = false;
	const me = await lookupAuthenticatedUser().catch(() => null);
	if (me) {
		const metrics = asRecord(me.public_metrics);
		db.transaction(() => {
			updateLocalProfile.run(
				String(me.username ?? "steipete").replace(/^@/, ""),
				String(me.name ?? "Peter Steinberger"),
				String(me.description ?? ""),
				toInt(metrics?.followers_count),
				metrics && "following_count" in metrics
					? toInt(metrics.following_count)
					: null,
				normalizeAvatarUrl(me.profile_image_url),
				typeof me.created_at === "string" ? me.created_at : null,
			);
			updateAccount.run(
				String(me.name ?? "Peter Steinberger"),
				`@${String(me.username ?? "steipete").replace(/^@/, "")}`,
			);
		})();
		hydratedAccount = true;
	}

	return {
		ok: true,
		hydratedProfiles,
		hydratedAccount,
	};
}

export const __test__ = {
	asRecord,
	toInt,
};
