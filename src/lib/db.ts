import BetterSqlite3 from "better-sqlite3";
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
	avatar_hue: number;
	avatar_url: string | null;
	created_at: string;
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

export interface BirdclawDatabase {
	accounts: AccountsTable;
	profiles: ProfilesTable;
	tweets: TweetsTable;
	tweet_collections: TweetCollectionsTable;
	dm_conversations: DmConversationsTable;
	dm_messages: DmMessagesTable;
	tweet_actions: TweetActionsTable;
	blocks: BlocksTable;
	mutes: MutesTable;
	ai_scores: AiScoresTable;
	sync_cache: SyncCacheTable;
}

let nativeDb: BetterSqlite3.Database | undefined;
let kyselyDb: Kysely<BirdclawDatabase> | undefined;

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
    avatar_hue integer not null default 0,
    avatar_url text,
    created_at text not null
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
  create index if not exists idx_dm_conversations_account on dm_conversations(account_id, last_message_at desc);
  create index if not exists idx_dm_messages_conversation on dm_messages(conversation_id, created_at asc);
  create index if not exists idx_profiles_followers on profiles(followers_count desc);
  create index if not exists idx_blocks_account_created on blocks(account_id, created_at desc);
  create index if not exists idx_mutes_account_created on mutes(account_id, created_at desc);
  create index if not exists idx_ai_scores_updated on ai_scores(updated_at desc);
  create index if not exists idx_sync_cache_updated on sync_cache(updated_at desc);
`;

function getColumnNames(
	db: BetterSqlite3.Database,
	tableName: string,
): Set<string> {
	const rows = db.prepare(`pragma table_info(${tableName})`).all() as Array<{
		name: string;
	}>;
	return new Set(rows.map((row) => row.name));
}

function ensureTweetMetadataColumns(db: BetterSqlite3.Database) {
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

function ensureProfileAvatarColumns(db: BetterSqlite3.Database) {
	const columnNames = getColumnNames(db, "profiles");
	if (!columnNames.has("avatar_url")) {
		db.exec("alter table profiles add column avatar_url text");
	}
}

function ensureAccountExternalUserIdColumn(db: BetterSqlite3.Database) {
	const columnNames = getColumnNames(db, "accounts");
	if (!columnNames.has("external_user_id")) {
		db.exec("alter table accounts add column external_user_id text");
	}
}

function ensureTweetCollectionsTable(db: BetterSqlite3.Database) {
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

function backfillTweetCollections(db: BetterSqlite3.Database) {
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

function ensureSchemaIndexes(db: BetterSqlite3.Database) {
	db.exec(INDEX_SQL);
}

function initDatabase() {
	ensureBirdclawDirs();

	if (!nativeDb) {
		const { dbPath } = getBirdclawPaths();
		nativeDb = new BetterSqlite3(dbPath);
		nativeDb.exec(BASE_SCHEMA_SQL);
		ensureAccountExternalUserIdColumn(nativeDb);
		ensureTweetMetadataColumns(nativeDb);
		ensureProfileAvatarColumns(nativeDb);
		ensureTweetCollectionsTable(nativeDb);
		ensureSchemaIndexes(nativeDb);
		seedDemoData(nativeDb);
		backfillTweetCollections(nativeDb);
	}

	if (!kyselyDb) {
		kyselyDb = new Kysely<BirdclawDatabase>({
			dialect: new SqliteDialect({
				database: nativeDb,
			}),
		});
	}
}

export function getNativeDb() {
	initDatabase();
	return nativeDb as BetterSqlite3.Database;
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
