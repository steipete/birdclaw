import { readFile } from "node:fs/promises";
import type { Database } from "./sqlite";
import { ingestTweetPayload } from "./tweet-repository";
import type {
	XurlMedia,
	XurlMentionUser,
	XurlTweetData,
	XurlTweetsResponse,
} from "./types";

const TWEET_ID_PATTERN = /^\d{1,20}$/;
const X_USER_ID_PATTERN = /^[0-9]+$/;
const REFERENCED_TWEET_TYPES = new Set(["quoted", "replied_to", "retweeted"]);
const X_JSON_IMPORT_SOURCE = "x-json";
const PUBLIC_ACCOUNT_ID = "public";

export interface XJsonImportError {
	line: number;
	message: string;
}

export interface XJsonImportResult {
	imported: number;
	skipped: number;
	errors: XJsonImportError[];
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readStringField(
	record: JsonRecord,
	field: string,
	line: number,
	label: string,
): string | { error: string } {
	const value = record[field];
	if (typeof value !== "string" || value.trim().length === 0) {
		return {
			error: `Line ${String(line)}: ${label} must be a non-empty string`,
		};
	}
	return value.trim();
}

function normalizeTweetData(
	value: unknown,
	line: number,
): { tweet: XurlTweetData; sourceUrl?: string } | { error: string } {
	if (!isRecord(value)) {
		return { error: `Line ${String(line)}: each data tweet must be an object` };
	}
	const sourceUrl =
		typeof value.url === "string" && value.url.trim().length > 0
			? value.url.trim()
			: undefined;
	const { url: _ignored, ...rest } = value;
	const id = readStringField(rest, "id", line, "tweet.id");
	if (typeof id !== "string") return id;
	if (!TWEET_ID_PATTERN.test(id)) {
		return {
			error: `Line ${String(line)}: tweet id must be a numeric string (1-20 digits)`,
		};
	}
	const authorId = readStringField(rest, "author_id", line, "tweet.author_id");
	if (typeof authorId !== "string") return authorId;
	if (!X_USER_ID_PATTERN.test(authorId)) {
		return {
			error: `Line ${String(line)}: tweet.author_id must be a numeric string`,
		};
	}
	const referenced = normalizeReferencedTweets(rest, line);
	if ("error" in referenced) return referenced;
	const text = readStringField(rest, "text", line, "tweet.text");
	if (typeof text !== "string") return text;
	const createdAt = readStringField(
		rest,
		"created_at",
		line,
		"tweet.created_at",
	);
	if (typeof createdAt !== "string") return createdAt;
	if (Number.isNaN(Date.parse(createdAt))) {
		return {
			error: `Line ${String(line)}: tweet.created_at must be a valid timestamp`,
		};
	}
	return {
		tweet: rest as unknown as XurlTweetData,
		sourceUrl,
	};
}

function normalizeReferencedTweets(
	record: JsonRecord,
	line: number,
): { ok: true } | { error: string } {
	const value = record.referenced_tweets;
	if (value === undefined) return { ok: true };
	if (!Array.isArray(value)) {
		return {
			error: `Line ${String(line)}: tweet.referenced_tweets must be an array`,
		};
	}
	for (const entry of value) {
		if (!isRecord(entry)) {
			return {
				error: `Line ${String(line)}: tweet.referenced_tweets entries must be objects`,
			};
		}
		const type = entry.type;
		if (typeof type !== "string" || !REFERENCED_TWEET_TYPES.has(type)) {
			return {
				error: `Line ${String(line)}: tweet.referenced_tweets.type must be quoted, replied_to, or retweeted`,
			};
		}
		const refId = entry.id;
		if (typeof refId !== "string" || !TWEET_ID_PATTERN.test(refId.trim())) {
			return {
				error: `Line ${String(line)}: tweet.referenced_tweets.id must be a numeric string (1-20 digits)`,
			};
		}
	}
	return { ok: true };
}

function normalizeUser(
	value: unknown,
	line: number,
): XurlMentionUser | { error: string } {
	if (!isRecord(value)) {
		return {
			error: `Line ${String(line)}: includes.users entries must be objects`,
		};
	}
	const id = readStringField(value, "id", line, "user.id");
	if (typeof id !== "string") return id;
	if (!X_USER_ID_PATTERN.test(id)) {
		return {
			error: `Line ${String(line)}: user.id must be a numeric string`,
		};
	}
	const username = readStringField(value, "username", line, "user.username");
	if (typeof username !== "string") return username;
	const name = readStringField(value, "name", line, "user.name");
	if (typeof name !== "string") return name;
	return value as unknown as XurlMentionUser;
}

function normalizeIncludes(
	value: unknown,
	line: number,
): XurlTweetsResponse["includes"] | { error: string } | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) {
		return { error: `Line ${String(line)}: includes must be an object` };
	}
	const includes: XurlTweetsResponse["includes"] = {};
	if (value.users !== undefined) {
		if (!Array.isArray(value.users)) {
			return { error: `Line ${String(line)}: includes.users must be an array` };
		}
		const users: XurlMentionUser[] = [];
		for (const user of value.users) {
			const normalized = normalizeUser(user, line);
			if ("error" in normalized) return normalized;
			users.push(normalized);
		}
		includes.users = users;
	}
	if (value.tweets !== undefined) {
		if (!Array.isArray(value.tweets)) {
			return {
				error: `Line ${String(line)}: includes.tweets must be an array`,
			};
		}
		const tweets: XurlTweetData[] = [];
		for (const tweet of value.tweets) {
			const normalized = normalizeTweetData(tweet, line);
			if ("error" in normalized) return normalized;
			tweets.push(normalized.tweet);
		}
		includes.tweets = tweets;
	}
	if (value.media !== undefined) {
		if (!Array.isArray(value.media)) {
			return { error: `Line ${String(line)}: includes.media must be an array` };
		}
		for (const item of value.media) {
			if (!isRecord(item)) {
				return {
					error: `Line ${String(line)}: includes.media entries must be objects`,
				};
			}
			const mediaKey = readStringField(
				item,
				"media_key",
				line,
				"media.media_key",
			);
			if (typeof mediaKey !== "string") return mediaKey;
			const type = readStringField(item, "type", line, "media.type");
			if (typeof type !== "string") return type;
		}
		includes.media = value.media as XurlMedia[];
	}
	return includes;
}

