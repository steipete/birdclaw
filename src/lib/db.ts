import NativeSqliteDatabase, { type Database } from "./sqlite";
import { Kysely, SqliteDialect } from "kysely";
import { ensureBirdclawDirs, getBirdclawPaths } from "./config";
import { seedDemoData } from "./seed";

export interface AccountsTable {
	id: string;
	name: string;
	handle: string;
	external_user_id: string | null;
	transport: string;
	is_default: number;
	created_at: string;
}

export interface ProfilesTable {
	id: string;
	handle: string;
	display_name: string;
	bio: string;
	followers_count: number;
	following_count: number;
	avatar_hue: number;
	avatar_url: string | null;
	location: string | null;
	url: string | null;
	verified_type: string | null;
	entities_json: string;
	raw_json: string;
	created_at: string;
}

export interface ProfileAffiliationsTable {
	subject_profile_id: string;
	organization_profile_id: string;
	organization_name: string | null;
	organization_handle: string | null;
	badge_url: string | null;
	url: string | null;
	label: string | null;
	source: string;
	is_active: number;
	first_seen_at: string;
	last_seen_at: string;
	raw_json: string;
	updated_at: string;
}

export interface ProfileSnapshotsTable {
	profile_id: string;
	snapshot_hash: string;
	observed_at: string;
	last_seen_at: string;
	source: string;
	handle: string;
	display_name: string;
	bio: string;
	location: string | null;
	url: string | null;
	verified_type: string | null;
	followers_count: number;
	following_count: number;
	affiliations_json: string;
	raw_json: string;
}

export interface ProfileBioEntitiesTable {
	profile_id: string;
	kind: string;
	value: string;
	source: string;
	is_active: number;
	first_seen_at: string;
	last_seen_at: string;
	raw_json: string;
}

export interface IdentitySearchIndexTable {
	profile_id: string;
	kind: string;
	value: string;
	normalized_value: string;
	source: string;
	weight: number;
	updated_at: string;
}

export interface TweetsTable {
	id: string;
	account_id: string;
	author_profile_id: string;
	kind: string;
	text: string;
	created_at: string;
	is_replied: number;
	reply_to_id: string | null;
	like_count: number;
	media_count: number;
	bookmarked: number;
	liked: number;
	entities_json: string;
	media_json: string;
	quoted_tweet_id: string | null;
}

export interface TweetCollectionsTable {
	account_id: string;
	tweet_id: string;
	kind: "likes" | "bookmarks";
	collected_at: string | null;
	source: string;
	raw_json: string;
	updated_at: string;
}

export interface TweetAccountEdgesTable {
	account_id: string;
	tweet_id: string;
	kind: "home" | "mention";
	first_seen_at: string;
	last_seen_at: string;
	seen_count: number;
	source: string;
	raw_json: string;
	updated_at: string;
}

export interface DmConversationsTable {
	id: string;
	account_id: string;
	participant_profile_id: string;
	title: string;
	last_message_at: string;
	unread_count: number;
	needs_reply: number;
}

export interface DmMessagesTable {
	id: string;
	conversation_id: string;
	sender_profile_id: string;
	text: string;
	created_at: string;
	direction: "inbound" | "outbound";
	is_replied: number;
	media_count: number;
}

export interface TweetActionsTable {
	id: string;
	account_id: string;
	tweet_id: string | null;
	kind: string;
	body: string;
	created_at: string;
}

export interface BlocksTable {
	account_id: string;
	profile_id: string;
	source: string;
	created_at: string;
}

export interface MutesTable {
	account_id: string;
	profile_id: string;
	source: string;
	created_at: string;
}

export interface AiScoresTable {
	entity_kind: string;
	entity_id: string;
	model: string;
	score: number;
	summary: string;
	reasoning: string;
	updated_at: string;
}

export interface SyncCacheTable {
	cache_key: string;
	value_json: string;
	updated_at: string;
}

export interface UrlExpansionsTable {
	short_url: string;
	expanded_url: string;
	final_url: string;
	status: string;
	expanded_tweet_id: string | null;
	expanded_handle: string | null;
	title: string | null;
	description: string | null;
	image_url: string | null;
	site_name: string | null;
	error: string | null;
	source: string;
	updated_at: string;
}

export interface LinkOccurrencesTable {
	source_kind: "dm" | "tweet";
	source_id: string;
	source_position: number;
	short_url: string;
	account_id: string | null;
	conversation_id: string | null;
	direction: string | null;
	created_at: string;
}

