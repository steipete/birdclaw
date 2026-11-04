import { readFile } from "node:fs/promises";
import type { Database } from "./sqlite";
import { ingestTweetPayload } from "./tweet-repository";
import { buildExternalProfileId } from "./x-profile";
import type {
	XurlMedia,
	XurlMentionUser,
	XurlPublicMetrics,
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

type ImportFieldError = { error: string };

function isImportFieldError(value: unknown): value is ImportFieldError {
	return isRecord(value) && typeof value.error === "string";
}

function validationError(line: number, message: string): ImportFieldError {
	return { error: `Line ${String(line)}: ${message}` };
}

function validateNonEmptyString(
	value: unknown,
	line: number,
	label: string,
): true | ImportFieldError {
	if (typeof value !== "string" || value.trim().length === 0) {
		return validationError(line, `${label} must be a non-empty string`);
	}
	return true;
}

function validateTrimmedPattern(
	value: unknown,
	line: number,
	label: string,
	pattern: RegExp,
	invalidMessage: string,
): true | ImportFieldError {
	const check = validateNonEmptyString(value, line, label);
	if (check !== true) return check;
	if (!pattern.test(String(value).trim())) {
		return validationError(line, invalidMessage);
	}
	return true;
}

function validateOptionalNumericUserId(
	record: JsonRecord,
	field: string,
	line: number,
	label: string,
): true | ImportFieldError {
	const raw = record[field];
	if (raw === undefined) return true;
	return validateTrimmedPattern(
		raw,
		line,
		label,
		X_USER_ID_PATTERN,
		`${label} must be a numeric string`,
	);
}

const PUBLIC_METRIC_FIELDS = [
	"retweet_count",
	"reply_count",
	"like_count",
	"quote_count",
	"bookmark_count",
	"impression_count",
	"followers_count",
	"following_count",
	"tweet_count",
	"listed_count",
] as const satisfies ReadonlyArray<keyof XurlPublicMetrics>;

function validateMetricCount(
	record: JsonRecord,
	field: (typeof PUBLIC_METRIC_FIELDS)[number],
	line: number,
): true | ImportFieldError {
	const value = record[field];
	if (value === undefined) return true;
	if (typeof value === "number" && Number.isFinite(value)) {
		return true;
	}
	if (typeof value === "string" && value.trim().length > 0) {
		if (Number.isFinite(Number(value))) return true;
	}
	return validationError(
		line,
		`tweet.public_metrics.${field} must be a number`,
	);
}

function validateEntityArray(
	value: unknown,
	line: number,
	label: string,
): true | ImportFieldError {
	if (value === undefined) return true;
	if (!Array.isArray(value)) {
		return validationError(line, `${label} must be an array`);
	}
	for (const entry of value) {
		if (!isRecord(entry)) {
			return validationError(line, `${label} entries must be objects`);
		}
	}
	return true;
}

function validateEntities(
	value: unknown,
	line: number,
): true | ImportFieldError {
	if (value === undefined) return true;
	if (!isRecord(value)) {
		return validationError(line, "tweet.entities must be an object");
	}
	for (const result of [
		validateEntityArray(value.urls, line, "tweet.entities.urls"),
		validateEntityArray(value.mentions, line, "tweet.entities.mentions"),
		validateEntityArray(value.hashtags, line, "tweet.entities.hashtags"),
	]) {
		if (result !== true) return result;
	}
	if (value.article !== undefined && !isRecord(value.article)) {
		return validationError(line, "tweet.entities.article must be an object");
	}
	return true;
}

function validatePublicMetrics(
	value: unknown,
	line: number,
): true | ImportFieldError {
	if (value === undefined) return true;
	if (!isRecord(value)) {
		return validationError(line, "tweet.public_metrics must be an object");
	}
	for (const field of PUBLIC_METRIC_FIELDS) {
		const result = validateMetricCount(value, field, line);
		if (result !== true) return result;
	}
	return true;
}

function validateReferencedTweets(
	record: JsonRecord,
	line: number,
): true | ImportFieldError {
	const value = record.referenced_tweets;
	if (value === undefined) return true;
	if (!Array.isArray(value)) {
		return validationError(line, "tweet.referenced_tweets must be an array");
	}
	for (const entry of value) {
		if (!isRecord(entry)) {
			return validationError(
				line,
				"tweet.referenced_tweets entries must be objects",
			);
		}
		const type = entry.type;
		if (typeof type !== "string" || !REFERENCED_TWEET_TYPES.has(type)) {
			return validationError(
				line,
				"tweet.referenced_tweets.type must be quoted, replied_to, or retweeted",
			);
		}
		const refIdCheck = validateTrimmedPattern(
			entry.id,
			line,
			"tweet.referenced_tweets.id",
			TWEET_ID_PATTERN,
			"tweet.referenced_tweets.id must be a numeric string (1-20 digits)",
		);
		if (refIdCheck !== true) return refIdCheck;
	}
	return true;
}

function validateNoteTweet(
	value: unknown,
	line: number,
): true | ImportFieldError {
	if (value === undefined) return true;
	if (!isRecord(value)) {
		return validationError(line, "tweet.note_tweet must be an object");
	}
	return validateNonEmptyString(value.text, line, "tweet.note_tweet.text");
}

function validateAttachments(
	value: unknown,
	line: number,
): true | ImportFieldError {
	if (value === undefined) return true;
	if (!isRecord(value)) {
		return validationError(line, "tweet.attachments must be an object");
	}
	if (value.media_keys !== undefined) {
		if (!Array.isArray(value.media_keys)) {
			return validationError(
				line,
				"tweet.attachments.media_keys must be an array",
			);
		}
		for (const key of value.media_keys) {
			if (typeof key !== "string" || key.trim().length === 0) {
				return validationError(
					line,
					"tweet.attachments.media_keys entries must be non-empty strings",
				);
			}
		}
	}
	if (value.poll_ids !== undefined && !Array.isArray(value.poll_ids)) {
		return validationError(line, "tweet.attachments.poll_ids must be an array");
	}
	return true;
}

function validateMediaItem(
	item: JsonRecord,
	line: number,
): true | ImportFieldError {
	for (const result of [
		validateNonEmptyString(item.media_key, line, "media.media_key"),
		validateNonEmptyString(item.type, line, "media.type"),
	]) {
		if (result !== true) return result;
	}
	if (item.variants !== undefined && !Array.isArray(item.variants)) {
		return validationError(line, "media.variants must be an array");
	}
	return true;
}

function validateUser(value: unknown, line: number): true | ImportFieldError {
	if (!isRecord(value)) {
		return validationError(line, "includes.users entries must be objects");
	}
	for (const result of [
		validateTrimmedPattern(
			value.id,
			line,
			"user.id",
			X_USER_ID_PATTERN,
			"user.id must be a numeric string",
		),
		validateNonEmptyString(value.username, line, "user.username"),
		validateNonEmptyString(value.name, line, "user.name"),
	]) {
		if (result !== true) return result;
	}
	return true;
}

function forwardUser(record: JsonRecord): XurlMentionUser {
	return { ...record, id: String(record.id).trim() } as XurlMentionUser;
}

const SPARSE_INCLUDED_USER_KEYS = new Set(["id", "username", "name"]);

function isSparseIncludedUser(record: JsonRecord) {
	return Object.keys(record).every((key) => SPARSE_INCLUDED_USER_KEYS.has(key));
}

function forwardTweetFromRecord(record: JsonRecord): XurlTweetData {
	const { url: _ignored, ...rest } = record;
	const tweet = { ...rest } as unknown as XurlTweetData;
	tweet.id = String(record.id).trim();
	tweet.author_id = String(record.author_id).trim();
	if (Array.isArray(record.referenced_tweets)) {
		tweet.referenced_tweets = record.referenced_tweets.map((entry) => {
			if (!isRecord(entry)) return entry;
			return { ...entry, id: String(entry.id).trim() };
		}) as XurlTweetData["referenced_tweets"];
	}
	if (typeof record.in_reply_to_user_id === "string") {
		tweet.in_reply_to_user_id = record.in_reply_to_user_id.trim();
	}
	if (typeof record.conversation_id === "string") {
		tweet.conversation_id = record.conversation_id.trim();
	}
	return tweet;
}

function validateTweetRecord(
	record: JsonRecord,
	line: number,
): { sourceUrl?: string } | ImportFieldError {
	const sourceUrl =
		typeof record.url === "string" && record.url.trim().length > 0
			? record.url.trim()
			: undefined;
	const checks: Array<true | ImportFieldError> = [
		validateTrimmedPattern(
			record.id,
			line,
			"tweet.id",
			TWEET_ID_PATTERN,
			"tweet id must be a numeric string (1-20 digits)",
		),
		validateTrimmedPattern(
			record.author_id,
			line,
			"tweet.author_id",
			X_USER_ID_PATTERN,
			"tweet.author_id must be a numeric string",
		),
		validateReferencedTweets(record, line),
		validateNonEmptyString(record.text, line, "tweet.text"),
		validateNonEmptyString(record.created_at, line, "tweet.created_at"),
		validateNoteTweet(record.note_tweet, line),
		validateAttachments(record.attachments, line),
		validateOptionalNumericUserId(
			record,
			"in_reply_to_user_id",
			line,
			"tweet.in_reply_to_user_id",
		),
		validateOptionalNumericUserId(
			record,
			"conversation_id",
			line,
			"tweet.conversation_id",
		),
		validateEntities(record.entities, line),
		validatePublicMetrics(record.public_metrics, line),
	];
	for (const check of checks) {
		if (check !== true) return check;
	}
	if (Number.isNaN(Date.parse(String(record.created_at).trim()))) {
		return validationError(line, "tweet.created_at must be a valid timestamp");
	}
	return { sourceUrl };
}

function validateAndForwardIncludes(
	value: unknown,
	line: number,
): XurlTweetsResponse["includes"] | ImportFieldError | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) {
		return validationError(line, "includes must be an object");
	}
	const includes: XurlTweetsResponse["includes"] = {};
	if (value.users !== undefined) {
		if (!Array.isArray(value.users)) {
			return validationError(line, "includes.users must be an array");
		}
		const users: XurlMentionUser[] = [];
		for (const user of value.users) {
			const check = validateUser(user, line);
			if (check !== true) return check;
			users.push(forwardUser(user as JsonRecord));
		}
		includes.users = users;
	}
	if (value.tweets !== undefined) {
		if (!Array.isArray(value.tweets)) {
			return validationError(line, "includes.tweets must be an array");
		}
		const tweets: XurlTweetData[] = [];
		for (const tweet of value.tweets) {
			if (!isRecord(tweet)) {
				return validationError(line, "includes.tweets entries must be objects");
			}
			const validated = validateTweetRecord(tweet, line);
			if (isImportFieldError(validated)) return validated;
			tweets.push(forwardTweetFromRecord(tweet));
		}
		includes.tweets = tweets;
	}
	if (value.media !== undefined) {
		if (!Array.isArray(value.media)) {
			return validationError(line, "includes.media must be an array");
		}
		const mediaItems: XurlMedia[] = [];
		for (const item of value.media) {
			if (!isRecord(item)) {
				return validationError(line, "includes.media entries must be objects");
			}
			const check = validateMediaItem(item, line);
			if (check !== true) return check;
			mediaItems.push(item as unknown as XurlMedia);
		}
		includes.media = mediaItems;
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
		if (!isRecord(item)) {
			return {
				error: `Line ${String(line)}: each data tweet must be an object`,
			};
		}
		const validated = validateTweetRecord(item, line);
		if (isImportFieldError(validated)) return validated;
		const tweet = forwardTweetFromRecord(item);
		data.push(tweet);
		if (validated.sourceUrl) {
			sourceUrlByTweetId.set(tweet.id, validated.sourceUrl);
		}
	}
	const includes = validateAndForwardIncludes(raw.includes, line);
	if (isImportFieldError(includes)) return includes;
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

