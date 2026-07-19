import { existsSync } from "node:fs";
import NativeSqliteDatabase, {
	type Database,
	SQLITE_BUSY_TIMEOUT_MS,
} from "./sqlite";
import { ensureBirdclawDirs, getBirdclawPaths } from "./config";
import {
	getDatabaseSchemaVersion,
	type DatabaseMigration,
	runDatabaseMigrations,
} from "./database-migrations";
import { seedDemoData } from "./seed";
import {
	type DatabaseConnectionRole,
	recordDatabaseStatement,
} from "./database-metrics";

let nativeDb: Database | undefined;
let readDbs: Database[] = [];
let readDbIndex = 0;
let demoSeedAttempted = false;

export interface InitDatabaseOptions {
	seedDemoData?: boolean;
}

const BASE_SCHEMA_SQL = `
  create table if not exists accounts (
    id text primary key,
    name text not null,
    handle text not null unique,
    external_user_id text,
    transport text not null,
    is_default integer not null default 0,
    created_at text not null
  );

  create table if not exists profiles (
    id text primary key,
    handle text not null unique,
    display_name text not null,
    bio text not null,
    followers_count integer not null default 0,
    following_count integer not null default 0,
    public_metrics_json text not null default '{}',
    avatar_hue integer not null default 0,
    avatar_url text,
    location text,
    url text,
    verified_type text,
    entities_json text not null default '{}',
    raw_json text not null default '{}',
    created_at text not null
  );

  create table if not exists profile_affiliations (
    subject_profile_id text not null,
    organization_profile_id text not null,
    organization_name text,
    organization_handle text,
    badge_url text,
    url text,
    label text,
    source text not null,
    is_active integer not null default 1,
    first_seen_at text not null,
    last_seen_at text not null,
    raw_json text not null default '{}',
    updated_at text not null,
    primary key (subject_profile_id, organization_profile_id)
  );

  create table if not exists profile_snapshots (
    profile_id text not null,
    snapshot_hash text not null,
    observed_at text not null,
    last_seen_at text not null,
    source text not null,
    handle text not null,
    display_name text not null,
    bio text not null,
    location text,
    url text,
    verified_type text,
    followers_count integer not null default 0,
    following_count integer not null default 0,
    affiliations_json text not null default '[]',
    raw_json text not null default '{}',
    primary key (profile_id, snapshot_hash)
  );

  create table if not exists profile_bio_entities (
    profile_id text not null,
    kind text not null,
    value text not null,
    source text not null,
    is_active integer not null default 1,
    first_seen_at text not null,
    last_seen_at text not null,
    raw_json text not null default '{}',
    primary key (profile_id, kind, value)
  );

  create table if not exists identity_search_index (
    profile_id text not null,
    kind text not null,
    value text not null,
    normalized_value text not null,
    source text not null,
    weight integer not null,
    updated_at text not null,
    primary key (profile_id, kind, value, source)
  );

  create table if not exists tweets (
    id text primary key,
    account_id text not null,
    author_profile_id text not null,
    kind text not null,
    text text not null,
    created_at text not null,
    is_replied integer not null default 0,
    reply_to_id text,
    like_count integer not null default 0,
    media_count integer not null default 0,
    bookmarked integer not null default 0,
    liked integer not null default 0,
    entities_json text not null default '{}',
    media_json text not null default '[]',
    quoted_tweet_id text,
    deleted_at text,
    deletion_source text,
    deletion_reason text,
    superseded_at text,
    superseded_by_id text
  );

  create table if not exists tweet_revisions (
    root_tweet_id text not null,
    revision_id text primary key,
    revision_index integer not null,
    payload_json text,
    source text not null,
    observed_at text not null
  );

  create table if not exists tweet_subordinate_tombstones (
    tweet_id text not null,
    kind text not null check (kind in ('media', 'quote')),
    subordinate_id text not null,
    deleted_at text not null,
    deletion_source text,
    deletion_reason text not null,
    primary key (tweet_id, kind, subordinate_id)
  );

  create table if not exists tweet_sources (
    tweet_id text not null,
    source text not null,
    source_url text not null,
    observed_at text not null,
    primary key (tweet_id, source)
  );

  create table if not exists tweet_collections (
    account_id text not null,
    tweet_id text not null,
    kind text not null,
    collected_at text,
    source text not null,
    raw_json text not null default '{}',
    updated_at text not null,
    primary key (account_id, tweet_id, kind)
  );

  create table if not exists tweet_account_edges (
    account_id text not null,
    tweet_id text not null,
    kind text not null,
    first_seen_at text not null,
    last_seen_at text not null,
    seen_count integer not null default 1,
    source text not null,
    raw_json text not null default '{}',
    updated_at text not null,
    primary key (account_id, tweet_id, kind)
  );

  create table if not exists dm_conversations (
    id text primary key,
    account_id text not null,
    participant_profile_id text not null,
    title text not null,
    inbox_kind text not null default 'accepted',
    last_message_at text not null,
    unread_count integer not null default 0,
    needs_reply integer not null default 0
  );

  create table if not exists dm_messages (
    id text primary key,
    conversation_id text not null,
    sender_profile_id text not null,
    text text not null,
    created_at text not null,
    direction text not null,
    is_replied integer not null default 0,
    media_count integer not null default 0
  );

  create table if not exists tweet_actions (
    id text primary key,
    account_id text not null,
    tweet_id text,
    kind text not null,
    body text not null,
    created_at text not null
  );

  create table if not exists blocks (
    account_id text not null,
    profile_id text not null,
    source text not null,
    created_at text not null,
    primary key (account_id, profile_id)
  );

  create table if not exists mutes (
    account_id text not null,
    profile_id text not null,
    source text not null,
    created_at text not null,
    primary key (account_id, profile_id)
  );

  create table if not exists ai_scores (
    entity_kind text not null,
    entity_id text not null,
    model text not null,
    score integer not null,
    summary text not null,
    reasoning text not null,
    updated_at text not null,
    primary key (entity_kind, entity_id)
  );

  create table if not exists sync_cache (
    cache_key text primary key,
    value_json text not null,
    updated_at text not null
  );

  create table if not exists url_expansions (
    short_url text primary key,
    expanded_url text not null,
    final_url text not null,
    status text not null,
    expanded_tweet_id text,
    expanded_handle text,
    title text,
    description text,
    image_url text,
    site_name text,
    error text,
    source text not null,
    updated_at text not null
  );

  create table if not exists link_occurrences (
    source_kind text not null,
    source_id text not null,
    source_position integer not null,
    short_url text not null,
    account_id text,
    conversation_id text,
    direction text,
    created_at text not null,
    primary key (source_kind, source_id, source_position, short_url)
  );

  create table if not exists follow_snapshots (
    id text primary key,
    account_id text not null,
    direction text not null,
    source text not null,
    status text not null,
    page_count integer not null default 0,
    result_count integer not null default 0,
    started_at text not null,
    completed_at text not null,
    raw_meta_json text not null default '{}'
  );

  create table if not exists follow_snapshot_members (
    snapshot_id text not null,
    profile_id text not null,
    external_user_id text not null,
    position integer not null,
    primary key (snapshot_id, profile_id)
  );

  create table if not exists follow_edges (
    account_id text not null,
    direction text not null,
    profile_id text not null,
    external_user_id text not null,
    source text not null,
    current integer not null default 1,
    first_seen_at text not null,
    last_seen_at text not null,
    ended_at text,
    updated_at text not null,
    primary key (account_id, direction, profile_id)
  );

  create table if not exists follow_events (
    id text primary key,
    account_id text not null,
    direction text not null,
    profile_id text not null,
    external_user_id text not null,
    kind text not null,
    event_at text not null,
    snapshot_id text not null
  );

  create table if not exists x_lists (
    account_id text not null,
    list_id text not null,
    name text not null,
    description text not null default '',
    owner_profile_id text,
    owner_external_user_id text,
    is_private integer not null default 0,
    member_count integer,
    follower_count integer,
    source text not null,
    membership_status text not null default 'not_synced',
    lists_synced_at text not null,
    members_synced_at text,
    member_page_count integer not null default 0,
    member_result_count integer not null default 0,
    rate_limit_json text not null default '{}',
    raw_json text not null default '{}',
    updated_at text not null,
    primary key (account_id, list_id)
  );

  create table if not exists x_list_members (
    account_id text not null,
    list_id text not null,
    profile_id text not null,
    external_user_id text not null,
    source text not null,
    current integer not null default 1,
    first_seen_at text not null,
    last_seen_at text not null,
    ended_at text,
    raw_json text not null default '{}',
    updated_at text not null,
    primary key (account_id, list_id, profile_id)
  );

  create table if not exists geocoded_locations (
    normalized_key text primary key,
    original text not null,
    lat real not null,
    lng real not null,
    formatted text,
    country_code text,
    confidence integer,
    provider text not null,
    approx_radius_m real,
    bounds_json text not null default '{}',
    components_json text not null default '{}',
    hits integer not null default 1,
    created_at text not null,
    last_used_at text not null
  );

  create table if not exists geocoded_locations_unresolved (
    normalized_key text primary key,
    original text not null,
    reason text not null,
    last_attempted_at text not null,
    ttl_until text
  );

  create virtual table if not exists tweets_fts using fts5(
    tweet_id unindexed,
    text
  );

  create virtual table if not exists dm_fts using fts5(
    message_id unindexed,
    text
  );
`;