export interface BirdclawDatabase {
	accounts: AccountsTable;
	profiles: ProfilesTable;
	profile_affiliations: ProfileAffiliationsTable;
	profile_snapshots: ProfileSnapshotsTable;
	profile_bio_entities: ProfileBioEntitiesTable;
	identity_search_index: IdentitySearchIndexTable;
	tweets: TweetsTable;
	tweet_collections: TweetCollectionsTable;
	tweet_account_edges: TweetAccountEdgesTable;
	dm_conversations: DmConversationsTable;
	dm_messages: DmMessagesTable;
	tweet_actions: TweetActionsTable;
	blocks: BlocksTable;
	mutes: MutesTable;
	ai_scores: AiScoresTable;
	sync_cache: SyncCacheTable;
	url_expansions: UrlExpansionsTable;
	link_occurrences: LinkOccurrencesTable;
}

let nativeDb: Database | undefined;
let kyselyDb: Kysely<BirdclawDatabase> | undefined;

export interface InitDatabaseOptions {
	seedDemoData?: boolean;
}

const BASE_SCHEMA_SQL = `
  pragma journal_mode = wal;
  pragma busy_timeout = 5000;
  pragma foreign_keys = on;

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
    quoted_tweet_id text
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
  create index if not exists idx_tweets_account_created on tweets(account_id, created_at desc);
  create index if not exists idx_tweets_quoted on tweets(quoted_tweet_id);
  create index if not exists idx_tweet_collections_kind_account on tweet_collections(kind, account_id, collected_at desc, tweet_id);
  create index if not exists idx_tweet_collections_tweet on tweet_collections(tweet_id);
  create index if not exists idx_tweet_account_edges_kind_account on tweet_account_edges(kind, account_id, last_seen_at desc, tweet_id);
  create index if not exists idx_tweet_account_edges_tweet on tweet_account_edges(tweet_id);
  create index if not exists idx_dm_conversations_account on dm_conversations(account_id, last_message_at desc);
  create index if not exists idx_dm_messages_conversation on dm_messages(conversation_id, created_at asc);
  create index if not exists idx_profiles_followers on profiles(followers_count desc);
  create index if not exists idx_profiles_following on profiles(following_count desc);
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
}

function ensureAccountExternalUserIdColumn(db: Database) {
	const columnNames = getColumnNames(db, "accounts");
	if (!columnNames.has("external_user_id")) {
		db.exec("alter table accounts add column external_user_id text");
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

function backfillTweetCollections(db: Database) {
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
		insert.run("likes", now, "likes");
		insert.run("bookmarks", now, "bookmarks");
	})();
}

function backfillTweetAccountEdges(db: Database) {
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
    where kind in ('home', 'mention')
  `).run(now);
}

function ensureSchemaIndexes(db: Database) {
	db.exec(INDEX_SQL);
}

function initDatabase(options: InitDatabaseOptions = {}) {
	ensureBirdclawDirs();

	if (!nativeDb) {
		const { dbPath } = getBirdclawPaths();
		nativeDb = new NativeSqliteDatabase(dbPath);
		nativeDb.exec(BASE_SCHEMA_SQL);
		ensureAccountExternalUserIdColumn(nativeDb);
		ensureTweetMetadataColumns(nativeDb);
		ensureProfileAvatarColumns(nativeDb);
		ensureTweetCollectionsTable(nativeDb);
		ensureTweetAccountEdgesTable(nativeDb);
		ensureProfileAffiliationsTable(nativeDb);
		ensureProfileSnapshotsTable(nativeDb);
		ensureProfileBioEntitiesTable(nativeDb);
		ensureIdentitySearchIndexTable(nativeDb);
		ensureLinkIndexTables(nativeDb);
		ensureSchemaIndexes(nativeDb);
		if (options.seedDemoData !== false) {
			seedDemoData(nativeDb);
		}
		backfillTweetCollections(nativeDb);
		backfillTweetAccountEdges(nativeDb);
	}

	if (!kyselyDb) {
		kyselyDb = new Kysely<BirdclawDatabase>({
			dialect: new SqliteDialect({
				database: nativeDb,
			}),
		});
	}
}

export function getNativeDb(options: InitDatabaseOptions = {}) {
	initDatabase(options);
	return nativeDb as Database;
}

export function getDb() {
	initDatabase();
	return kyselyDb as Kysely<BirdclawDatabase>;
}

export function resetDatabaseForTests() {
	kyselyDb?.destroy();
	kyselyDb = undefined;

	nativeDb?.close();
	nativeDb = undefined;
}