function profileExistsForXUser(db: Database, userId: string) {
	return Boolean(
		db
			.prepare("select 1 as ok from profiles where id = ?")
			.get(buildExternalProfileId(String(userId).trim())),
	);
}

function payloadForIngest(
	db: Database,
	payload: XurlTweetsResponse,
): XurlTweetsResponse {
	const users = payload.includes?.users;
	if (!users?.length) return payload;
	const filtered = users.filter((user) => {
		if (!isSparseIncludedUser(user as unknown as JsonRecord)) return true;
		return !profileExistsForXUser(db, user.id);
	});
	if (filtered.length === users.length) return payload;
	const includes = { ...payload.includes };
	if (filtered.length > 0) {
		includes.users = filtered;
	} else {
		delete includes.users;
	}
	return { ...payload, includes };
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
		try {
			db.transaction(() => {
				ingestTweetPayload(db, {
					accountId: PUBLIC_ACCOUNT_ID,
					payload: payloadForIngest(db, normalized.payload),
					source: X_JSON_IMPORT_SOURCE,
					provenance: normalized.sourceUrlByTweetId.size
						? { sourceUrlByTweetId: normalized.sourceUrlByTweetId }
						: undefined,
				});
			})();
			result.skipped += existingCount;
			result.imported += newCount;
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			result.errors.push({
				line: document.line,
				message: `Line ${String(document.line)}: ${detail}`,
			});
		}
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