const INDEX_SQL = `
  create index if not exists idx_tweets_kind_created on tweets(kind, created_at desc);
  create index if not exists idx_tweets_created on tweets(created_at desc);
  create index if not exists idx_tweets_account_created on tweets(account_id, created_at desc);
  create index if not exists idx_tweets_quoted on tweets(quoted_tweet_id);
  create index if not exists idx_tweet_collections_kind_account on tweet_collections(kind, account_id, collected_at desc, tweet_id);
  create index if not exists idx_tweet_collections_tweet on tweet_collections(tweet_id);
  create index if not exists idx_tweet_account_edges_kind_account on tweet_account_edges(kind, account_id, last_seen_at desc, tweet_id);
  create index if not exists idx_tweet_account_edges_kind_tweet on tweet_account_edges(kind, tweet_id, account_id);
  create index if not exists idx_tweet_account_edges_tweet on tweet_account_edges(tweet_id);
  create index if not exists idx_dm_conversations_account on dm_conversations(account_id, last_message_at desc);
  create index if not exists idx_dm_messages_conversation on dm_messages(conversation_id, created_at asc);
  create index if not exists idx_profiles_followers on profiles(followers_count desc);
  create index if not exists idx_profiles_following on profiles(following_count desc);
  create index if not exists idx_profiles_handle on profiles(handle);
  create index if not exists idx_profile_affiliations_subject on profile_affiliations(subject_profile_id, is_active, last_seen_at desc);
  create index if not exists idx_profile_affiliations_org on profile_affiliations(organization_profile_id, is_active, last_seen_at desc);
  create index if not exists idx_profile_snapshots_profile on profile_snapshots(profile_id, last_seen_at desc);
  create index if not exists idx_profile_bio_entities_profile on profile_bio_entities(profile_id, is_active, last_seen_at desc);
  create index if not exists idx_profile_bio_entities_value on profile_bio_entities(kind, value, is_active);
  create index if not exists idx_identity_search_index_profile on identity_search_index(profile_id);
  create index if not exists idx_identity_search_index_value on identity_search_index(normalized_value, kind, weight desc);
  create index if not exists idx_blocks_account_created on blocks(account_id, created_at desc);
  create index if not exists idx_mutes_account_created on mutes(account_id, created_at desc);
  create index if not exists idx_ai_scores_updated on ai_scores(updated_at desc);
  create index if not exists idx_sync_cache_updated on sync_cache(updated_at desc);
  create index if not exists idx_url_expansions_expanded on url_expansions(expanded_url);
  create index if not exists idx_url_expansions_tweet on url_expansions(expanded_tweet_id);
  create index if not exists idx_url_expansions_handle on url_expansions(expanded_handle);
  create index if not exists idx_link_occurrences_url on link_occurrences(short_url);
  create index if not exists idx_link_occurrences_created on link_occurrences(created_at desc);
  create index if not exists idx_link_occurrences_account on link_occurrences(account_id, created_at desc);
  create index if not exists idx_link_occurrences_direction on link_occurrences(direction, created_at desc);
  create index if not exists idx_follow_edges_current on follow_edges(account_id, direction, current, last_seen_at desc);
  create index if not exists idx_follow_edges_profile on follow_edges(profile_id, current);
  create index if not exists idx_follow_snapshots_account on follow_snapshots(account_id, direction, completed_at desc);
  create index if not exists idx_follow_events_account on follow_events(account_id, direction, kind, event_at desc);
  create index if not exists idx_x_lists_account_name on x_lists(account_id, name collate nocase, list_id);
  create index if not exists idx_x_list_members_current on x_list_members(account_id, list_id, current, profile_id);
  create index if not exists idx_x_list_members_profile on x_list_members(profile_id, current, account_id, list_id);
  create index if not exists idx_geocoded_locations_country on geocoded_locations(country_code);
  create index if not exists idx_geocoded_locations_last_used on geocoded_locations(last_used_at desc);
  create index if not exists idx_geocoded_unresolved_ttl on geocoded_locations_unresolved(ttl_until desc);
`;

