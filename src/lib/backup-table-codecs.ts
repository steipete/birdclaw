import { safeHttpUrl } from "./url-safety";

export type BackupJsonValue =
	| null
	| boolean
	| number
	| string
	| BackupJsonValue[]
	| { [key: string]: BackupJsonValue };

export type BackupJsonRecord = Record<string, BackupJsonValue>;

export interface BackupMergeCodec {
	order: number;
	sql: string;
	columns: readonly string[];
	transform?: (rows: BackupJsonRecord[]) => BackupJsonRecord[];
	searchKind?: "tweet" | "dm";
}

export interface BackupTableCodecDefinition {
	exportSql: string;
	shardPath(row: BackupJsonRecord): string;
	matchesPath(relativePath: string): boolean;
	countKey(relativePath: string): string;
	merge: BackupMergeCodec;
}

export interface BackupTableCodec<
	Name extends string = string,
> extends BackupTableCodecDefinition {
	name: Name;
}

const BACKUP_SHARD_PART_PATTERN = /\.part-\d{4,}\.jsonl$/u;

export function logicalBackupShardPath(relativePath: string) {
	return relativePath.replace(BACKUP_SHARD_PART_PATTERN, ".jsonl");
}

function fixedShard(relativePath: string, countKey: string) {
	return {
		shardPath: () => relativePath,
		matchesPath: (candidate: string) => candidate === relativePath,
		countKey: () => countKey,
	};
}

function yearFromTimestamp(value: BackupJsonValue | undefined) {
	if (typeof value !== "string") return "unknown";
	const match = /^(\d{4})/.exec(value);
	return !match?.[1] || match[1] === "1970" ? "unknown" : match[1];
}

function pathLeaf(relativePath: string) {
	return relativePath.split("/").at(-1) ?? "";
}

const JSON_URL_KEYS = new Set([
	"url",
	"expandedUrl",
	"expanded_url",
	"imageUrl",
	"image_url",
	"mediaUrl",
	"media_url",
	"media_url_https",
	"thumbnailUrl",
	"thumbnail_url",
	"previewImageUrl",
	"preview_image_url",
]);

function sanitizeJsonUrls(value: BackupJsonValue, key = ""): BackupJsonValue {
	if (Array.isArray(value)) return value.map((item) => sanitizeJsonUrls(item));
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([entryKey, entryValue]) => [
				entryKey,
				sanitizeJsonUrls(entryValue, entryKey),
			]),
		);
	}
	if (!JSON_URL_KEYS.has(key) || typeof value !== "string" || !value) {
		return value;
	}
	return safeHttpUrl(value) ?? "";
}

function sanitizeJsonTextUrls(
	value: BackupJsonValue | undefined,
	fallback: BackupJsonValue,
): BackupJsonValue {
	if (value === undefined) return null;
	if (typeof value !== "string" || value.length === 0) return value;
	try {
		return JSON.stringify(
			sanitizeJsonUrls(JSON.parse(value) as BackupJsonValue),
		);
	} catch {
		return JSON.stringify(fallback);
	}
}

function sanitizeImportedTweets(rows: BackupJsonRecord[]) {
	return rows.map((row) => {
		const entitiesJson = sanitizeJsonTextUrls(row.entities_json, {});
		const noteTweetJson = sanitizeJsonTextUrls(row.note_tweet_json, {});
		const noteTweet =
			typeof noteTweetJson === "string"
				? (JSON.parse(noteTweetJson) as BackupJsonRecord)
				: undefined;
		const hasNoteTweet = typeof noteTweet?.text === "string";
		return {
			...row,
			text: hasNoteTweet ? noteTweet.text : row.text,
			entities_json: hasNoteTweet
				? JSON.stringify(noteTweet.entities ?? {})
				: entitiesJson,
			note_tweet_json: hasNoteTweet ? noteTweetJson : null,
			media_json: sanitizeJsonTextUrls(row.media_json, []),
		};
	});
}

function sanitizeImportedTweetRevisions(rows: BackupJsonRecord[]) {
	return rows.map((row) => ({
		...row,
		payload_json:
			row.payload_json === null || row.payload_json === undefined
				? null
				: sanitizeJsonTextUrls(row.payload_json, {}),
	}));
}

function preserveSafeHttpUrl(value: BackupJsonValue | undefined) {
	if (typeof value !== "string") return null;
	return safeHttpUrl(value) ? value : null;
}

function sanitizeImportedUrlExpansions(rows: BackupJsonRecord[]) {
	return rows.map((row) => {
		const shortUrl = preserveSafeHttpUrl(row.short_url);
		const expandedUrl = preserveSafeHttpUrl(row.expanded_url);
		const finalUrl = preserveSafeHttpUrl(row.final_url);
		const safe = Boolean(shortUrl || expandedUrl || finalUrl);
		return {
			...row,
			short_url: shortUrl ?? "",
			expanded_url: expandedUrl ?? shortUrl ?? "",
			final_url: finalUrl ?? expandedUrl ?? shortUrl ?? "",
			status: safe ? row.status : "error",
			error: safe ? row.error : "unsafe URL stripped from backup import",
			image_url:
				typeof row.image_url === "string"
					? (preserveSafeHttpUrl(row.image_url) ?? "")
					: row.image_url,
		};
	});
}

