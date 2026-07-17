import type { ImportFtsTable } from "./import-repository";
import { safeHttpUrl } from "./url-safety";

export type BackupJsonValue =
	| null
	| boolean
	| number
	| string
	| BackupJsonValue[]
	| { [key: string]: BackupJsonValue };

export type BackupJsonRecord = Record<string, BackupJsonValue>;

export interface BackupFtsCodec {
	target: ImportFtsTable;
	idKey: string;
	textKey: string;
}

export interface BackupMergeCodec {
	order: number;
	sql: string;
	columns: readonly string[];
	transform?: (rows: BackupJsonRecord[]) => BackupJsonRecord[];
	fts?: BackupFtsCodec;
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
	return rows.map((row) => ({
		...row,
		entities_json: sanitizeJsonTextUrls(row.entities_json, {}),
		media_json: sanitizeJsonTextUrls(row.media_json, []),
	}));
}

function sanitizeImportedUrlExpansions(rows: BackupJsonRecord[]) {
	return rows.map((row) => {
		const shortUrl =
			typeof row.short_url === "string" ? safeHttpUrl(row.short_url) : null;
		const expandedUrl =
			typeof row.expanded_url === "string"
				? safeHttpUrl(row.expanded_url)
				: null;
		const finalUrl =
			typeof row.final_url === "string" ? safeHttpUrl(row.final_url) : null;
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
					? (safeHttpUrl(row.image_url) ?? "")
					: row.image_url,
		};
	});
}

