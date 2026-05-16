# Data And Architecture

## Effect Runtime Boundary

Birdclaw's core I/O code should be written as Effect programs. Use `Effect.gen` for multi-step workflows, typed failures for expected errors, and `Effect.forEach` / `Effect.sleep` for concurrency, retry, timeout, and pacing logic.

Keep framework edges boring:

- CLI command handlers may `await` Promise wrappers.
- React components may call Promise wrappers from effects and event handlers.
- route handlers may return normal `Response` values.

Inside `src/lib`, prefer exporting both forms when useful:

```ts
export function runThingEffect(
	input: Input,
): Effect.Effect<Output, ThingError> {
	return Effect.gen(function* () {
		// core logic
	});
}

export function runThing(input: Input): Promise<Output> {
	return runEffectPromise(runThingEffect(input));
}
```

Use `runEffectPromise` from `src/lib/effect-runtime.ts` for Promise wrappers so typed failures are thrown directly instead of being hidden behind Effect fiber failures.

Current migrated surfaces:

- typed Effect-to-Promise boundary handling in `src/lib/effect-runtime.ts`
- web API client parsing and sync-job polling in `src/lib/api-client.ts`
- `bird` command availability and execution in `src/lib/bird-command.ts`
- `bird` JSON transport, large stdout capture, and temp-file cleanup in `src/lib/bird.ts`
- `xurl` command execution, JSON parsing, retry delay, mutation helpers, and public adapter wrappers in `src/lib/xurl.ts`
- backup export/import/validation, Git repo setup, pull, commit/push, stale auto-update, and auto-sync orchestration in `src/lib/backup.ts`
- moderation action transport fallback and bird action/profile adapter helpers in `src/lib/actions-transport.ts` and `src/lib/bird-actions.ts`
- moderation target resolution plus local blocks/mutes write helpers, remote block sync, and x-web block/unblock mutations in `src/lib/moderation-target.ts`, `src/lib/moderation-write.ts`, `src/lib/blocks-write.ts`, `src/lib/blocks.ts`, `src/lib/mutes-write.ts`, and `src/lib/x-web.ts`
- batch blocklist file import in `src/lib/blocklist.ts`
- authored, mentions, mention-thread sync including xurl recent-search and parent-walk fallback internals, conversation surface, home timeline, saved collection, DM live sync, profile hydration/resolution/affiliation, profile-reply inspection, shared tweet lookup, research and whois report generation, inbox scoring, and follow graph live sync cache/fetch/merge flows in `src/lib/authored-live.ts`, `src/lib/mentions-live.ts`, `src/lib/mention-threads-live.ts`, `src/lib/conversation-surface.ts`, `src/lib/timeline-live.ts`, `src/lib/timeline-collections-live.ts`, `src/lib/dms-live.ts`, `src/lib/profile-hydration.ts`, `src/lib/profile-affiliation-hydration.ts`, `src/lib/profile-resolver.ts`, `src/lib/profile-replies.ts`, `src/lib/tweet-lookup.ts`, `src/lib/research.ts`, `src/lib/whois.ts`, `src/lib/inbox.ts`, and `src/lib/follow-graph.ts`
- link preview metadata fetches and link-index backfill concurrency in `src/lib/link-preview-metadata.ts` and `src/lib/link-index.ts`
- `media fetch` archive reuse, HTTP download groups, pacing, and bounded concurrency in `src/lib/media-fetch.ts`
- archive discovery and archive-import subprocess boundaries in `src/lib/archive-finder.ts` and `src/lib/archive-import.ts`
- avatar read-through caching and URL expansion cache/fetch flows in `src/lib/avatar-cache.ts` and `src/lib/url-expansion.ts`
- OpenAI inbox scoring fetch/parse boundary in `src/lib/openai.ts`
- scheduled bookmark sync audit logging, overlap locking, backup pass, and launchd install in `src/lib/bookmark-sync-job.ts`
- web sync orchestration, plan runners, backup pass, and job polling in `src/lib/web-sync.ts`

Production `src/lib` code should stay free of ad hoc `async`/`await` orchestration. Next migrations should target remaining CLI, React, and route edges only where an Effect boundary would simplify error handling, cancellation, retries, or concurrency; otherwise keep those framework adapters as small Promise wrappers over core Effect programs.

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
import type { Effect } from "effect";

type TransportTask<A, E = TransportError> = Effect.Effect<A, E>;
type TransportKind = "archive" | "xurl" | "bird" | "official" | "xweb";