type MergeExpression =
	| string
	| ((table: string, column: string) => string)
	| null;

const incoming = (_table: string, column: string) => `excluded.${column}`;
const incomingNonNull = (table: string, column: string) =>
	`coalesce(excluded.${column}, ${table}.${column})`;
const incomingNonEmpty = (table: string, column: string) =>
	`coalesce(nullif(excluded.${column}, ''), ${table}.${column})`;
const maximum = (table: string, column: string) =>
	`max(${table}.${column}, excluded.${column})`;
const minimum = (table: string, column: string) =>
	`min(${table}.${column}, excluded.${column})`;
const newest = (table: string, column: string) =>
	`case when excluded.updated_at >= ${table}.updated_at then excluded.${column} else ${table}.${column} end`;

type BackupTableSpec = Omit<
	BackupTableCodecDefinition,
	"exportSql" | "merge"
> & {
	columns: Record<string, MergeExpression>;
	exportColumns?: readonly string[];
	orderBy: string;
	merge: Omit<BackupMergeCodec, "sql" | "columns"> & {
		values?: Record<string, string>;
		conflictKey: string;
	};
};

function defineTable(
	name: string,
	spec: BackupTableSpec,
): BackupTableCodecDefinition {
	const {
		columns: expressions,
		exportColumns,
		orderBy,
		merge,
		...shards
	} = spec;
	const columns = Object.keys(expressions);
	const { values = {}, conflictKey, ...mergeOptions } = merge;
	const updates = Object.entries(expressions).flatMap(([column, expression]) =>
		expression === null
			? []
			: [
					`${column} = ${typeof expression === "function" ? expression(name, column) : expression}`,
				],
	);
	const conflict = `on conflict${conflictKey} do ${updates.length ? "update set " + updates.join(", ") : "nothing"}`;
	return {
		...shards,
		exportSql: `select ${(exportColumns ?? columns).join(", ")} from ${name} order by ${orderBy}`,
		merge: {
			...mergeOptions,
			columns,
			sql: `insert into ${name} (${columns.join(", ")}) values (${columns.map((column) => values[column] ?? "?").join(", ")}) ${conflict}`,
		},
	};
}

