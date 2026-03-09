# Data And Architecture

## Transport Strategy

Support these adapters:
- `xurl`
- `bird`
- official API

Optional later:
- lower-level `xweb`

### Recommendation

v1 transport priority:

1. `archive`
2. `xurl`
3. `bird`
4. official direct API
5. optional lower-level `xweb`

Reason:
- working `xurl` already exists
- users with `xurl` setup get zero-friction sync
- `bird` can cover GraphQL/cookie-backed gaps if needed
- official API adapter keeps long-term independence

### `xurl` compatibility

Important stance:
- do not "pretend to be xurl" by mutating or owning `~/.xurl` format in v1
- shell out to `xurl` as an adapter instead

Why:
- lower auth risk
- lower coupling to xurl store internals
- birdclaw stays transport-agnostic
- users already authenticated in `xurl` get immediate value

Possible later feature:
- `birdclaw auth import-xurl`
- local one-shot import into birdclaw-managed credentials
- opt-in only

### `bird` compatibility

Treat `bird` the same way:
- adapter, not architecture
- subprocess or wrapper boundary
- no dependency on `bird` config/storage as core truth
- useful for GraphQL/cookie-backed reads or actions when `xurl` does not cover a surface

### Transport interface

```ts
type TransportKind = 'archive' | 'xurl' | 'bird' | 'official' | 'xweb';

interface BirdTransport {
  kind: TransportKind;
  capabilities(): Promise<TransportCapabilities>;
  currentUser(): Promise<AccountIdentity>;
  listBookmarks(input: CursorInput): Promise<Page<BookmarkRecord>>;
  listLikes(input: CursorInput): Promise<Page<LikeRecord>>;
  listMentions(input: CursorInput): Promise<Page<TweetRecord>>;
  listFollowers(input: CursorInput): Promise<Page<ProfileRecord>>;
  listFollowing(input: CursorInput): Promise<Page<ProfileRecord>>;
  listUserTweets(input: UserTimelineInput): Promise<Page<TweetRecord>>;
  listDmEvents(input: DmEventsInput): Promise<Page<DmEventRecord>>;
  getTweet(id: string): Promise<TweetRecord | null>;
  postTweet(input: ComposeTweetInput): Promise<PostResult>;
  reply(input: ReplyInput): Promise<PostResult>;
  blockProfile(input: ProfileActionInput): Promise<ActionResult>;
  unblockProfile(input: ProfileActionInput): Promise<ActionResult>;
  muteProfile(input: ProfileActionInput): Promise<ActionResult>;
  unmuteProfile(input: ProfileActionInput): Promise<ActionResult>;
}
```

### Transport config

Per account:
- preferred transport: `auto | xurl | bird | official | xweb`
- fallback chain
- capability cache
- auth status snapshot

`auto` means:
- use `xurl` if available and healthy
- else use `bird` if available and healthy
- else use official auth if configured
- else archive-only mode

## Data Model

SQLite only. Kysely schema in code, migrations checked into repo.

### Core tables

- `accounts`
  - local account metadata
  - preferred transport
  - sync defaults
- `profiles`
  - X users/authors/participants
  - keep bio, follower count, and lightweight influence fields queryable in canonical columns
  - DM surfaces should render sender bio and influence context from here without needing raw payload lookups
- `blocks`
  - account-scoped local blocklist
  - canonical local state for blocklist UI and CLI
- `mutes`
  - account-scoped local mutelist
  - canonical local state for CLI moderation actions
  - live transport result layered on top, not required for local bookkeeping
- `tweets`
  - canonical tweet rows
  - text, metrics, timestamps, references, author id
  - raw JSON payload column
- `tweet_media`
- `tweet_urls`
- `tweet_mentions`
- `follow_edges`
  - current directional graph
- `follow_snapshots`
  - snapshot metadata for follower/following crawls
- `follow_snapshot_members`
  - normalized membership per snapshot
- `follow_events`
  - append-only started/ended follow events
- `bookmarks`
  - account-scoped saved tweet ids
- `likes`
  - account-scoped liked tweet ids
- `threads`
  - optional thread/cache grouping
- `dm_conversations`
- `dm_events`
  - event log, not only message text
- `dm_participants`
- `dm_payloads`
  - full text / URLs / reactions / attachments when retained
- `sync_cursors`
  - one row per stream + transport + account + scope
- `import_runs`
- `sync_runs`
- `raw_objects`
  - optional retained source payloads for reparsing

### Search tables

- `tweets_fts`
- `dm_fts`

Use FTS5.

Day-1 search modes:
- exact filters
- keyword full-text
- date ranges
- author / conversation / bookmarked / liked filters
- DM sender follower-count filters
- DM sender derived influence-score filters
- replied / unreplied filters for mentions and DMs
- local block/mute maintenance via handle, id, or URL-derived profile match

No vector search required for MVP.

### Indexing

Indexes from day 1:
- tweet id unique
- author + created_at desc
- created_at desc
- conversation + occurred_at desc
- bookmark/account + created_at desc
- like/account + created_at desc
- active follow edges by observer + direction
- follow events by observer + event_at desc
- latest follow snapshot by observer + type
- sync cursor unique by stream/account/scope/transport

## Follow Graph Model

Borrow the shape from `sweetistics`, but local-first and SQLite-native.