function getColumnNames(db: Database, tableName: string): Set<string> {
	const rows = db.prepare(`pragma table_info(${tableName})`).all() as Array<{
		name: string;
	}>;
	return new Set(rows.map((row) => row.name));
}

function ensureTweetMetadataColumns(db: Database) {
	const columnNames = getColumnNames(db, "tweets");
	if (!columnNames.has("entities_json")) {
		db.exec(
			"alter table tweets add column entities_json text not null default '{}'",
		);
	}
	if (!columnNames.has("media_json")) {
		db.exec(
			"alter table tweets add column media_json text not null default '[]'",
		);
	}
	if (!columnNames.has("quoted_tweet_id")) {
		db.exec("alter table tweets add column quoted_tweet_id text");
	}
}

function ensureTweetRetentionSchema(db: Database) {
	const columnNames = getColumnNames(db, "tweets");
	if (!columnNames.has("deleted_at")) {
		db.exec("alter table tweets add column deleted_at text");
	}
	if (!columnNames.has("deletion_source")) {
		db.exec("alter table tweets add column deletion_source text");
	}
	if (!columnNames.has("deletion_reason")) {
		db.exec("alter table tweets add column deletion_reason text");
	}
	if (!columnNames.has("superseded_at")) {
		db.exec("alter table tweets add column superseded_at text");
	}
	if (!columnNames.has("superseded_by_id")) {
		db.exec("alter table tweets add column superseded_by_id text");
	}
	db.exec(`
		create table if not exists tweet_revisions (
			root_tweet_id text not null,
			revision_id text primary key,
			revision_index integer not null,
			payload_json text,
			source text not null,
			observed_at text not null
		);
		create table if not exists tweet_subordinate_tombstones (
			tweet_id text not null,
			kind text not null check (kind in ('media', 'quote')),
			subordinate_id text not null,
			deleted_at text not null,
			deletion_source text,
			deletion_reason text not null,
			primary key (tweet_id, kind, subordinate_id)
		);
		create index if not exists idx_tweets_deleted on tweets(deleted_at);
		create index if not exists idx_tweets_superseded on tweets(superseded_at);
		create index if not exists idx_tweet_revisions_root on tweet_revisions(root_tweet_id, revision_index);
		create index if not exists idx_tweet_subordinate_tombstones_tweet on tweet_subordinate_tombstones(tweet_id);
		insert or ignore into tweet_revisions (
			root_tweet_id, revision_id, revision_index, payload_json, source, observed_at
		)
		select id, id, 0, null, 'migration', created_at
		from tweets;
	`);
}