const definitions = {
	accounts: defineTable("accounts", {
		columns: {
			id: null,
			name: incomingNonEmpty,
			handle: incomingNonEmpty,
			external_user_id: incomingNonNull,
			transport: incomingNonEmpty,
			is_default: maximum,
			created_at: minimum,
		},
		orderBy: "id",
		...fixedShard("data/accounts.jsonl", "accounts"),
		merge: {
			order: 0,
			conflictKey: "(id)",
		},
	}),
	profiles: defineTable("profiles", {
		columns: {
			id: null,
			handle: incomingNonEmpty,
			display_name: incomingNonEmpty,
			bio: incomingNonEmpty,
			followers_count: maximum,
			following_count: maximum,
			public_metrics_json: `case
          when excluded.public_metrics_json not in ('', '{}', 'null') then excluded.public_metrics_json
          else profiles.public_metrics_json
        end`,
			avatar_hue: `case when profiles.avatar_hue = 0 then excluded.avatar_hue else profiles.avatar_hue end`,
			avatar_url: incomingNonNull,
			location: incomingNonNull,
			url: incomingNonNull,
			verified_type: incomingNonNull,
			entities_json: `case
          when excluded.entities_json not in ('', '{}', 'null') then excluded.entities_json
          else profiles.entities_json
        end`,
			raw_json: `case
          when excluded.raw_json not in ('', '{}', 'null') then excluded.raw_json
          else profiles.raw_json
        end`,
			created_at: minimum,
		},
		orderBy: "id",
		...fixedShard("data/profiles.jsonl", "profiles"),
		merge: {
			order: 1,
			values: {
				following_count: "coalesce(?, 0)",
				public_metrics_json: "coalesce(?, '{}')",
				entities_json: "coalesce(?, '{}')",
				raw_json: "coalesce(?, '{}')",
			},
			conflictKey: "(id)",
		},
	}),
	profile_affiliations: defineTable("profile_affiliations", {
		columns: {
			subject_profile_id: null,
			organization_profile_id: null,
			organization_name: `coalesce(nullif(case when excluded.updated_at > profile_affiliations.updated_at then excluded.organization_name else profile_affiliations.organization_name end, ''), profile_affiliations.organization_name, excluded.organization_name)`,
			organization_handle: `coalesce(nullif(case when excluded.updated_at > profile_affiliations.updated_at then excluded.organization_handle else profile_affiliations.organization_handle end, ''), profile_affiliations.organization_handle, excluded.organization_handle)`,
			badge_url: `coalesce(nullif(case when excluded.updated_at > profile_affiliations.updated_at then excluded.badge_url else profile_affiliations.badge_url end, ''), profile_affiliations.badge_url, excluded.badge_url)`,
			url: `coalesce(nullif(case when excluded.updated_at > profile_affiliations.updated_at then excluded.url else profile_affiliations.url end, ''), profile_affiliations.url, excluded.url)`,
			label: `coalesce(nullif(case when excluded.updated_at > profile_affiliations.updated_at then excluded.label else profile_affiliations.label end, ''), profile_affiliations.label, excluded.label)`,
			source: `coalesce(nullif(case when excluded.updated_at > profile_affiliations.updated_at then excluded.source else profile_affiliations.source end, ''), profile_affiliations.source, excluded.source)`,
			is_active: `case when excluded.updated_at > profile_affiliations.updated_at then excluded.is_active else profile_affiliations.is_active end`,
			first_seen_at: minimum,
			last_seen_at: maximum,
			raw_json: `coalesce(nullif(case when excluded.updated_at > profile_affiliations.updated_at then excluded.raw_json else profile_affiliations.raw_json end, '{}'), nullif(profile_affiliations.raw_json, '{}'), nullif(excluded.raw_json, '{}'), '{}')`,
			updated_at: maximum,
		},
		orderBy: "subject_profile_id, organization_profile_id",
		...fixedShard("data/profile_affiliations.jsonl", "profile_affiliations"),
		merge: {
			order: 4,
			values: {
				source: "coalesce(?, 'backup')",
				is_active: "coalesce(?, 1)",
				raw_json: "coalesce(?, '{}')",
			},
			conflictKey: "(subject_profile_id, organization_profile_id)",
		},
	}),
	profile_snapshots: defineTable("profile_snapshots", {
		columns: {
			profile_id: null,
			snapshot_hash: null,
			observed_at: minimum,
			last_seen_at: maximum,
			source: `case
          when excluded.last_seen_at > profile_snapshots.last_seen_at
            or (excluded.last_seen_at = profile_snapshots.last_seen_at
              and (excluded.source || char(0) || excluded.raw_json) >
                (profile_snapshots.source || char(0) || profile_snapshots.raw_json))
          then excluded.source else profile_snapshots.source end`,
			handle: null,
			display_name: null,
			bio: null,
			location: null,
			url: null,
			verified_type: null,
			followers_count: null,
			following_count: null,
			affiliations_json: null,
			raw_json: `case
          when excluded.last_seen_at > profile_snapshots.last_seen_at
            or (excluded.last_seen_at = profile_snapshots.last_seen_at
              and (excluded.source || char(0) || excluded.raw_json) >
                (profile_snapshots.source || char(0) || profile_snapshots.raw_json))
          then excluded.raw_json else profile_snapshots.raw_json end`,
		},
		orderBy: "profile_id, last_seen_at, snapshot_hash",
		...fixedShard("data/profile_snapshots.jsonl", "profile_snapshots"),
		merge: {
			order: 2,
			values: {
				source: "coalesce(?, 'backup')",
				followers_count: "coalesce(?, 0)",
				following_count: "coalesce(?, 0)",
				affiliations_json: "coalesce(?, '[]')",
				raw_json: "coalesce(?, '{}')",
			},
			conflictKey: "(profile_id, snapshot_hash)",
		},
	}),
	profile_bio_entities: defineTable("profile_bio_entities", {
		columns: {
			profile_id: null,
			kind: null,
			value: null,
			source: `coalesce(nullif(case when excluded.last_seen_at > profile_bio_entities.last_seen_at then excluded.source else profile_bio_entities.source end, ''), profile_bio_entities.source, excluded.source)`,
			is_active: `case when excluded.last_seen_at > profile_bio_entities.last_seen_at then excluded.is_active else profile_bio_entities.is_active end`,
			first_seen_at: minimum,
			last_seen_at: maximum,
			raw_json: `coalesce(nullif(case when excluded.last_seen_at > profile_bio_entities.last_seen_at then excluded.raw_json else profile_bio_entities.raw_json end, '{}'), nullif(profile_bio_entities.raw_json, '{}'), nullif(excluded.raw_json, '{}'), '{}')`,
		},
		orderBy: "profile_id, kind, value",
		...fixedShard("data/profile_bio_entities.jsonl", "profile_bio_entities"),
		merge: {
			order: 3,
			values: {
				source: "coalesce(?, 'backup')",
				is_active: "coalesce(?, 1)",
				raw_json: "coalesce(?, '{}')",
			},
			conflictKey: "(profile_id, kind, value)",
		},
	}),
	x_lists: defineTable("x_lists", {
		columns: {
			account_id: null,
			list_id: null,
			name: incoming,
			description: incoming,
			owner_profile_id: incomingNonNull,
			owner_external_user_id: incomingNonNull,
			is_private: newest,
			member_count: incomingNonNull,
			follower_count: incomingNonNull,
			source: newest,
			membership_status: newest,
			lists_synced_at: maximum,
			members_synced_at: `nullif(max(coalesce(x_lists.members_synced_at, ''), coalesce(excluded.members_synced_at, '')), '')`,
			member_page_count: newest,
			member_result_count: newest,
			rate_limit_json: newest,
			raw_json: newest,
			updated_at: maximum,
		},
		orderBy: "account_id, name collate nocase, list_id",
		...fixedShard("data/lists/lists.jsonl", "x_lists"),
		merge: {
			order: 9,
			conflictKey: "(account_id, list_id)",
		},
	}),
	x_list_members: defineTable("x_list_members", {
		columns: {
			account_id: null,
			list_id: null,
			profile_id: null,
			external_user_id: incomingNonEmpty,
			source: newest,
			current: newest,
			first_seen_at: minimum,
			last_seen_at: maximum,
			ended_at: newest,
			raw_json: newest,
			updated_at: maximum,
		},
		orderBy: "account_id, list_id, profile_id",
		...fixedShard("data/lists/members.jsonl", "x_list_members"),
		merge: {
			order: 10,
			conflictKey: "(account_id, list_id, profile_id)",
		},
	}),
	tweets: defineTable("tweets", {
		columns: {
			id: null,
			author_profile_id: incomingNonEmpty,
			text: `case
		  when excluded.note_tweet_json is not null then excluded.text
		  when tweets.note_tweet_json is not null then tweets.text
		  else coalesce(nullif(excluded.text, ''), tweets.text)
		end`,
			created_at: minimum,
			is_replied: maximum,
			reply_to_id: incomingNonNull,
			like_count: maximum,
			media_count: maximum,
			entities_json: `case
		  when excluded.note_tweet_json is not null then excluded.entities_json
		  when tweets.note_tweet_json is not null then tweets.entities_json
		  when excluded.entities_json not in ('', '{}', 'null') then excluded.entities_json
		  else tweets.entities_json
		end`,
			note_tweet_json: incomingNonNull,
			media_json: `case
          when excluded.media_json not in ('', '[]', 'null') then excluded.media_json
          else tweets.media_json
        end`,
			quoted_tweet_id: incomingNonNull,
			deleted_at: `case
		  when tweets.deleted_at is null then excluded.deleted_at
		  when excluded.deleted_at is null then tweets.deleted_at
		  else min(tweets.deleted_at, excluded.deleted_at)
		end`,
			deletion_source: `case
		  when excluded.deleted_at is not null
		    and (tweets.deleted_at is null or excluded.deleted_at < tweets.deleted_at)
		    then excluded.deletion_source
		  when excluded.deleted_at = tweets.deleted_at
		    then coalesce(tweets.deletion_source, excluded.deletion_source)
		  else tweets.deletion_source
		end`,
			deletion_reason: `case
		  when excluded.deleted_at is not null
		    and (tweets.deleted_at is null or excluded.deleted_at < tweets.deleted_at)
		    then excluded.deletion_reason
		  when excluded.deleted_at = tweets.deleted_at
		    then coalesce(tweets.deletion_reason, excluded.deletion_reason)
		  else tweets.deletion_reason
		end`,
			superseded_at: `case
		  when tweets.superseded_at is null then excluded.superseded_at
		  when excluded.superseded_at is null then tweets.superseded_at
		  else min(tweets.superseded_at, excluded.superseded_at)
		end`,
			superseded_by_id: incomingNonNull,
		},
		orderBy: "created_at, id",
		shardPath: (row) =>
			`data/tweets/${yearFromTimestamp(row.created_at)}.jsonl`,
		matchesPath: (candidate) => candidate.startsWith("data/tweets/"),
		countKey: () => "tweets",
		merge: {
			order: 11,
			transform: sanitizeImportedTweets,
			searchKind: "tweet",
			conflictKey: "(id)",
		},
	}),
	tweet_revisions: defineTable("tweet_revisions", {
		columns: {
			root_tweet_id: `case
          when tweet_revisions.root_tweet_id = tweet_revisions.revision_id
            and excluded.root_tweet_id <> excluded.revision_id
            then excluded.root_tweet_id
          else tweet_revisions.root_tweet_id
        end`,
			revision_id: null,
			revision_index: `case
          when tweet_revisions.root_tweet_id = tweet_revisions.revision_id
            and excluded.root_tweet_id <> excluded.revision_id
            then excluded.revision_index
          else tweet_revisions.revision_index
        end`,
			payload_json: `coalesce(tweet_revisions.payload_json, excluded.payload_json)`,
			source: `case
          when tweet_revisions.payload_json is null and excluded.payload_json is not null
            then excluded.source
          else tweet_revisions.source
        end`,
			observed_at: maximum,
		},
		orderBy: "root_tweet_id, revision_index, revision_id",
		...fixedShard("data/tweet_revisions.jsonl", "tweet_revisions"),
		merge: {
			order: 12,
			transform: sanitizeImportedTweetRevisions,
			conflictKey: "(revision_id)",
		},
	}),
	tweet_revision_edges: defineTable("tweet_revision_edges", {
		columns: {
			older_revision_id: null,
			newer_revision_id: null,
			source: `case
          when excluded.observed_at > tweet_revision_edges.observed_at
            then excluded.source
          when excluded.observed_at = tweet_revision_edges.observed_at then case
            when tweet_revision_edges.source in ('backup_migration', 'migration')
              and excluded.source not in ('backup_migration', 'migration')
              then excluded.source
            when excluded.source in ('backup_migration', 'migration')
              and tweet_revision_edges.source not in ('backup_migration', 'migration')
              then tweet_revision_edges.source
            else min(tweet_revision_edges.source, excluded.source)
          end
          else tweet_revision_edges.source
        end`,
			observed_at: maximum,
		},
		orderBy: "older_revision_id, newer_revision_id",
		...fixedShard("data/tweet_revision_edges.jsonl", "tweet_revision_edges"),
		merge: {
			order: 13,
			conflictKey: "(older_revision_id, newer_revision_id)",
		},
	}),
	tweet_subordinate_tombstones: defineTable("tweet_subordinate_tombstones", {
		columns: {
			tweet_id: null,
			kind: null,
			subordinate_id: null,
			deleted_at: minimum,
			deletion_source: `case
		  when excluded.deleted_at < tweet_subordinate_tombstones.deleted_at
		    then excluded.deletion_source
		  when excluded.deleted_at = tweet_subordinate_tombstones.deleted_at
		    then coalesce(tweet_subordinate_tombstones.deletion_source, excluded.deletion_source)
		  else tweet_subordinate_tombstones.deletion_source
		end`,
			deletion_reason: `case
		  when excluded.deleted_at < tweet_subordinate_tombstones.deleted_at
		    then excluded.deletion_reason
		  when excluded.deleted_at = tweet_subordinate_tombstones.deleted_at
		    then coalesce(tweet_subordinate_tombstones.deletion_reason, excluded.deletion_reason)
		  else tweet_subordinate_tombstones.deletion_reason
		end`,
		},
		orderBy: "tweet_id, kind, subordinate_id",
		...fixedShard(
			"data/tweet_subordinate_tombstones.jsonl",
			"tweet_subordinate_tombstones",
		),
		merge: {
			order: 14,
			conflictKey: "(tweet_id, kind, subordinate_id)",
		},
	}),
	tweet_sources: defineTable("tweet_sources", {
		columns: {
			tweet_id: null,
			source: null,
			source_url: `case
          when excluded.observed_at >= tweet_sources.observed_at then excluded.source_url
          else tweet_sources.source_url
        end`,
			observed_at: maximum,
		},
		orderBy: "tweet_id, source",
		...fixedShard("data/tweet_sources.jsonl", "tweet_sources"),
		merge: {
			order: 15,
			conflictKey: "(tweet_id, source)",
		},
	}),
	fxtwitter_fetches: defineTable("fxtwitter_fetches", {
		columns: {
			id: null,
			endpoint_family: null,
			request_key: null,
			source_url: null,
			retrieved_at: null,
			collection_state: null,
			partial_reasons_json: null,
			pages_fetched: null,
			items_observed: null,
			terminal_cursor: null,
			next_cursor: null,
			upstream_count: null,
			failure_json: null,
		},
		orderBy: "retrieved_at, id",
		...fixedShard("data/fxtwitter/fetches.jsonl", "fxtwitter_fetches"),
		merge: {
			order: 26,
			conflictKey: "(id)",
		},
	}),
	fxtwitter_observations: defineTable("fxtwitter_observations", {
		columns: {
			endpoint_family: null,
			request_key: null,
			item_kind: null,
			item_id: null,
			source_url: `case
          when excluded.last_seen_at >= fxtwitter_observations.last_seen_at
            then excluded.source_url
          else fxtwitter_observations.source_url
        end`,
			first_seen_at: minimum,
			last_seen_at: maximum,
			seen_count: maximum,
			last_fetch_id: `case
          when excluded.last_seen_at >= fxtwitter_observations.last_seen_at
            then excluded.last_fetch_id
          else fxtwitter_observations.last_fetch_id
        end`,
		},
		orderBy: "endpoint_family, request_key, item_kind, item_id",
		...fixedShard(
			"data/fxtwitter/observations.jsonl",
			"fxtwitter_observations",
		),
		merge: {
			order: 27,
			conflictKey: "(endpoint_family, request_key, item_kind, item_id)",
		},
	}),
	tweet_collections: defineTable("tweet_collections", {
		columns: {
			account_id: null,
			tweet_id: null,
			kind: null,
			collected_at: `coalesce(tweet_collections.collected_at, excluded.collected_at)`,
			source: incomingNonEmpty,
			raw_json: `case
          when excluded.raw_json not in ('', '{}', 'null') then excluded.raw_json
          else tweet_collections.raw_json
        end`,
			updated_at: maximum,
		},
		orderBy: "kind, account_id, coalesce(collected_at, ''), tweet_id",
		shardPath: (row) => {
			const kind =
				row.kind === "likes" || row.kind === "bookmarks" ? row.kind : "unknown";
			return `data/collections/${kind}.jsonl`;
		},
		matchesPath: (candidate) => candidate.startsWith("data/collections/"),
		countKey: (candidate) =>
			`collections_${pathLeaf(candidate).replace(/\.jsonl$/, "") || "unknown"}`,
		merge: {
			order: 16,
			conflictKey: "(account_id, tweet_id, kind)",
		},
	}),
	tweet_account_edges: defineTable("tweet_account_edges", {
		columns: {
			account_id: null,
			tweet_id: null,
			kind: null,
			first_seen_at: minimum,
			last_seen_at: maximum,
			seen_count: maximum,
			source: incomingNonEmpty,
			raw_json: `case
          when excluded.raw_json not in ('', '{}', 'null') then excluded.raw_json
          else tweet_account_edges.raw_json
        end`,
			updated_at: maximum,
		},
		orderBy: "kind, account_id, last_seen_at, tweet_id",
		shardPath: (row) => {
			const kind =
				row.kind === "home" ||
				row.kind === "mention" ||
				row.kind === "authored" ||
				row.kind === "search"
					? row.kind
					: "unknown";
			return `data/timeline_edges/${kind}.jsonl`;
		},
		matchesPath: (candidate) => candidate.startsWith("data/timeline_edges/"),
		countKey: (candidate) =>
			`timeline_edges_${pathLeaf(candidate).replace(/\.jsonl$/, "") || "unknown"}`,
		merge: {
			order: 17,
			values: {
				seen_count: "coalesce(?, 1)",
				source: "coalesce(?, 'backup')",
				raw_json: "coalesce(?, '{}')",
			},
			conflictKey: "(account_id, tweet_id, kind)",
		},
	}),
	dm_conversations: defineTable("dm_conversations", {
		columns: {
			id: null,
			account_id: incomingNonEmpty,
			participant_profile_id: incomingNonEmpty,
			title: incomingNonEmpty,
			inbox_kind: `case
          when excluded.last_message_at > dm_conversations.last_message_at
            then coalesce(nullif(excluded.inbox_kind, ''), dm_conversations.inbox_kind)
          else dm_conversations.inbox_kind
        end`,
			last_message_at: maximum,
			unread_count: maximum,
			needs_reply: maximum,
		},
		orderBy: "last_message_at, id",
		...fixedShard("data/dms/conversations.jsonl", "dm_conversations"),
		merge: {
			order: 18,
			values: { inbox_kind: "coalesce(?, 'accepted')" },
			conflictKey: "(id)",
		},
	}),
	dm_messages: defineTable("dm_messages", {
		columns: {
			id: null,
			conversation_id: incomingNonEmpty,
			sender_profile_id: incomingNonEmpty,
			text: incomingNonEmpty,
			created_at: minimum,
			direction: incomingNonEmpty,
			is_replied: maximum,
			media_count: maximum,
		},
		orderBy: "conversation_id, created_at, id",
		shardPath: (row) => `data/dms/${yearFromTimestamp(row.created_at)}.jsonl`,
		matchesPath: (candidate) =>
			candidate.startsWith("data/dms/") &&
			candidate !== "data/dms/conversations.jsonl",
		countKey: () => "dm_messages",
		merge: {
			order: 19,
			searchKind: "dm",
			conflictKey: "(id)",
		},
	}),
	url_expansions: defineTable("url_expansions", {
		columns: {
			short_url: null,
			expanded_url: incoming,
			final_url: incoming,
			status: incoming,
			expanded_tweet_id: incoming,
			expanded_handle: incoming,
			title: incoming,
			description: incoming,
			image_url: incoming,
			site_name: incoming,
			error: incoming,
			source: incoming,
			updated_at: incoming,
		},
		orderBy: "short_url",
		...fixedShard("data/links/url_expansions.jsonl", "url_expansions"),
		merge: {
			order: 20,
			transform: sanitizeImportedUrlExpansions,
			conflictKey: "(short_url)",
		},
	}),
	link_occurrences: defineTable("link_occurrences", {
		columns: {
			source_kind: null,
			source_id: null,
			source_position: null,
			short_url: null,
			account_id: incoming,
			conversation_id: incoming,
			direction: incoming,
			created_at: incoming,
		},
		orderBy: "source_kind, source_id, source_position, short_url",
		...fixedShard("data/links/occurrences.jsonl", "link_occurrences"),
		merge: {
			order: 21,
			conflictKey: "(source_kind, source_id, source_position, short_url)",
		},
	}),
	blocks: defineTable("blocks", {
		columns: {
			account_id: null,
			profile_id: null,
			source: incomingNonEmpty,
			created_at: minimum,
		},
		orderBy: "account_id, profile_id",
		...fixedShard("data/moderation/blocks.jsonl", "blocks"),
		merge: {
			order: 22,
			conflictKey: "(account_id, profile_id)",
		},
	}),
	mutes: defineTable("mutes", {
		columns: {
			account_id: null,
			profile_id: null,
			source: incomingNonEmpty,
			created_at: minimum,
		},
		orderBy: "account_id, profile_id",
		...fixedShard("data/moderation/mutes.jsonl", "mutes"),
		merge: {
			order: 23,
			conflictKey: "(account_id, profile_id)",
		},
	}),
	tweet_actions: defineTable("tweet_actions", {
		columns: {
			id: null,
			account_id: incomingNonEmpty,
			tweet_id: incomingNonNull,
			kind: incomingNonEmpty,
			body: incomingNonEmpty,
			created_at: minimum,
		},
		orderBy: "created_at, id",
		...fixedShard("data/actions/tweet_actions.jsonl", "tweet_actions"),
		merge: {
			order: 24,
			conflictKey: "(id)",
		},
	}),
	ai_scores: defineTable("ai_scores", {
		columns: {
			entity_kind: null,
			entity_id: null,
			model: incomingNonEmpty,
			score: maximum,
			summary: incomingNonEmpty,
			reasoning: incomingNonEmpty,
			updated_at: maximum,
		},
		orderBy: "entity_kind, entity_id, model",
		...fixedShard("data/ai_scores.jsonl", "ai_scores"),
		merge: {
			order: 25,
			conflictKey: "(entity_kind, entity_id)",
		},
	}),
	follow_snapshots: defineTable("follow_snapshots", {
		columns: {
			id: null,
			account_id: incomingNonEmpty,
			direction: incomingNonEmpty,
			source: incomingNonEmpty,
			status: incomingNonEmpty,
			page_count: maximum,
			result_count: maximum,
			started_at: minimum,
			completed_at: maximum,
			raw_meta_json: `case
          when excluded.raw_meta_json not in ('', '{}', 'null') then excluded.raw_meta_json
          else follow_snapshots.raw_meta_json
        end`,
		},
		orderBy: "account_id, direction, completed_at, id",
		...fixedShard("data/follow_snapshots.jsonl", "follow_snapshots"),
		merge: {
			order: 5,
			values: {
				source: "coalesce(?, 'backup')",
				page_count: "coalesce(?, 0)",
				result_count: "coalesce(?, 0)",
				raw_meta_json: "coalesce(?, '{}')",
			},
			conflictKey: "(id)",
		},
	}),
	follow_snapshot_members: defineTable("follow_snapshot_members", {
		columns: {
			snapshot_id: null,
			profile_id: null,
			external_user_id: incomingNonEmpty,
			position: incoming,
		},
		orderBy: "snapshot_id, position, profile_id",
		...fixedShard(
			"data/follow_snapshot_members.jsonl",
			"follow_snapshot_members",
		),
		merge: {
			order: 6,
			values: { position: "coalesce(?, 0)" },
			conflictKey: "(snapshot_id, profile_id)",
		},
	}),
	follow_edges: defineTable("follow_edges", {
		columns: {
			account_id: null,
			direction: null,
			profile_id: null,
			external_user_id: incomingNonEmpty,
			source: incomingNonEmpty,
			current: newest,
			first_seen_at: minimum,
			last_seen_at: maximum,
			ended_at: newest,
			updated_at: maximum,
		},
		orderBy: "account_id, direction, profile_id",
		...fixedShard("data/follow_edges.jsonl", "follow_edges"),
		merge: {
			order: 7,
			values: { source: "coalesce(?, 'backup')", current: "coalesce(?, 1)" },
			conflictKey: "(account_id, direction, profile_id)",
		},
	}),
	follow_events: defineTable("follow_events", {
		columns: {
			id: null,
			account_id: incomingNonEmpty,
			direction: incomingNonEmpty,
			profile_id: incomingNonEmpty,
			external_user_id: incomingNonEmpty,
			kind: incomingNonEmpty,
			event_at: incomingNonEmpty,
			snapshot_id: incomingNonEmpty,
		},
		orderBy: "account_id, direction, event_at, kind, profile_id, id",
		...fixedShard("data/follow_events.jsonl", "follow_events"),
		merge: {
			order: 8,
			conflictKey: "(id)",
		},
	}),
} as const satisfies Record<string, BackupTableCodecDefinition>;