Principles:
- directional edges, not dual booleans
- snapshots are the source of truth for full crawls
- events are append-only
- current state and history both matter

### Direction semantics

- `inbound`: they follow me
- `outbound`: I follow them

### Tables

- `follow_edges`
  - primary key: `(account_id, observer_profile_id, subject_profile_id, direction)`
  - fields: `is_active`, `first_seen_at`, `last_seen_at`, `created_at`, `updated_at`
- `follow_snapshots`
  - one row per full followers/following crawl
  - fields: `type`, `complete`, `page_count`, `item_count`, `source`
- `follow_snapshot_members`
  - normalized set of members per snapshot
- `follow_events`
  - append-only `started` / `ended`
  - references snapshot/run when available
  - idempotent per account

### What this buys us

- current followers/following lists
- mutuals
- churn over time
- "who came in"
- "who left"
- first seen / last seen
- account growth graph
- graph-aware AI ranking later

### UI ideas

- follows dashboard
- arrivals / departures timeline
- mutuals view
- notable churn
- relationship detail for one profile
- graph overlays in the AI inbox

## Archive Import

### Inputs

- Twitter/X export zip
- extracted archive directory

### Supported archive slices in v1

- account
- tweets
- likes
- bookmarks if present
- direct messages
- followers
- following

### Import pipeline

1. inspect manifest / discover files
2. parse wrapper JS payloads
3. normalize records
4. write canonical entities
5. update import provenance
6. refresh FTS

### Rules

- idempotent reruns
- preserve richer existing data
- raw source retained optionally
- support metadata-only vs full-body DM storage policy

DM default:
- `full`

## Sync Model

Streams:
- own tweets
- mentions
- likes
- bookmarks
- DMs
- followers
- following

Future:
- notifications
- list timelines
- graph analytics

### Sync behavior

- cursor-based where possible
- account-scoped checkpoints
- dedupe on canonical IDs
- partial success preserved
- safe rerun after crash

## Local Web App

### Purpose

Primary human UI.

### Views

- inbox
  - AI-ranked blend of mentions, replies, DMs, bookmarks to revisit, notable posts
- timeline/search
- tweet detail
- thread detail
- DM conversation
- DM conversation
  - persistent sender context with bio and follower count
  - filter by sender influence band
  - filter replied vs unreplied
- bookmarks
- likes
- follows dashboard
- mutuals
- follow event history
- sync status
- account/auth/transports
- compose/reply

### AI layer

Local-first ranking metadata stored in DB:
- score
- reason codes
- summary
- labels
- dismissed state
- acted-on state

Candidate ranking inputs:
- author importance
- sender follower count / influence
- sender bio cues
- reply intent
- mention density
- follower relationship
- conversation recency
- prior engagement
- bookmark/like overlap
- DM priority
- follow-graph proximity
- churn salience

### Web server mode

`birdclaw serve`
- starts local server
- starts background sync automatically by default
- opens browser unless `--no-open`
- exposes sync health and recent job state in the UI

## Profiles / Accounts

Support profiles from day 1.

Reason:
- separate DBs or configs for personal/test/future shared use
- easier OSS story

Default:
- one profile named `default`

## Auth / Secrets

Do not store secrets in config JSON.

Options by transport:

- `xurl`
  - birdclaw shells out to `xurl`
  - auth remains managed by `xurl`
- `bird`
  - birdclaw shells out to `bird` or wraps a narrow stable surface
  - useful for GraphQL/cookie-backed capabilities
- `official`
  - birdclaw stores tokens securely
  - keychain if available, encrypted local store otherwise
- `xweb`
  - explicit low-level escape hatch if needed later

## Package Layout

```text
birdclaw/
  apps/
    web/
  packages/
    archive/
    cli/
    core/
    db/
    server/
    transport-bird/
    transport-official/
    transport-xurl/
    transport-xweb/
    ui/
  docs/
    spec.md
    cli.md
    data-architecture.md
```

### Package responsibilities

- `core`
  - domain types
  - sync contracts
  - ranking contracts
- `archive`
  - archive parsers and normalizers
- `db`
  - Kysely schema
  - migrations
  - repositories
  - FTS helpers
  - DM influence and replied/unreplied query helpers
- `transport-xurl`
  - `xurl` detection
  - subprocess exec wrappers
  - output parsing
- `transport-bird`
  - `bird` detection
  - subprocess exec wrappers
  - GraphQL-focused reads/actions
- `transport-official`
  - direct X API client
- `transport-xweb`
  - optional cookie/graphql mode
- `server`
  - local app API
  - background sync orchestration
- `cli`
  - command surface
- `ui`
  - React components, inbox, thread, DM views
  - compact sender bio / influence surfaces for DM context
- `apps/web`
  - TanStack Start app shell

## Testing Plan

### Unit

- archive file parsing
- domain normalization
- SQL repositories
- FTS queries
- ranker behavior

### Integration

- import fixture archive into temp DB
- sync fixture pages into temp DB
- run search queries against populated DB
- verify `xurl` adapter against stubbed subprocess output
- verify follow graph snapshot -> diff -> events behavior

### Live

Opt-in only:
- real `xurl` health check
- real `bird` health check
- real sync smoke tests

## Distribution

Primary:
- npm package

Secondary later:
- standalone desktop wrapper if the web UX becomes primary