function ensureProfileAvatarColumns(db: Database) {
	const columnNames = getColumnNames(db, "profiles");
	if (!columnNames.has("following_count")) {
		db.exec(
			"alter table profiles add column following_count integer not null default 0",
		);
	}
	if (!columnNames.has("avatar_url")) {
		db.exec("alter table profiles add column avatar_url text");
	}
	if (!columnNames.has("location")) {
		db.exec("alter table profiles add column location text");
	}
	if (!columnNames.has("url")) {
		db.exec("alter table profiles add column url text");
	}
	if (!columnNames.has("verified_type")) {
		db.exec("alter table profiles add column verified_type text");
	}
	if (!columnNames.has("entities_json")) {
		db.exec(
			"alter table profiles add column entities_json text not null default '{}'",
		);
	}
	if (!columnNames.has("raw_json")) {
		db.exec(
			"alter table profiles add column raw_json text not null default '{}'",
		);
	}
	if (!columnNames.has("public_metrics_json")) {
		db.exec(
			"alter table profiles add column public_metrics_json text not null default '{}'",
		);
	}
}

function ensureAccountExternalUserIdColumn(db: Database) {
	const columnNames = getColumnNames(db, "accounts");
	if (!columnNames.has("external_user_id")) {
		db.exec("alter table accounts add column external_user_id text");
	}
}