const definitions = {
	accounts: {
		exportSql: `
      select id, name, handle, external_user_id, transport, is_default, created_at
      from accounts
      order by id
    `,
		...fixedShard("data/accounts.jsonl", "accounts"),
		merge: {
			order: 0,
			sql: `
      insert into accounts (id, name, handle, external_user_id, transport, is_default, created_at)
      values (?, ?, ?, ?, ?, ?, ?)
      on conflict(id) do update set
        name = coalesce(nullif(excluded.name, ''), accounts.name),
        handle = coalesce(nullif(excluded.handle, ''), accounts.handle),
        external_user_id = coalesce(excluded.external_user_id, accounts.external_user_id),
        transport = coalesce(nullif(excluded.transport, ''), accounts.transport),
        is_default = max(accounts.is_default, excluded.is_default),
        created_at = min(accounts.created_at, excluded.created_at)
      `,
			columns: [
				"id",
				"name",
				"handle",
				"external_user_id",
				"transport",
				"is_default",
				"created_at",
			],
		},
	},
	profiles: {
		exportSql: `
      select id, handle, display_name, bio, followers_count,
        following_count, public_metrics_json, avatar_hue, avatar_url,
        location, url, verified_type, entities_json, raw_json, created_at
      from profiles
      order by id
    `,
		...fixedShard("data/profiles.jsonl", "profiles"),
		merge: {
			order: 3,
			sql: `
      insert into profiles (
        id, handle, display_name, bio, followers_count, following_count,
        public_metrics_json, avatar_hue, avatar_url, location, url,
        verified_type, entities_json, raw_json, created_at
      ) values (?, ?, ?, ?, ?, coalesce(?, 0), coalesce(?, '{}'), ?, ?, ?, ?, ?, coalesce(?, '{}'), coalesce(?, '{}'), ?)
      on conflict(id) do update set
        handle = coalesce(nullif(excluded.handle, ''), profiles.handle),
        display_name = coalesce(nullif(excluded.display_name, ''), profiles.display_name),
        bio = coalesce(nullif(excluded.bio, ''), profiles.bio),
        followers_count = max(profiles.followers_count, excluded.followers_count),
        following_count = max(profiles.following_count, excluded.following_count),
        public_metrics_json = case
          when excluded.public_metrics_json not in ('', '{}', 'null') then excluded.public_metrics_json
          else profiles.public_metrics_json
        end,
        avatar_hue = case when profiles.avatar_hue = 0 then excluded.avatar_hue else profiles.avatar_hue end,
        avatar_url = coalesce(excluded.avatar_url, profiles.avatar_url),
        location = coalesce(excluded.location, profiles.location),
        url = coalesce(excluded.url, profiles.url),
        verified_type = coalesce(excluded.verified_type, profiles.verified_type),
        entities_json = case
          when excluded.entities_json not in ('', '{}', 'null') then excluded.entities_json
          else profiles.entities_json
        end,
        raw_json = case
          when excluded.raw_json not in ('', '{}', 'null') then excluded.raw_json
          else profiles.raw_json
        end,
        created_at = min(profiles.created_at, excluded.created_at)
      `,
			columns: [
				"id",
				"handle",
				"display_name",
				"bio",
				"followers_count",
				"following_count",
				"public_metrics_json",
				"avatar_hue",
				"avatar_url",
				"location",
				"url",
				"verified_type",
				"entities_json",
				"raw_json",
				"created_at",
			],
		},
	},
	profile_affiliations: {
		exportSql: `
      select subject_profile_id, organization_profile_id, organization_name,
        organization_handle, badge_url, url, label, source, is_active,
        first_seen_at, last_seen_at, raw_json, updated_at
      from profile_affiliations
      order by subject_profile_id, organization_profile_id
    `,
		...fixedShard("data/profile_affiliations.jsonl", "profile_affiliations"),
		merge: {
			order: 4,
			sql: `
      insert into profile_affiliations (
        subject_profile_id, organization_profile_id, organization_name,
        organization_handle, badge_url, url, label, source, is_active,
        first_seen_at, last_seen_at, raw_json, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, coalesce(?, 'backup'), coalesce(?, 1), ?, ?, coalesce(?, '{}'), ?)
      on conflict(subject_profile_id, organization_profile_id) do update set
        organization_name = coalesce(excluded.organization_name, profile_affiliations.organization_name),
        organization_handle = coalesce(excluded.organization_handle, profile_affiliations.organization_handle),
        badge_url = coalesce(excluded.badge_url, profile_affiliations.badge_url),
        url = coalesce(excluded.url, profile_affiliations.url),
        label = coalesce(excluded.label, profile_affiliations.label),
        source = excluded.source,
        is_active = excluded.is_active,
        last_seen_at = max(profile_affiliations.last_seen_at, excluded.last_seen_at),
        raw_json = case
          when excluded.raw_json not in ('', '{}', 'null') then excluded.raw_json
          else profile_affiliations.raw_json
        end,
        updated_at = excluded.updated_at
      `,
			columns: [
				"subject_profile_id",
				"organization_profile_id",
				"organization_name",
				"organization_handle",
				"badge_url",
				"url",
				"label",
				"source",
				"is_active",
				"first_seen_at",
				"last_seen_at",
				"raw_json",
				"updated_at",
			],
		},
	},
	profile_snapshots: {
		exportSql: `
      select profile_id, snapshot_hash, observed_at, last_seen_at, source,
        handle, display_name, bio, location, url, verified_type,
        followers_count, following_count, affiliations_json, raw_json
      from profile_snapshots
      order by profile_id, last_seen_at, snapshot_hash
    `,
		...fixedShard("data/profile_snapshots.jsonl", "profile_snapshots"),
		merge: {
			order: 1,
			sql: `
      insert into profile_snapshots (
        profile_id, snapshot_hash, observed_at, last_seen_at, source, handle,
        display_name, bio, location, url, verified_type, followers_count,
        following_count, affiliations_json, raw_json
      ) values (?, ?, ?, ?, coalesce(?, 'backup'), ?, ?, ?, ?, ?, ?, coalesce(?, 0), coalesce(?, 0), coalesce(?, '[]'), coalesce(?, '{}'))
      on conflict(profile_id, snapshot_hash) do update set
        last_seen_at = max(profile_snapshots.last_seen_at, excluded.last_seen_at),
        source = excluded.source,
        raw_json = case
          when excluded.raw_json not in ('', '{}', 'null') then excluded.raw_json
          else profile_snapshots.raw_json
        end
      `,
			columns: [
				"profile_id",
				"snapshot_hash",
				"observed_at",
				"last_seen_at",
				"source",
				"handle",
				"display_name",
				"bio",
				"location",
				"url",
				"verified_type",
				"followers_count",
				"following_count",
				"affiliations_json",
				"raw_json",
			],
		},
	},
	profile_bio_entities: {
		exportSql: `
      select profile_id, kind, value, source, is_active, first_seen_at,
        last_seen_at, raw_json
      from profile_bio_entities
      order by profile_id, kind, value
    `,
		...fixedShard("data/profile_bio_entities.jsonl", "profile_bio_entities"),
		merge: {
			order: 2,
			sql: `
      insert into profile_bio_entities (
        profile_id, kind, value, source, is_active, first_seen_at, last_seen_at, raw_json
      ) values (?, ?, ?, coalesce(?, 'backup'), coalesce(?, 1), ?, ?, coalesce(?, '{}'))
      on conflict(profile_id, kind, value) do update set
        source = excluded.source,
        is_active = excluded.is_active,
        last_seen_at = max(profile_bio_entities.last_seen_at, excluded.last_seen_at),
        raw_json = case
          when excluded.raw_json not in ('', '{}', 'null') then excluded.raw_json
          else profile_bio_entities.raw_json
        end
      `,
			columns: [
				"profile_id",
				"kind",
				"value",
				"source",
				"is_active",
				"first_seen_at",
				"last_seen_at",
				"raw_json",
			],
		},
	},
	x_lists: {
		exportSql: `
      select account_id, list_id, name, description, owner_profile_id,
        owner_external_user_id, is_private, member_count, follower_count,
        source, membership_status, lists_synced_at, members_synced_at,
        member_page_count, member_result_count, rate_limit_json, raw_json,
        updated_at
      from x_lists
      order by account_id, name collate nocase, list_id
    `,
		...fixedShard("data/lists/lists.jsonl", "x_lists"),
		merge: {
			order: 9,
			sql: `
      insert into x_lists (
        account_id, list_id, name, description, owner_profile_id,
        owner_external_user_id, is_private, member_count, follower_count,
        source, membership_status, lists_synced_at, members_synced_at,
        member_page_count, member_result_count, rate_limit_json, raw_json,
        updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(account_id, list_id) do update set
        name = excluded.name,
        description = excluded.description,
        owner_profile_id = coalesce(excluded.owner_profile_id, x_lists.owner_profile_id),
        owner_external_user_id = coalesce(excluded.owner_external_user_id, x_lists.owner_external_user_id),
        is_private = case when excluded.updated_at >= x_lists.updated_at then excluded.is_private else x_lists.is_private end,
        member_count = coalesce(excluded.member_count, x_lists.member_count),
        follower_count = coalesce(excluded.follower_count, x_lists.follower_count),
        source = case when excluded.updated_at >= x_lists.updated_at then excluded.source else x_lists.source end,
        membership_status = case when excluded.updated_at >= x_lists.updated_at then excluded.membership_status else x_lists.membership_status end,
        lists_synced_at = max(x_lists.lists_synced_at, excluded.lists_synced_at),
        members_synced_at = nullif(max(coalesce(x_lists.members_synced_at, ''), coalesce(excluded.members_synced_at, '')), ''),
        member_page_count = case when excluded.updated_at >= x_lists.updated_at then excluded.member_page_count else x_lists.member_page_count end,
        member_result_count = case when excluded.updated_at >= x_lists.updated_at then excluded.member_result_count else x_lists.member_result_count end,
        rate_limit_json = case when excluded.updated_at >= x_lists.updated_at then excluded.rate_limit_json else x_lists.rate_limit_json end,
        raw_json = case when excluded.updated_at >= x_lists.updated_at then excluded.raw_json else x_lists.raw_json end,
        updated_at = max(x_lists.updated_at, excluded.updated_at)
      `,
			columns: [
				"account_id",
				"list_id",
				"name",
				"description",
				"owner_profile_id",
				"owner_external_user_id",
				"is_private",
				"member_count",
				"follower_count",
				"source",
				"membership_status",
				"lists_synced_at",
				"members_synced_at",
				"member_page_count",
				"member_result_count",
				"rate_limit_json",
				"raw_json",
				"updated_at",
			],
		},
	},
	x_list_members: {
		exportSql: `
      select account_id, list_id, profile_id, external_user_id, source,
        current, first_seen_at, last_seen_at, ended_at, raw_json, updated_at
      from x_list_members
      order by account_id, list_id, profile_id
    `,
		...fixedShard("data/lists/members.jsonl", "x_list_members"),
		merge: {
			order: 10,
			sql: `
      insert into x_list_members (
        account_id, list_id, profile_id, external_user_id, source, current,
        first_seen_at, last_seen_at, ended_at, raw_json, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(account_id, list_id, profile_id) do update set
        external_user_id = coalesce(nullif(excluded.external_user_id, ''), x_list_members.external_user_id),
        source = case when excluded.updated_at >= x_list_members.updated_at then excluded.source else x_list_members.source end,
        current = case when excluded.updated_at >= x_list_members.updated_at then excluded.current else x_list_members.current end,
        first_seen_at = min(x_list_members.first_seen_at, excluded.first_seen_at),
        last_seen_at = max(x_list_members.last_seen_at, excluded.last_seen_at),
        ended_at = case when excluded.updated_at >= x_list_members.updated_at then excluded.ended_at else x_list_members.ended_at end,
        raw_json = case when excluded.updated_at >= x_list_members.updated_at then excluded.raw_json else x_list_members.raw_json end,
        updated_at = max(x_list_members.updated_at, excluded.updated_at)
      `,
			columns: [
				"account_id",
				"list_id",
				"profile_id",
				"external_user_id",
				"source",
				"current",
				"first_seen_at",
				"last_seen_at",
				"ended_at",
				"raw_json",
				"updated_at",
			],
		},
	},
	tweets: {
		exportSql: `
      select id, author_profile_id, text, created_at, is_replied, reply_to_id,
        like_count, media_count, entities_json, media_json, quoted_tweet_id
      from tweets
      order by created_at, id
    `,
		shardPath: (row) =>
			`data/tweets/${yearFromTimestamp(row.created_at)}.jsonl`,
		matchesPath: (candidate) => candidate.startsWith("data/tweets/"),
		countKey: () => "tweets",
		merge: {
			order: 11,
			transform: sanitizeImportedTweets,
			sql: `
      insert into tweets (
        id, author_profile_id, text, created_at, is_replied, reply_to_id,
        like_count, media_count, entities_json, media_json, quoted_tweet_id
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(id) do update set
        author_profile_id = coalesce(nullif(excluded.author_profile_id, ''), tweets.author_profile_id),
        text = coalesce(nullif(excluded.text, ''), tweets.text),
        created_at = min(tweets.created_at, excluded.created_at),
        is_replied = max(tweets.is_replied, excluded.is_replied),
        reply_to_id = coalesce(excluded.reply_to_id, tweets.reply_to_id),
        like_count = max(tweets.like_count, excluded.like_count),
        media_count = max(tweets.media_count, excluded.media_count),
        entities_json = case
          when excluded.entities_json not in ('', '{}', 'null') then excluded.entities_json
          else tweets.entities_json
        end,
        media_json = case
          when excluded.media_json not in ('', '[]', 'null') then excluded.media_json
          else tweets.media_json
        end,
        quoted_tweet_id = coalesce(excluded.quoted_tweet_id, tweets.quoted_tweet_id)
      `,
			columns: [
				"id",
				"author_profile_id",
				"text",
				"created_at",
				"is_replied",
				"reply_to_id",
				"like_count",
				"media_count",
				"entities_json",
				"media_json",
				"quoted_tweet_id",
			],
			fts: {
				target: { table: "tweets_fts", idColumn: "tweet_id" },
				idKey: "id",
				textKey: "text",
			},
		},
	},
	tweet_sources: {
		exportSql: `
      select tweet_id, source, source_url, observed_at
      from tweet_sources
      order by tweet_id, source
    `,
		...fixedShard("data/tweet_sources.jsonl", "tweet_sources"),
		merge: {
			order: 12,
			sql: `
      insert into tweet_sources (tweet_id, source, source_url, observed_at)
      values (?, ?, ?, ?)
      on conflict(tweet_id, source) do update set
        source_url = case
          when excluded.observed_at >= tweet_sources.observed_at then excluded.source_url
          else tweet_sources.source_url
        end,
        observed_at = max(tweet_sources.observed_at, excluded.observed_at)
      `,
			columns: ["tweet_id", "source", "source_url", "observed_at"],
		},
	},
	tweet_collections: {
		exportSql: `
      select account_id, tweet_id, kind, collected_at, source, raw_json, updated_at
      from tweet_collections
      order by kind, account_id, coalesce(collected_at, ''), tweet_id
    `,
		shardPath: (row) => {
			const kind =
				row.kind === "likes" || row.kind === "bookmarks" ? row.kind : "unknown";
			return `data/collections/${kind}.jsonl`;
		},
		matchesPath: (candidate) => candidate.startsWith("data/collections/"),
		countKey: (candidate) =>
			`collections_${pathLeaf(candidate).replace(/\.jsonl$/, "") || "unknown"}`,
		merge: {
			order: 13,
			sql: `
      insert into tweet_collections (
        account_id, tweet_id, kind, collected_at, source, raw_json, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?)
      on conflict(account_id, tweet_id, kind) do update set
        collected_at = coalesce(tweet_collections.collected_at, excluded.collected_at),
        source = coalesce(nullif(excluded.source, ''), tweet_collections.source),
        raw_json = case
          when excluded.raw_json not in ('', '{}', 'null') then excluded.raw_json
          else tweet_collections.raw_json
        end,
        updated_at = max(tweet_collections.updated_at, excluded.updated_at)
      `,
			columns: [
				"account_id",
				"tweet_id",
				"kind",
				"collected_at",
				"source",
				"raw_json",
				"updated_at",
			],
		},
	},
	tweet_account_edges: {
		exportSql: `
      select account_id, tweet_id, kind, first_seen_at, last_seen_at,
        seen_count, source, raw_json, updated_at
      from tweet_account_edges
      order by kind, account_id, last_seen_at, tweet_id
    `,
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
			order: 14,
			sql: `
      insert into tweet_account_edges (
        account_id, tweet_id, kind, first_seen_at, last_seen_at, seen_count,
        source, raw_json, updated_at
      ) values (?, ?, ?, ?, ?, coalesce(?, 1), coalesce(?, 'backup'), coalesce(?, '{}'), ?)
      on conflict(account_id, tweet_id, kind) do update set
        first_seen_at = min(tweet_account_edges.first_seen_at, excluded.first_seen_at),
        last_seen_at = max(tweet_account_edges.last_seen_at, excluded.last_seen_at),
        seen_count = max(tweet_account_edges.seen_count, excluded.seen_count),
        source = coalesce(nullif(excluded.source, ''), tweet_account_edges.source),
        raw_json = case
          when excluded.raw_json not in ('', '{}', 'null') then excluded.raw_json
          else tweet_account_edges.raw_json
        end,
        updated_at = max(tweet_account_edges.updated_at, excluded.updated_at)
      `,
			columns: [
				"account_id",
				"tweet_id",
				"kind",
				"first_seen_at",
				"last_seen_at",
				"seen_count",
				"source",
				"raw_json",
				"updated_at",
			],
		},
	},
	dm_conversations: {
		exportSql: `
      select id, account_id, participant_profile_id, title, inbox_kind,
        last_message_at, unread_count, needs_reply
      from dm_conversations
      order by last_message_at, id
    `,
		...fixedShard("data/dms/conversations.jsonl", "dm_conversations"),
		merge: {
			order: 15,
			sql: `
      insert into dm_conversations (
        id, account_id, participant_profile_id, title, inbox_kind, last_message_at, unread_count, needs_reply
      ) values (?, ?, ?, ?, coalesce(?, 'accepted'), ?, ?, ?)
      on conflict(id) do update set
        account_id = coalesce(nullif(excluded.account_id, ''), dm_conversations.account_id),
        participant_profile_id = coalesce(nullif(excluded.participant_profile_id, ''), dm_conversations.participant_profile_id),
        title = coalesce(nullif(excluded.title, ''), dm_conversations.title),
        inbox_kind = case
          when excluded.last_message_at > dm_conversations.last_message_at
            then coalesce(nullif(excluded.inbox_kind, ''), dm_conversations.inbox_kind)
          else dm_conversations.inbox_kind
        end,
        last_message_at = max(dm_conversations.last_message_at, excluded.last_message_at),
        unread_count = max(dm_conversations.unread_count, excluded.unread_count),
        needs_reply = max(dm_conversations.needs_reply, excluded.needs_reply)
      `,
			columns: [
				"id",
				"account_id",
				"participant_profile_id",
				"title",
				"inbox_kind",
				"last_message_at",
				"unread_count",
				"needs_reply",
			],
		},
	},
	dm_messages: {
		exportSql: `
      select id, conversation_id, sender_profile_id, text, created_at, direction,
        is_replied, media_count
      from dm_messages
      order by conversation_id, created_at, id
    `,
		shardPath: (row) => `data/dms/${yearFromTimestamp(row.created_at)}.jsonl`,
		matchesPath: (candidate) =>
			candidate.startsWith("data/dms/") &&
			candidate !== "data/dms/conversations.jsonl",
		countKey: () => "dm_messages",
		merge: {
			order: 16,
			sql: `
      insert into dm_messages (
        id, conversation_id, sender_profile_id, text, created_at, direction, is_replied, media_count
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(id) do update set
        conversation_id = coalesce(nullif(excluded.conversation_id, ''), dm_messages.conversation_id),
        sender_profile_id = coalesce(nullif(excluded.sender_profile_id, ''), dm_messages.sender_profile_id),
        text = coalesce(nullif(excluded.text, ''), dm_messages.text),
        created_at = min(dm_messages.created_at, excluded.created_at),
        direction = coalesce(nullif(excluded.direction, ''), dm_messages.direction),
        is_replied = max(dm_messages.is_replied, excluded.is_replied),
        media_count = max(dm_messages.media_count, excluded.media_count)
      `,
			columns: [
				"id",
				"conversation_id",
				"sender_profile_id",
				"text",
				"created_at",
				"direction",
				"is_replied",
				"media_count",
			],
			fts: {
				target: { table: "dm_fts", idColumn: "message_id" },
				idKey: "id",
				textKey: "text",
			},
		},
	},
	url_expansions: {
		exportSql: `
      select short_url, expanded_url, final_url, status, expanded_tweet_id,
        expanded_handle, title, description, image_url, site_name, error,
        source, updated_at
      from url_expansions
      order by short_url
    `,
		...fixedShard("data/links/url_expansions.jsonl", "url_expansions"),
		merge: {
			order: 17,
			transform: sanitizeImportedUrlExpansions,
			sql: `
      insert into url_expansions (
        short_url, expanded_url, final_url, status, expanded_tweet_id,
        expanded_handle, title, description, image_url, site_name, error, source,
        updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(short_url) do update set
        expanded_url = excluded.expanded_url,
        final_url = excluded.final_url,
        status = excluded.status,
        expanded_tweet_id = excluded.expanded_tweet_id,
        expanded_handle = excluded.expanded_handle,
        title = excluded.title,
        description = excluded.description,
        image_url = excluded.image_url,
        site_name = excluded.site_name,
        error = excluded.error,
        source = excluded.source,
        updated_at = excluded.updated_at
      `,
			columns: [
				"short_url",
				"expanded_url",
				"final_url",
				"status",
				"expanded_tweet_id",
				"expanded_handle",
				"title",
				"description",
				"image_url",
				"site_name",
				"error",
				"source",
				"updated_at",
			],
		},
	},
	link_occurrences: {
		exportSql: `
      select source_kind, source_id, source_position, short_url, account_id,
        conversation_id, direction, created_at
      from link_occurrences
      order by source_kind, source_id, source_position, short_url
    `,
		...fixedShard("data/links/occurrences.jsonl", "link_occurrences"),
		merge: {
			order: 18,
			sql: `
      insert into link_occurrences (
        source_kind, source_id, source_position, short_url, account_id,
        conversation_id, direction, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(source_kind, source_id, source_position, short_url) do update set
        account_id = excluded.account_id,
        conversation_id = excluded.conversation_id,
        direction = excluded.direction,
        created_at = excluded.created_at
      `,
			columns: [
				"source_kind",
				"source_id",
				"source_position",
				"short_url",
				"account_id",
				"conversation_id",
				"direction",
				"created_at",
			],
		},
	},
	blocks: {
		exportSql: `
      select account_id, profile_id, source, created_at
      from blocks
      order by account_id, profile_id
    `,
		...fixedShard("data/moderation/blocks.jsonl", "blocks"),
		merge: {
			order: 19,
			sql: `
      insert into blocks (account_id, profile_id, source, created_at)
      values (?, ?, ?, ?)
      on conflict(account_id, profile_id) do update set
        source = coalesce(nullif(excluded.source, ''), blocks.source),
        created_at = min(blocks.created_at, excluded.created_at)
      `,
			columns: ["account_id", "profile_id", "source", "created_at"],
		},
	},
	mutes: {
		exportSql: `
      select account_id, profile_id, source, created_at
      from mutes
      order by account_id, profile_id
    `,
		...fixedShard("data/moderation/mutes.jsonl", "mutes"),
		merge: {
			order: 20,
			sql: `
      insert into mutes (account_id, profile_id, source, created_at)
      values (?, ?, ?, ?)
      on conflict(account_id, profile_id) do update set
        source = coalesce(nullif(excluded.source, ''), mutes.source),
        created_at = min(mutes.created_at, excluded.created_at)
      `,
			columns: ["account_id", "profile_id", "source", "created_at"],
		},
	},
	tweet_actions: {
		exportSql: `
      select id, account_id, tweet_id, kind, body, created_at
      from tweet_actions
      order by created_at, id
    `,
		...fixedShard("data/actions/tweet_actions.jsonl", "tweet_actions"),
		merge: {
			order: 21,
			sql: `
      insert into tweet_actions (id, account_id, tweet_id, kind, body, created_at)
      values (?, ?, ?, ?, ?, ?)
      on conflict(id) do update set
        account_id = coalesce(nullif(excluded.account_id, ''), tweet_actions.account_id),
        tweet_id = coalesce(excluded.tweet_id, tweet_actions.tweet_id),
        kind = coalesce(nullif(excluded.kind, ''), tweet_actions.kind),
        body = coalesce(nullif(excluded.body, ''), tweet_actions.body),
        created_at = min(tweet_actions.created_at, excluded.created_at)
      `,
			columns: ["id", "account_id", "tweet_id", "kind", "body", "created_at"],
		},
	},
	ai_scores: {
		exportSql: `
      select entity_kind, entity_id, model, score, summary, reasoning, updated_at
      from ai_scores
      order by entity_kind, entity_id, model
    `,
		...fixedShard("data/ai_scores.jsonl", "ai_scores"),
		merge: {
			order: 22,
			sql: `
      insert into ai_scores (
        entity_kind, entity_id, model, score, summary, reasoning, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?)
      on conflict(entity_kind, entity_id) do update set
        model = coalesce(nullif(excluded.model, ''), ai_scores.model),
        score = max(ai_scores.score, excluded.score),
        summary = coalesce(nullif(excluded.summary, ''), ai_scores.summary),
        reasoning = coalesce(nullif(excluded.reasoning, ''), ai_scores.reasoning),
        updated_at = max(ai_scores.updated_at, excluded.updated_at)
      `,
			columns: [
				"entity_kind",
				"entity_id",
				"model",
				"score",
				"summary",
				"reasoning",
				"updated_at",
			],
		},
	},
	follow_snapshots: {
		exportSql: `
      select id, account_id, direction, source, status, page_count,
        result_count, started_at, completed_at, raw_meta_json
      from follow_snapshots
      order by account_id, direction, completed_at, id
    `,
		...fixedShard("data/follow_snapshots.jsonl", "follow_snapshots"),
		merge: {
			order: 5,
			sql: `
      insert into follow_snapshots (
        id, account_id, direction, source, status, page_count, result_count,
        started_at, completed_at, raw_meta_json
      ) values (?, ?, ?, coalesce(?, 'backup'), ?, coalesce(?, 0), coalesce(?, 0), ?, ?, coalesce(?, '{}'))
      on conflict(id) do update set
        account_id = coalesce(nullif(excluded.account_id, ''), follow_snapshots.account_id),
        direction = coalesce(nullif(excluded.direction, ''), follow_snapshots.direction),
        source = coalesce(nullif(excluded.source, ''), follow_snapshots.source),
        status = coalesce(nullif(excluded.status, ''), follow_snapshots.status),
        page_count = max(follow_snapshots.page_count, excluded.page_count),
        result_count = max(follow_snapshots.result_count, excluded.result_count),
        started_at = min(follow_snapshots.started_at, excluded.started_at),
        completed_at = max(follow_snapshots.completed_at, excluded.completed_at),
        raw_meta_json = case
          when excluded.raw_meta_json not in ('', '{}', 'null') then excluded.raw_meta_json
          else follow_snapshots.raw_meta_json
        end
      `,
			columns: [
				"id",
				"account_id",
				"direction",
				"source",
				"status",
				"page_count",
				"result_count",
				"started_at",
				"completed_at",
				"raw_meta_json",
			],
		},
	},
	follow_snapshot_members: {
		exportSql: `
      select snapshot_id, profile_id, external_user_id, position
      from follow_snapshot_members
      order by snapshot_id, position, profile_id
    `,
		...fixedShard(
			"data/follow_snapshot_members.jsonl",
			"follow_snapshot_members",
		),
		merge: {
			order: 6,
			sql: `
      insert into follow_snapshot_members (
        snapshot_id, profile_id, external_user_id, position
      ) values (?, ?, ?, coalesce(?, 0))
      on conflict(snapshot_id, profile_id) do update set
        external_user_id = coalesce(nullif(excluded.external_user_id, ''), follow_snapshot_members.external_user_id),
        position = excluded.position
      `,
			columns: ["snapshot_id", "profile_id", "external_user_id", "position"],
		},
	},
	follow_edges: {
		exportSql: `
      select account_id, direction, profile_id, external_user_id, source,
        current, first_seen_at, last_seen_at, ended_at, updated_at
      from follow_edges
      order by account_id, direction, profile_id
    `,
		...fixedShard("data/follow_edges.jsonl", "follow_edges"),
		merge: {
			order: 7,
			sql: `
      insert into follow_edges (
        account_id, direction, profile_id, external_user_id, source, current,
        first_seen_at, last_seen_at, ended_at, updated_at
      ) values (?, ?, ?, ?, coalesce(?, 'backup'), coalesce(?, 1), ?, ?, ?, ?)
      on conflict(account_id, direction, profile_id) do update set
        external_user_id = coalesce(nullif(excluded.external_user_id, ''), follow_edges.external_user_id),
        source = coalesce(nullif(excluded.source, ''), follow_edges.source),
        current = case
          when excluded.updated_at >= follow_edges.updated_at then excluded.current
          else follow_edges.current
        end,
        first_seen_at = min(follow_edges.first_seen_at, excluded.first_seen_at),
        last_seen_at = max(follow_edges.last_seen_at, excluded.last_seen_at),
        ended_at = case
          when excluded.updated_at >= follow_edges.updated_at then excluded.ended_at
          else follow_edges.ended_at
        end,
        updated_at = max(follow_edges.updated_at, excluded.updated_at)
      `,
			columns: [
				"account_id",
				"direction",
				"profile_id",
				"external_user_id",
				"source",
				"current",
				"first_seen_at",
				"last_seen_at",
				"ended_at",
				"updated_at",
			],
		},
	},
	follow_events: {
		exportSql: `
      select id, account_id, direction, profile_id, external_user_id, kind,
        event_at, snapshot_id
      from follow_events
      order by account_id, direction, event_at, kind, profile_id, id
    `,
		...fixedShard("data/follow_events.jsonl", "follow_events"),
		merge: {
			order: 8,
			sql: `
      insert into follow_events (
        id, account_id, direction, profile_id, external_user_id, kind, event_at,
        snapshot_id
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(id) do update set
        account_id = coalesce(nullif(excluded.account_id, ''), follow_events.account_id),
        direction = coalesce(nullif(excluded.direction, ''), follow_events.direction),
        profile_id = coalesce(nullif(excluded.profile_id, ''), follow_events.profile_id),
        external_user_id = coalesce(nullif(excluded.external_user_id, ''), follow_events.external_user_id),
        kind = coalesce(nullif(excluded.kind, ''), follow_events.kind),
        event_at = coalesce(nullif(excluded.event_at, ''), follow_events.event_at),
        snapshot_id = coalesce(nullif(excluded.snapshot_id, ''), follow_events.snapshot_id)
      `,
			columns: [
				"id",
				"account_id",
				"direction",
				"profile_id",
				"external_user_id",
				"kind",
				"event_at",
				"snapshot_id",
			],
		},
	},
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
