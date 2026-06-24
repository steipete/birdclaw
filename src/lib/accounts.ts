import { databaseWriteEffect } from "./database-writer";
import { runEffectPromise } from "./effect-runtime";

export interface AccountBirdProfileResult {
	ok: true;
	accountId: string;
	birdProfileName: string | null;
}

function normalizeProfileName(profileName: string) {
	const trimmed = profileName.trim();
	if (!trimmed) {
		throw new Error("bird profile name must not be empty");
	}
	return trimmed;
}

export function setAccountBirdProfileEffect(
	accountId: string,
	profileName: string,
) {
	return databaseWriteEffect((db): AccountBirdProfileResult => {
		const normalized = normalizeProfileName(profileName);
		const result = db
			.prepare("update accounts set bird_profile_name = ? where id = ?")
			.run(normalized, accountId);
		if (result.changes === 0) {
			throw new Error(`Unknown account: ${accountId}`);
		}
		return { ok: true, accountId, birdProfileName: normalized };
	});
}

export function clearAccountBirdProfileEffect(accountId: string) {
	return databaseWriteEffect((db): AccountBirdProfileResult => {
		const result = db
			.prepare("update accounts set bird_profile_name = null where id = ?")
			.run(accountId);
		if (result.changes === 0) {
			throw new Error(`Unknown account: ${accountId}`);
		}
		return { ok: true, accountId, birdProfileName: null };
	});
}

export function setAccountBirdProfile(accountId: string, profileName: string) {
	return runEffectPromise(setAccountBirdProfileEffect(accountId, profileName));
}

export function clearAccountBirdProfile(accountId: string) {
	return runEffectPromise(clearAccountBirdProfileEffect(accountId));
}