function ensureDmConversationInboxColumns(db: Database) {
	const columnNames = getColumnNames(db, "dm_conversations");
	if (!columnNames.has("inbox_kind")) {
		db.exec(
			"alter table dm_conversations add column inbox_kind text not null default 'accepted'",
		);
	}
}

function ensureTweetCollectionsTable(db: Database) {
	db.exec(`
    create table if not exists tweet_collections (
      account_id text not null,
      tweet_id text not null,
      kind text not null,
      collected_at text,
      source text not null,
      raw_json text not null default '{}',
      updated_at text not null,
      primary key (account_id, tweet_id, kind)
    );
  `);
}

function ensureTweetSourcesTable(db: Database) {
	db.exec(`
    create table if not exists tweet_sources (
      tweet_id text not null,
      source text not null,
      source_url text not null,
      observed_at text not null,
      primary key (tweet_id, source)
    );
  `);
}

function ensureTweetAccountEdgesTable(db: Database) {
	db.exec(`
    create table if not exists tweet_account_edges (
      account_id text not null,
      tweet_id text not null,
      kind text not null,
      first_seen_at text not null,
      last_seen_at text not null,
      seen_count integer not null default 1,
      source text not null,
      raw_json text not null default '{}',
      updated_at text not null,
      primary key (account_id, tweet_id, kind)
    );
  `);
}

function ensureProfileAffiliationsTable(db: Database) {
	db.exec(`
    create table if not exists profile_affiliations (
      subject_profile_id text not null,
      organization_profile_id text not null,
      organization_name text,
      organization_handle text,
      badge_url text,
      url text,
      label text,
      source text not null,
      is_active integer not null default 1,
      first_seen_at text not null,
      last_seen_at text not null,
      raw_json text not null default '{}',
      updated_at text not null,
      primary key (subject_profile_id, organization_profile_id)
    );
  `);
}

function ensureProfileSnapshotsTable(db: Database) {
	db.exec(`
    create table if not exists profile_snapshots (
      profile_id text not null,
      snapshot_hash text not null,
      observed_at text not null,
      last_seen_at text not null,
      source text not null,
      handle text not null,
      display_name text not null,
      bio text not null,
      location text,
      url text,
      verified_type text,
      followers_count integer not null default 0,
      following_count integer not null default 0,
      affiliations_json text not null default '[]',
      raw_json text not null default '{}',
      primary key (profile_id, snapshot_hash)
    );
  `);
}

function ensureProfileBioEntitiesTable(db: Database) {
	db.exec(`
    create table if not exists profile_bio_entities (
      profile_id text not null,
      kind text not null,
      value text not null,
      source text not null,
      is_active integer not null default 1,
      first_seen_at text not null,
      last_seen_at text not null,
      raw_json text not null default '{}',
      primary key (profile_id, kind, value)
    );
  `);
}

function ensureIdentitySearchIndexTable(db: Database) {
	db.exec(`
    create table if not exists identity_search_index (
      profile_id text not null,
      kind text not null,
      value text not null,
      normalized_value text not null,
      source text not null,
      weight integer not null,
      updated_at text not null,
      primary key (profile_id, kind, value, source)
    );
  `);
}

function ensureLinkIndexTables(db: Database) {
	db.exec(`
    create table if not exists url_expansions (
      short_url text primary key,
      expanded_url text not null,
      final_url text not null,
      status text not null,
      expanded_tweet_id text,
      expanded_handle text,
      title text,
      description text,
      image_url text,
      site_name text,
      error text,
      source text not null,
      updated_at text not null
    );

    create table if not exists link_occurrences (
      source_kind text not null,
      source_id text not null,
      source_position integer not null,
      short_url text not null,
      account_id text,
      conversation_id text,
      direction text,
      created_at text not null,
      primary key (source_kind, source_id, source_position, short_url)
    );
  `);

	const urlExpansionColumns = getColumnNames(db, "url_expansions");
	if (!urlExpansionColumns.has("image_url")) {
		db.exec("alter table url_expansions add column image_url text");
	}
	if (!urlExpansionColumns.has("site_name")) {
		db.exec("alter table url_expansions add column site_name text");
	}
}

