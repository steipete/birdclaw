import type { Database } from "./sqlite";

function toProfileName(value: unknown) {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: undefined;
}

export function getBirdProfileName(
	db: Database,
	accountId?: string,
): string | undefined {
	const row = accountId
		? (db
				.prepare(
					"select bird_profile_name from accounts where id = ?",
				)
				.get(accountId) as { bird_profile_name: string | null } | undefined)
		: (db
				.prepare(
					`
          select bird_profile_name
          from accounts
          order by is_default desc, created_at asc
          limit 1
          `,
				)
				.get() as { bird_profile_name: string | null } | undefined);

	return row ? toProfileName(row.bird_profile_name) : undefined;
}

