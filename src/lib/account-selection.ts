import type { Database } from "./sqlite";
import { getNativeDb } from "./db";

export interface OperationAccount {
	id: string;
	username: string;
	externalUserId?: string;
}

function normalizedAccountSelector(selector: string) {
	return selector.trim().replace(/^@/, "");
}

export function findOperationAccount(
	db: Database,
	selector?: string,
): OperationAccount | undefined {
	const row =
		selector === undefined
			? (db
					.prepare(
						`select id, handle, external_user_id
					 from accounts
					 order by is_default desc, created_at asc
					 limit 1`,
					)
					.get() as
					| { id: string; handle: string; external_user_id: string | null }
					| undefined)
			: findSelectedAccount(db, selector);

	return row
		? {
				id: row.id,
				username: row.handle.replace(/^@/, ""),
				...(row.external_user_id
					? { externalUserId: row.external_user_id }
					: {}),
			}
		: undefined;
}

function findSelectedAccount(db: Database, selector: string) {
	const trimmed = selector.trim();
	const normalized = normalizedAccountSelector(selector);
	if (!normalized) return undefined;
	const byId = db
		.prepare("select id, handle, external_user_id from accounts where id = ?")
		.get(trimmed) as
		| { id: string; handle: string; external_user_id: string | null }
		| undefined;
	if (byId) return byId;
	return db
		.prepare(
			`select id, handle, external_user_id
			 from accounts
			 where lower(replace(handle, '@', '')) = lower(?)
			 order by is_default desc, created_at asc
			 limit 1`,
		)
		.get(normalized) as
		| { id: string; handle: string; external_user_id: string | null }
		| undefined;
}

export function resolveOperationAccount(
	selector?: string,
	db = getNativeDb(),
): OperationAccount {
	const account = findOperationAccount(db, selector);
	if (!account) {
		throw new Error(`Unknown account: ${selector?.trim() || "default"}`);
	}
	return account;
}