function ensureFollowGraphTables(db: Database) {
	db.exec(`
    create table if not exists follow_snapshots (
      id text primary key,
      account_id text not null,
      direction text not null,
      source text not null,
      status text not null,
      page_count integer not null default 0,
      result_count integer not null default 0,
      started_at text not null,
      completed_at text not null,
      raw_meta_json text not null default '{}'
    );

    create table if not exists follow_snapshot_members (
      snapshot_id text not null,
      profile_id text not null,
      external_user_id text not null,
      position integer not null,
      primary key (snapshot_id, profile_id)
    );

    create table if not exists follow_edges (
      account_id text not null,
      direction text not null,
      profile_id text not null,
      external_user_id text not null,
      source text not null,
      current integer not null default 1,
      first_seen_at text not null,
      last_seen_at text not null,
      ended_at text,
      updated_at text not null,
      primary key (account_id, direction, profile_id)
    );

    create table if not exists follow_events (
      id text primary key,
      account_id text not null,
      direction text not null,
      profile_id text not null,
      external_user_id text not null,
      kind text not null,
      event_at text not null,
      snapshot_id text not null
    );
	`);
}

function ensureXListTables(db: Database) {
	db.exec(`
    create table if not exists x_lists (
      account_id text not null,
      list_id text not null,
      name text not null,
      description text not null default '',
      owner_profile_id text,
      owner_external_user_id text,
      is_private integer not null default 0,
      member_count integer,
      follower_count integer,
      source text not null,
      membership_status text not null default 'not_synced',
      lists_synced_at text not null,
      members_synced_at text,
      member_page_count integer not null default 0,
      member_result_count integer not null default 0,
      rate_limit_json text not null default '{}',
      raw_json text not null default '{}',
      updated_at text not null,
      primary key (account_id, list_id)
    );

    create table if not exists x_list_members (
      account_id text not null,
      list_id text not null,
      profile_id text not null,
      external_user_id text not null,
      source text not null,
      current integer not null default 1,
      first_seen_at text not null,
      last_seen_at text not null,
      ended_at text,
      raw_json text not null default '{}',
      updated_at text not null,
      primary key (account_id, list_id, profile_id)
    );

    create index if not exists idx_x_lists_account_name on x_lists(account_id, name collate nocase, list_id);
    create index if not exists idx_x_list_members_current on x_list_members(account_id, list_id, current, profile_id);
    create index if not exists idx_x_list_members_profile on x_list_members(profile_id, current, account_id, list_id);
  `);
}

function backfillTweetCollections(db: Database) {
	const missingKinds = (
		[
			["likes", "liked"],
			["bookmarks", "bookmarked"],
		] as const
	).filter(([, column]) =>
		db
			.prepare(
				`
        select 1
        from tweets as tweet
        where tweet.${column} = 1
          and not exists (
            select 1
            from tweet_collections as collection
            where collection.account_id = tweet.account_id
              and collection.tweet_id = tweet.id
              and collection.kind = ?
          )
        limit 1
      `,
			)
			.get(column === "liked" ? "likes" : "bookmarks"),
	);
	if (missingKinds.length === 0) {
		return;
	}

	const now = new Date().toISOString();
	const insert = db.prepare(`
    insert or ignore into tweet_collections (
      account_id, tweet_id, kind, collected_at, source, raw_json, updated_at
    )
    select account_id, id, ?, null, 'legacy', '{}', ?
    from tweets
    where
      case
        when ? = 'likes' then liked
        else bookmarked
      end = 1
  `);

	db.transaction(() => {
		for (const [kind] of missingKinds) {
			insert.run(kind, now, kind);
		}
	})();
}