interface BirdTransport {
	kind: TransportKind;
	capabilities(): TransportTask<TransportCapabilities>;
	currentUser(): TransportTask<AccountIdentity>;
	listBookmarks(input: CursorInput): TransportTask<Page<BookmarkRecord>>;
	listLikes(input: CursorInput): TransportTask<Page<LikeRecord>>;
	listMentions(input: CursorInput): TransportTask<Page<TweetRecord>>;
	listFollowers(input: CursorInput): TransportTask<Page<ProfileRecord>>;
	listFollowing(input: CursorInput): TransportTask<Page<ProfileRecord>>;
	listUserTweets(input: UserTimelineInput): TransportTask<Page<TweetRecord>>;
	listDmEvents(input: DmEventsInput): TransportTask<Page<DmEventRecord>>;
	getTweet(id: string): TransportTask<TweetRecord | null>;
	postTweet(input: ComposeTweetInput): TransportTask<PostResult>;
	reply(input: ReplyInput): TransportTask<PostResult>;
	blockProfile(input: ProfileActionInput): TransportTask<ActionResult>;
	unblockProfile(input: ProfileActionInput): TransportTask<ActionResult>;
	muteProfile(input: ProfileActionInput): TransportTask<ActionResult>;
	unmuteProfile(input: ProfileActionInput): TransportTask<ActionResult>;
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
  - Twitter users/authors/participants
  - keep bio, follower/following counts, profile URL, location, verification type, structured URL entities, raw profile JSON, and lightweight influence fields queryable in canonical columns
  - DM surfaces should render sender bio and influence context from here without needing raw payload lookups
- `profile_affiliations`
  - active subject-to-organization affiliation edges from X profile badges / highlighted labels
  - stores organization id or deterministic synthetic id, label, handle, badge URL, URL, source, and first/last-seen timestamps
  - synthetic highlighted-label ids are upgraded to real local organization profile ids when `bird` can hydrate the org handle
- `profile_snapshots`
  - deduplicated history of hydrated profile identity fields
  - stores bio, display name, handle, location, profile URL, verification type, counts, active affiliations, raw JSON, and first/last seen timestamps per state
  - lets `whois` explain current-vs-former affiliation or bio evidence instead of losing overwritten profile text
- `profile_bio_entities`
  - first-class extracted identity hints from profile bio/URL/affiliations
  - stores active and inactive `handle`, `domain`, and `company_phrase` values with first/last seen timestamps
  - feeds fuzzy identity ranking for prompts such as `blacksmith guy`, where `@useblacksmith` or `blacksmith.sh` is stronger than a generic DM keyword
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
  - current complete directional graph for `followers` and `following`
- `follow_snapshots`
  - snapshot metadata for follower/following crawls, including complete/incomplete status
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

- Conceptual `inbound`: they follow the account
- Conceptual `outbound`: the account follows them
- Stored/API `followers`: inbound direction, matching the X endpoint and CLI command
- Stored/API `following`: outbound direction, matching the X endpoint and CLI command

### Tables

- `follow_edges`
  - primary key: `(account_id, direction, profile_id)`
  - `account_id` is the observer account; `profile_id` is the subject profile
  - fields: `current`, `first_seen_at`, `last_seen_at`, `ended_at`, `source`, `updated_at`
- `follow_snapshots`
  - one row per full followers/following crawl
  - fields: `direction`, `status`, `page_count`, `result_count`, `source`, `raw_meta_json`
- `follow_snapshot_members`
  - normalized set of members per snapshot
- `follow_events`
  - append-only `started` / `ended`
  - references snapshot/run when available
  - idempotent per account

### Cache and cost guardrails

- `sync followers` and `sync following` default to dry-run and do not call X
- live xurl sync requires `--yes`
- fresh sync results are stored in `sync_cache` and reused by matching sync commands unless `--refresh` is passed
- graph query commands only read `follow_edges`, `follow_snapshots`, `follow_snapshot_members`, `follow_events`, and `profiles`
- incomplete snapshots keep fetched members for audit but do not update current edges or churn events

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

- Twitter export zip
- extracted archive directory

### Supported archive slices in v1

- account
- tweets
- likes
- bookmarks if present
- profiles
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
- full import refreshes all supported archive slices together
- selected import refreshes only requested slices and preserves unselected local data
- selected import validates `acct_primary` identity before writing
- selected collection imports preserve live collection rows and local tweet ownership
- selected DM imports are scoped to `acct_primary` and preserve other accounts

Selected import slices:

- `tweets`
- `likes`
- `bookmarks`
- `profiles`
- `directMessages`
- `followers`
- `following`

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
  - direct Twitter API client
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