function normalizeDocument(
	raw: unknown,
	line: number,
):
	| { payload: XurlTweetsResponse; sourceUrlByTweetId: Map<string, string> }
	| { error: string } {
	if (!isRecord(raw)) {
		return { error: `Line ${String(line)}: expected a JSON object` };
	}
	if (raw.data === undefined) {
		return { error: `Line ${String(line)}: missing data` };
	}
	const dataItems = Array.isArray(raw.data) ? raw.data : [raw.data];
	if (dataItems.length === 0) {
		return { error: `Line ${String(line)}: data must not be empty` };
	}
	const data: XurlTweetData[] = [];
	const sourceUrlByTweetId = new Map<string, string>();
	for (const item of dataItems) {
		const normalized = normalizeTweetData(item, line);
		if ("error" in normalized) return normalized;
		data.push(normalized.tweet);
		if (normalized.sourceUrl) {
			sourceUrlByTweetId.set(normalized.tweet.id, normalized.sourceUrl);
		}
	}
	const includes = normalizeIncludes(raw.includes, line);
	if (includes && "error" in includes) return includes;
	return {
		payload: {
			data,
			...(includes ? { includes } : {}),
			...(raw.meta && isRecord(raw.meta) ? { meta: raw.meta } : {}),
		},
		sourceUrlByTweetId,
	};
}

function splitInputDocuments(input: string): {
	documents: Array<{ line: number; raw: unknown }>;
	errors: XJsonImportError[];
} {
	if (!input.trim()) {
		throw new Error("import input is empty");
	}
	try {
		const parsed: unknown = JSON.parse(input.trim());
		if (isRecord(parsed)) {
			return { documents: [{ line: 1, raw: parsed }], errors: [] };
		}
	} catch {
		// Fall through to JSONL parsing.
	}
	const documents: Array<{ line: number; raw: unknown }> = [];
	const errors: XJsonImportError[] = [];
	let lineNumber = 0;
	for (const line of input.split(/\r?\n/u)) {
		lineNumber += 1;
		const slice = line.trim();
		if (!slice) continue;
		try {
			documents.push({ line: lineNumber, raw: JSON.parse(slice) as unknown });
		} catch {
			errors.push({
				line: lineNumber,
				message: `Line ${String(lineNumber)}: invalid JSON`,
			});
		}
	}
	if (documents.length === 0 && errors.length === 0) {
		throw new Error("import input is empty");
	}
	return { documents, errors };
}

function ensurePublicImportAccount(db: Database) {
	db.prepare(
		`insert or ignore into accounts (
      id, name, handle, transport, is_default, created_at
    ) values (?, 'Public imports', '@public', 'archive', 0, ?)`,
	).run(PUBLIC_ACCOUNT_ID, new Date().toISOString());
}

function tweetExists(db: Database, tweetId: string) {
	return Boolean(
		db.prepare("select 1 as ok from tweets where id = ?").get(tweetId),
	);
}

export function importXJsonText(
	db: Database,
	input: string,
): XJsonImportResult {
	const result: XJsonImportResult = { imported: 0, skipped: 0, errors: [] };
	let documents: Array<{ line: number; raw: unknown }>;
	try {
		const split = splitInputDocuments(input);
		documents = split.documents;
		result.errors.push(...split.errors);
	} catch (error) {
		result.errors.push({
			line: 1,
			message: error instanceof Error ? error.message : String(error),
		});
		return result;
	}

	ensurePublicImportAccount(db);

	for (const document of documents) {
		const normalized = normalizeDocument(document.raw, document.line);
		if ("error" in normalized) {
			result.errors.push({ line: document.line, message: normalized.error });
			continue;
		}
		const primaryIds = [
			...new Set(normalized.payload.data.map((tweet) => tweet.id)),
		];
		const existingCount = primaryIds.filter((id) => tweetExists(db, id)).length;
		const newCount = primaryIds.length - existingCount;
		result.skipped += existingCount;
		result.imported += newCount;

		db.transaction(() => {
			ingestTweetPayload(db, {
				accountId: PUBLIC_ACCOUNT_ID,
				payload: normalized.payload,
				source: X_JSON_IMPORT_SOURCE,
				edgeKind: "home",
				provenance: normalized.sourceUrlByTweetId.size
					? { sourceUrlByTweetId: normalized.sourceUrlByTweetId }
					: undefined,
			});
		})();
	}

	return result;
}

export async function readXJsonImportInput(path: string) {
	if (path === "-") {
		const chunks: Buffer[] = [];
		for await (const chunk of process.stdin) {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		}
		return Buffer.concat(chunks).toString("utf8");
	}
	return readFile(path, "utf8");
}

export async function importXJsonFromPath(
	db: Database,
	path: string,
): Promise<XJsonImportResult> {
	const input = await readXJsonImportInput(path);
	return importXJsonText(db, input);
}