function backfillTweetAccountEdges(db: Database) {
	const missing = db
		.prepare(
			`
      select 1
      from tweets as tweet
      where tweet.kind in ('home', 'mention', 'authored', 'search')
        and not exists (
          select 1
          from tweet_account_edges as edge
          where edge.account_id = tweet.account_id
            and edge.tweet_id = tweet.id
            and edge.kind = tweet.kind
        )
      limit 1
    `,
		)
		.get();
	if (!missing) {
		return;
	}

	const now = new Date().toISOString();
	db.prepare(`
    insert or ignore into tweet_account_edges (
      account_id, tweet_id, kind, first_seen_at, last_seen_at, seen_count,
      source, raw_json, updated_at
    )
    select
      account_id,
      id,
      kind,
      created_at,
      created_at,
      1,
      'legacy',
      '{}',
      ?
    from tweets
    where kind in ('home', 'mention', 'authored', 'search')
  `).run(now);
}

function ensureSchemaIndexes(db: Database) {
	db.exec(INDEX_SQL);
}

function normalizeTweetState(db: Database) {
	backfillTweetCollections(db);
	backfillTweetAccountEdges(db);
	db.exec(`
	  drop index if exists idx_tweets_kind_created;
	  drop index if exists idx_tweets_account_created;
	  alter table tweets rename to tweets_legacy_state;
	  create table tweets (
	    id text primary key,
	    author_profile_id text not null,
	    text text not null,
	    created_at text not null,
	    is_replied integer not null default 0,
	    reply_to_id text,
	    like_count integer not null default 0,
	    media_count integer not null default 0,
	    entities_json text not null default '{}',
	    media_json text not null default '[]',
	    quoted_tweet_id text,
	    deleted_at text,
	    deletion_source text,
	    deletion_reason text,
	    superseded_at text,
	    superseded_by_id text
	  );
	  insert into tweets (
	    id, author_profile_id, text, created_at, is_replied, reply_to_id,
	    like_count, media_count, entities_json, media_json, quoted_tweet_id,
	    deleted_at, deletion_source, deletion_reason, superseded_at, superseded_by_id
	  )
	  select
	    id, author_profile_id, text, created_at, is_replied, reply_to_id,
	    like_count, media_count, entities_json, media_json, quoted_tweet_id,
	    null, null, null, null, null
	  from tweets_legacy_state;
	  drop table tweets_legacy_state;
	  create index idx_tweets_created on tweets(created_at desc);
	  create index idx_tweets_quoted on tweets(quoted_tweet_id);
	`);
}

const DATABASE_MIGRATIONS: readonly DatabaseMigration[] = [
	{
		version: 1,
		name: "canonical schema baseline",
		up: (db) => {
			db.exec(BASE_SCHEMA_SQL);
			ensureAccountExternalUserIdColumn(db);
			ensureDmConversationInboxColumns(db);
			ensureTweetMetadataColumns(db);
			ensureProfileAvatarColumns(db);
			ensureTweetCollectionsTable(db);
			ensureTweetAccountEdgesTable(db);
			ensureProfileAffiliationsTable(db);
			ensureProfileSnapshotsTable(db);
			ensureProfileBioEntitiesTable(db);
			ensureIdentitySearchIndexTable(db);
			ensureLinkIndexTables(db);
			ensureFollowGraphTables(db);
			ensureSchemaIndexes(db);
			backfillTweetCollections(db);
			backfillTweetAccountEdges(db);
		},
	},
	{
		version: 2,
		name: "normalize tweet account and collection state",
		up: normalizeTweetState,
	},
	{
		version: 3,
		name: "add durable X List metadata and membership",
		up: (db) => {
			ensureXListTables(db);
		},
	},
	{
		version: 4,
		name: "index cached tweet reply traversal",
		up: (db) => {
			db.exec(
				"create index if not exists idx_tweets_reply_to on tweets(reply_to_id)",
			);
		},
	},
	{
		version: 5,
		name: "add durable tweet source provenance",
		up: ensureTweetSourcesTable,
	},
	{
		version: 6,
		name: "retain tweet deletions and observable revisions",
		up: ensureTweetRetentionSchema,
	},
];

function ensureDemoData(db: Database) {
	if (demoSeedAttempted) {
		return;
	}

	seedDemoData(db);
	demoSeedAttempted = true;
}

