import BetterSqlite3 from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { ensureBirdclawDirs, getBirdclawPaths } from "./config";
import { seedDemoData } from "./seed";

export interface AccountsTable {
	id: string;
	name: string;
	handle: string;
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

export interface AiScoresTable {
	entity_kind: string;
	entity_id: string;
	model: string;
	score: number;
	summary: string;
	reasoning: string;
	updated_at: string;
}

export interface BirdclawDatabase {
	accounts: AccountsTable;
	profiles: ProfilesTable;
	tweets: TweetsTable;
	dm_conversations: DmConversationsTable;
	dm_messages: DmMessagesTable;
	tweet_actions: TweetActionsTable;
	blocks: BlocksTable;
	ai_scores: AiScoresTable;
}

let nativeDb: BetterSqlite3.Database | undefined;
let kyselyDb: Kysely<BirdclawDatabase> | undefined;

const SCHEMA_SQL = `
  pragma journal_mode = wal;
  pragma foreign_keys = on;

  create table if not exists accounts (
    id text primary key,
    name text not null,
    handle text not null unique,
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
    liked integer not null default 0
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

  create virtual table if not exists tweets_fts using fts5(
    tweet_id unindexed,
    text
  );

  create virtual table if not exists dm_fts using fts5(
    message_id unindexed,
    text
  );

  create index if not exists idx_tweets_kind_created on tweets(kind, created_at desc);
  create index if not exists idx_tweets_account_created on tweets(account_id, created_at desc);
  create index if not exists idx_dm_conversations_account on dm_conversations(account_id, last_message_at desc);
  create index if not exists idx_dm_messages_conversation on dm_messages(conversation_id, created_at asc);
  create index if not exists idx_profiles_followers on profiles(followers_count desc);
  create index if not exists idx_blocks_account_created on blocks(account_id, created_at desc);
  create index if not exists idx_ai_scores_updated on ai_scores(updated_at desc);
`;

function initDatabase() {
	ensureBirdclawDirs();

	if (!nativeDb) {
		const { dbPath } = getBirdclawPaths();
		nativeDb = new BetterSqlite3(dbPath);
		nativeDb.exec(SCHEMA_SQL);
		seedDemoData(nativeDb);
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