export type BackupTableName = keyof typeof definitions;

export const BACKUP_TABLE_CODECS = Object.entries(definitions).map(
	([name, definition]) => ({
		name: name as BackupTableName,
		...definition,
	}),
) as BackupTableCodec<BackupTableName>[];

export type BackupImportRows = Record<BackupTableName, BackupJsonRecord[]>;

export function createBackupImportRows(): BackupImportRows {
	return Object.fromEntries(
		BACKUP_TABLE_CODECS.map((codec) => [codec.name, []]),
	) as unknown as BackupImportRows;
}

export function adaptLegacyTweetState(
	schemaVersion: number,
	tweets: BackupJsonRecord[],
	collections: BackupJsonRecord[],
	timelineEdges: BackupJsonRecord[],
) {
	if (schemaVersion >= 2) return { collections, timelineEdges };
	const nextCollections = [...collections];
	const nextTimelineEdges = [...timelineEdges];
	const collectionKeys = new Set(
		collections.map(
			(row) =>
				`${String(row.account_id)}\0${String(row.tweet_id)}\0${String(row.kind)}`,
		),
	);
	const edgeKeys = new Set(
		timelineEdges.map(
			(row) =>
				`${String(row.account_id)}\0${String(row.tweet_id)}\0${String(row.kind)}`,
		),
	);
	const edgeKinds = new Set([
		"home",
		"mention",
		"authored",
		"search",
		"profile",
		"thread_context",
	]);
	for (const tweet of tweets) {
		const accountId =
			typeof tweet.account_id === "string" ? tweet.account_id : "";
		const tweetId = typeof tweet.id === "string" ? tweet.id : "";
		if (!accountId || !tweetId) continue;
		const observedAt =
			typeof tweet.created_at === "string"
				? tweet.created_at
				: new Date(0).toISOString();
		const kind = typeof tweet.kind === "string" ? tweet.kind : "";
		if (edgeKinds.has(kind)) {
			const key = `${accountId}\0${tweetId}\0${kind}`;
			if (!edgeKeys.has(key)) {
				edgeKeys.add(key);
				nextTimelineEdges.push({
					account_id: accountId,
					tweet_id: tweetId,
					kind,
					first_seen_at: observedAt,
					last_seen_at: observedAt,
					seen_count: 1,
					source: "legacy",
					raw_json: "{}",
					updated_at: observedAt,
				});
			}
		}
		for (const [flag, collectionKind] of [
			["liked", "likes"],
			["bookmarked", "bookmarks"],
		] as const) {
			if (Number(tweet[flag] ?? 0) !== 1) continue;
			const key = `${accountId}\0${tweetId}\0${collectionKind}`;
			if (collectionKeys.has(key)) continue;
			collectionKeys.add(key);
			nextCollections.push({
				account_id: accountId,
				tweet_id: tweetId,
				kind: collectionKind,
				collected_at: null,
				source: "legacy",
				raw_json: "{}",
				updated_at: observedAt,
			});
		}
	}
	return { collections: nextCollections, timelineEdges: nextTimelineEdges };
}

