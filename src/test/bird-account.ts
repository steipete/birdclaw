import type { Database } from "../lib/sqlite";

export function birdAccountForTest(db: Database, accountId: string) {
	const account = db
		.prepare("select handle, external_user_id from accounts where id = ?")
		.get(accountId) as { handle: string; external_user_id: string | null };
	return {
		username: account.handle.replace(/^@/, ""),
		...(account.external_user_id ? { id: account.external_user_id } : {}),
	};
}
