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
	const hasSelector = selector !== undefined;
	const normalized = hasSelector
		? normalizedAccountSelector(selector)
		: undefined;
	if (hasSelector && !normalized) return undefined;
	const row = hasSelector
		? (db
				.prepare(
					`select id, handle, external_user_id
					 from accounts
					 where id = ?
					    or lower(replace(handle, '@', '')) = lower(?)
					 order by case when id = ? then 0 else 1 end,
					          is_default desc,
					          created_at asc
					 limit 1`,
				)
				.get(selector.trim(), normalized, selector.trim()) as
				| { id: string; handle: string; external_user_id: string | null }
				| undefined)
		: (db
				.prepare(
					`select id, handle, external_user_id
					 from accounts
					 order by is_default desc, created_at asc
					 limit 1`,
				)
				.get() as
				| { id: string; handle: string; external_user_id: string | null }
				| undefined);

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

export function resolveOperationAccount(selector?: string): OperationAccount {
	const account = findOperationAccount(getNativeDb(), selector);
	if (!account) {
		throw new Error(`Unknown account: ${selector?.trim() || "default"}`);
	}
	return account;
}