export function backupCodecForPath(
	relativePath: string,
	codecs: readonly BackupTableCodec[] = BACKUP_TABLE_CODECS,
) {
	const logicalPath = logicalBackupShardPath(relativePath);
	const matches = codecs.filter((codec) => codec.matchesPath(logicalPath));
	if (matches.length !== 1) {
		throw new Error(
			matches.length === 0
				? `No backup codec owns path: ${relativePath}`
				: `Multiple backup codecs own path: ${relativePath}`,
		);
	}
	return matches[0] as BackupTableCodec;
}

export function buildBackupShardsFromRowSets(
	rowSets: ReadonlyArray<{ logicalName: string; rows: BackupJsonRecord[] }>,
	codecs: readonly BackupTableCodec[] = BACKUP_TABLE_CODECS,
) {
	const codecsByName = new Map(codecs.map((codec) => [codec.name, codec]));
	const shards = new Map<string, BackupJsonRecord[]>();
	for (const rowSet of rowSets) {
		const codec = codecsByName.get(rowSet.logicalName);
		if (!codec)
			throw new Error(`No backup codec for table: ${rowSet.logicalName}`);
		for (const row of rowSet.rows) {
			const relativePath = codec.shardPath(row);
			const existing = shards.get(relativePath) ?? [];
			existing.push(row);
			shards.set(relativePath, existing);
		}
	}
	return shards;
}

export function countBackupFiles(
	files: ReadonlyArray<{ path: string; rows: number }>,
	codecs: readonly BackupTableCodec[] = BACKUP_TABLE_CODECS,
) {
	const counts: Record<string, number> = {};
	for (const file of files) {
		if (!file.path.startsWith("data/")) continue;
		const codec = backupCodecForPath(file.path, codecs);
		const key = codec.countKey(logicalBackupShardPath(file.path));
		counts[key] = (counts[key] ?? 0) + file.rows;
	}
	return counts;
}

export function assertBackupTableCodecRegistry(
	codecs: readonly BackupTableCodec[] = BACKUP_TABLE_CODECS,
) {
	const names = new Set<string>();
	const mergeOrders = new Set<number>();
	for (const codec of codecs) {
		if (names.has(codec.name))
			throw new Error(`Duplicate backup codec: ${codec.name}`);
		if (mergeOrders.has(codec.merge.order)) {
			throw new Error(
				`Duplicate backup merge order: ${String(codec.merge.order)}`,
			);
		}
		if (codec.merge.columns.length === 0) {
			throw new Error(`Backup codec has no merge columns: ${codec.name}`);
		}
		names.add(codec.name);
		mergeOrders.add(codec.merge.order);
	}
	return true;
}
