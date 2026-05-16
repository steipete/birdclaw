import { getNativeDb } from "./db";
import { toProfile } from "./moderation-target";
import type { BlockItem } from "./types";

export {
	addMute,
	addMuteEffect,
	recordMute,
	recordMuteEffect,
	removeMute,
	removeMuteEffect,
} from "./mutes-write";

export interface MuteItem {
	accountId: string;
	accountHandle: string;
	source: string;
	mutedAt: string;
	profile: BlockItem["profile"];
}

export function listMutes({
	account,
	search,
	limit = 50,
}: {
	account?: string;
	search?: string;
	limit?: number;
} = {}): MuteItem[] {
	const db = getNativeDb();
	const params: Array<string | number> = [];
	let where = "where 1 = 1";

	if (account && account !== "all") {
		where += " and m.account_id = ?";
		params.push(account);
	}

	if (search?.trim()) {
		where += " and (p.handle like ? or p.display_name like ? or p.bio like ?)";
		params.push(
			`%${search.trim()}%`,
			`%${search.trim()}%`,
			`%${search.trim()}%`,
		);
	}

	params.push(limit);

	const rows = db
		.prepare(
			`
      select
        m.account_id,
        a.handle as account_handle,
        m.source,
        m.created_at as muted_at,
        p.id,
        p.handle,
        p.display_name,
        p.bio,
        p.followers_count,
        p.avatar_hue,
        p.avatar_url,
        p.created_at
      from mutes m
      join accounts a on a.id = m.account_id
      join profiles p on p.id = m.profile_id
      ${where}
      order by m.created_at desc
      limit ?
      `,
		)
		.all(...params) as Array<Record<string, unknown>>;

	return rows.map((row) => ({
		accountId: String(row.account_id),
		accountHandle: String(row.account_handle),
		source: String(row.source),
		mutedAt: String(row.muted_at),
		profile: toProfile(row),
	}));
}