function shouldSeedDemoData(options: InitDatabaseOptions) {
	return (
		options.seedDemoData === true ||
		(options.seedDemoData === undefined &&
			process.env.BIRDCLAW_TEST_SEED_DEMO_DATA === "1")
	);
}

function initDatabase(options: InitDatabaseOptions = {}) {
	ensureBirdclawDirs();
	const seedDemo = shouldSeedDemoData(options);

	if (!nativeDb) {
		const { dbPath } = getBirdclawPaths();
		nativeDb = createDatabaseConnection(dbPath, "writer");
		nativeDb.exec(`
		  pragma journal_mode = wal;
		  pragma busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};
		  pragma foreign_keys = on;
		`);
		runDatabaseMigrations(nativeDb, DATABASE_MIGRATIONS);
		if (seedDemo) {
			ensureDemoData(nativeDb);
		}
	} else if (seedDemo) {
		ensureDemoData(nativeDb);
	}
}

function createDatabaseConnection(
	dbPath: string,
	role: DatabaseConnectionRole,
	options: { readonly?: boolean } = {},
) {
	return new NativeSqliteDatabase(dbPath, {
		...options,
		onStatement: (sql, durationMs) =>
			recordDatabaseStatement(role, sql, durationMs),
	});
}

function closeDatabaseIgnoringErrors(db: Database) {
	try {
		db.close();
	} catch {
		// Preserve the error that triggered cleanup.
	}
}

function createReadDatabaseConnection(dbPath: string) {
	const db = createDatabaseConnection(dbPath, "reader", { readonly: true });
	try {
		db.exec(`
		  pragma busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};
		  pragma foreign_keys = on;
		  pragma query_only = on;
		`);
		return db;
	} catch (error) {
		closeDatabaseIgnoringErrors(db);
		throw error;
	}
}

function createReadDatabasePool(
	dbPath: string,
	validateFirst?: (db: Database) => void,
) {
	const pool: Database[] = [];
	try {
		const first = createReadDatabaseConnection(dbPath);
		pool.push(first);
		validateFirst?.(first);
		pool.push(createReadDatabaseConnection(dbPath));
		return pool;
	} catch (error) {
		for (const db of pool) closeDatabaseIgnoringErrors(db);
		throw error;
	}
}

function assertCurrentDatabaseSchema(db: Database) {
	const expectedVersion = DATABASE_MIGRATIONS.at(-1)?.version ?? 0;
	const actualVersion = getDatabaseSchemaVersion(db);
	if (actualVersion !== expectedVersion) {
		throw new Error(
			`Birdclaw database schema ${String(actualVersion)} is not ready for version ${String(expectedVersion)}`,
		);
	}
}

function nextReadDb() {
	const db = readDbs[readDbIndex % readDbs.length] as Database;
	readDbIndex = (readDbIndex + 1) % readDbs.length;
	return db;
}

export function getNativeDb(options: InitDatabaseOptions = {}) {
	initDatabase(options);
	return nativeDb as Database;
}

export function getReadDb(options: InitDatabaseOptions = {}) {
	initDatabase(options);
	if (readDbs.length === 0) {
		const { dbPath } = getBirdclawPaths();
		readDbs = createReadDatabasePool(dbPath);
	}
	return nextReadDb();
}

export function getStrictReadDb() {
	if (readDbs.length > 0) {
		assertCurrentDatabaseSchema(readDbs[0] as Database);
		return nextReadDb();
	}
	const { dbPath } = getBirdclawPaths();
	if (!existsSync(dbPath)) {
		throw new Error("Birdclaw database is not initialized");
	}

	readDbs = createReadDatabasePool(dbPath, assertCurrentDatabaseSchema);
	return nextReadDb();
}

export function closeDatabase() {
	const native = nativeDb;
	const readers = readDbs;
	nativeDb = undefined;
	readDbs = [];
	readDbIndex = 0;
	demoSeedAttempted = false;

	for (const reader of readers) reader.close();
	native?.close();
}

export function resetDatabaseForTests() {
	const native = nativeDb;
	const readers = readDbs;
	nativeDb = undefined;
	readDbs = [];
	readDbIndex = 0;
	demoSeedAttempted = false;
	for (const reader of readers) reader.close();
	native?.close();
}
