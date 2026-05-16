import { readFile } from "node:fs/promises";
import { Effect } from "effect";
import { addBlock } from "./blocks";
import { runEffectPromise, tryPromise } from "./effect-runtime";

export interface BlocklistImportItem {
	query: string;
	ok: boolean;
	blockedAt?: string;
	handle?: string;
	error?: string;
}

export interface BlocklistImportResult {
	ok: boolean;
	accountId: string;
	path: string;
	requestedCount: number;
	blockedCount: number;
	failedCount: number;
	items: BlocklistImportItem[];
}

function stripInlineCode(value: string) {
	const match = value.match(/`([^`]+)`/);
	return match?.[1] ?? value;
}

function extractQueryFromLine(value: string) {
	const trimmed = value.trim();
	if (!trimmed || trimmed.startsWith("#")) {
		return null;
	}

	if (
		!trimmed.startsWith("@") &&
		!trimmed.startsWith("-") &&
		!trimmed.startsWith("*") &&
		!trimmed.startsWith("+") &&
		!trimmed.startsWith("`") &&
		!trimmed.startsWith("http") &&
		trimmed.split(/\s+/).length > 1
	) {
		return null;
	}

	const withoutBullet = trimmed.replace(/^(?:[-*+]|\d+\.)\s+/, "");
	const withoutCode = stripInlineCode(withoutBullet).trim();
	if (!withoutCode) {
		return null;
	}

	if (/^(?:https?:\/\/)/i.test(withoutCode)) {
		return withoutCode.split(/\s+/)[0] ?? null;
	}

	return (
		withoutCode
			.split(/[,\s:;]+/)[0]
			?.replace(/^["'`]+|["'`,.]+$/g, "")
			.trim() ?? null
	);
}

export function parseBlocklistText(text: string) {
	const items: string[] = [];
	const seen = new Set<string>();

	for (const line of text.split(/\r?\n/)) {
		const query = extractQueryFromLine(line);
		if (!query || seen.has(query)) {
			continue;
		}
		seen.add(query);
		items.push(query);
	}

	return items;
}

export function importBlocklistEffect(accountId: string, filePath: string) {
	return Effect.gen(function* () {
		const text = yield* tryPromise(() => readFile(filePath, "utf8"));
		const queries = parseBlocklistText(text);
		const items: BlocklistImportItem[] = [];

		for (const query of queries) {
			const blocked = yield* tryPromise(() => addBlock(accountId, query)).pipe(
				Effect.map((result) => ({ ok: true as const, result })),
				Effect.catchAll((error) =>
					Effect.succeed({ ok: false as const, error }),
				),
			);
			if (!blocked.ok) {
				items.push({
					query,
					ok: false,
					error:
						blocked.error instanceof Error
							? blocked.error.message
							: "block failed",
				});
				continue;
			}
			const { result } = blocked;
			if (!result.ok) {
				items.push({
					query,
					ok: false,
					error: result.transport.output || "block failed",
				});
				continue;
			}
			items.push({
				query,
				ok: true,
				blockedAt: result.blockedAt,
				handle: result.profile.handle,
			});
		}

		return {
			ok: items.every((item) => item.ok),
			accountId,
			path: filePath,
			requestedCount: queries.length,
			blockedCount: items.filter((item) => item.ok).length,
			failedCount: items.filter((item) => !item.ok).length,
			items,
		} satisfies BlocklistImportResult;
	});
}

export function importBlocklist(accountId: string, filePath: string) {
	return runEffectPromise(importBlocklistEffect(accountId, filePath));
}
