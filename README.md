# birdclaw 🪶 — Local Twitter memory in SQLite: archives, DMs, likes, bookmarks

`birdclaw` is a local-first Twitter workspace: archive import, cached live reads, focused triage, and reply flows in one local web app + CLI. Built by [@steipete](https://github.com/steipete/).

Status: WIP. Real and usable. Not done. Expect schema churn, transport gaps, and rough edges while the core settles.

## What It Does

- keeps your Twitter data in local SQLite
- stores media and avatar cache under `~/.birdclaw`
- imports archives when you have them
- still works when you do not
- gives you a clean local UI for home, mentions, DMs, inbox, and blocks
- exposes scriptable JSON for agents and automation

## What Works Today

### Local data + storage

- one shared SQLite DB for multiple accounts, with canonical tweets/profiles and account-scoped timeline/collection edges
- FTS5 search over tweets and DMs
- archive autodiscovery on macOS
- archive import for tweets, likes, followers/following, profiles, and full DMs
- selective archive re-imports for one stale slice without wiping the rest of the local store
- archive import for bookmark exports when present
- archive import streams bundled media files into the local originals cache and extracts `video_info.variants[]` for video and animated-GIF rows
- live authored sync through `xurl`, plus likes and bookmarks through `xurl` or `bird`
- cache-first followers/following sync through `bird` or `xurl`
- local follow graph queries for top followers, unfollows, mutuals, and non-mutual following
- Git-friendly text backups with yearly tweet shards and per-conversation DM shards
- profile hydration from live Twitter metadata
- profile-change history, affiliation badge edges, and extracted bio entities for local identity lookups
- local avatar cache
- local media cache root under `~/.birdclaw`
- live syncers persist tweet media variants so `media fetch` can pull originals from `pbs.twimg.com` and `video.twimg.com` on a separate schedule
- `media fetch` reuses bytes already extracted by `import archive` before falling back to CDN

### Web UI

- `Home` timeline
- `Mentions` queue
- `Likes` and `Bookmarks` review lanes
- `Links` for Hacker News-style top URLs, video-provider links, and the comments around them across today/week/month/year/all-time windows
- `DMs` workspace with two-column layout
- `Inbox` for mixed mention + DM triage
- `Blocks` for local blocklist maintenance
- constrained timeline lane instead of full-width dashboard UI
- tweet expansion with URLs, inline images, quoted tweets, replies, and profile hover cards
- sender bio and influence context in the DM detail header
- system / light / dark theme switcher with animated transition

### Triage + filtering

- replied / unreplied filters for timelines
- DM filters by participant, followers, and derived influence score
- AI-ranked inbox for mentions + DMs
- OpenAI scoring hook for low-signal filtering
- cached live mentions export in `xurl`-compatible JSON
- liked/bookmarked tweet filters for archive and live-synced collections
- live profile-reply inspection for borderline AI/slop triage
- one-shot blocklist import from a file for batch moderation passes

### Actions

- post tweets
- reply to tweets
- reply to DMs
- add / remove local blocks
- import batch blocklists in one call
- add / remove local mutes
- sync remote blocks through `xurl` when available
- fall back to the Twitter web cookie session when OAuth2 block writes are rejected

### Safety

- local-first by default
- tests disable live writes
- CI disables live writes
- app has no auth layer because it is a local-only tool

### Runtime Architecture

Birdclaw uses [Effect](https://effect.website/) for new and migrated I/O-heavy internals. The current Effect boundary covers browser API fetches, web sync orchestration, sync-job polling, `bird`/`xurl` subprocess helpers and public adapters, backup export/import/validation and Git orchestration, moderation action transport and target resolution, `bird` action/profile adapters, blocks/mutes write helpers, remote block sync, batch blocklist imports, x-web mutations, authored/mentions/mention-thread sync including xurl recent-search and parent-walk fallback internals, conversation loading, home timeline, saved collection, DM live sync, profile hydration/resolution/affiliation/reply inspection, shared tweet lookup, research and whois report generation, follow graph live sync, link preview/index fetches, archive discovery/import subprocesses, avatar/URL caches, OpenAI/inbox scoring, scheduled bookmark sync locking/audit/launchd install, and the paced/concurrent `media fetch` archive-reuse and HTTP download pipeline.

Public CLI and React call sites still expose plain `Promise` wrappers where that keeps the surrounding framework code simple. New core code should prefer `Effect` programs with typed error values, then add a Promise wrapper only at the outer CLI, route, or component boundary.

## Still In Progress

- broader resumable live sync beyond the targeted paths already wired
- thumbnail generation on top of the originals cache
- richer multi-account UX
- more complete transport coverage
- more archive edge-case handling

If you need polished product-grade sync parity today, this is not there yet.

## Screens

- `Home`: read and reply without fighting the main Twitter timeline
- `What happened`: stream an AI digest for today, 24h, yesterday, or week
- `Mentions`: work the reply queue with clean filters
- `Likes` / `Bookmarks`: revisit saved posts from archive or live sync
- `DMs`: triage by sender context, follower count, and influence
- `Inbox`: let heuristics / OpenAI float likely-important items
- `Blocks`: maintain a local-first account-scoped blocklist

## Storage

Default root:

```text
~/.birdclaw
```

Important paths:

- DB: `~/.birdclaw/birdclaw.sqlite`
- media cache: `~/.birdclaw/media`
- archive-extracted media: `~/.birdclaw/media/originals/archive/<kind>/<id>/<filename>` where `<kind>` is one of `tweets`, `dms`, `community`, `deleted`, `profile`, `moments`, `dmGroup`
- avatar cache: `~/.birdclaw/media/thumbs/avatars`
- Playwright test home: `.playwright-home`

Override the root:

```bash
export BIRDCLAW_HOME=/path/to/custom/root
```

### Media fetch

`birdclaw media fetch` fills the local originals cache at
`~/.birdclaw/media/originals/<media_key>.<ext>` for tweet media URLs already
stored in `tweets.media_json`. Images come from `pbs.twimg.com`, videos and
animated GIFs from `video.twimg.com` (highest-bitrate mp4 variant; HLS-only
media is skipped).

Live syncers (`sync mentions`, `sync mention-threads`, `sync likes`, `sync
bookmarks`, `sync timeline`) persist `media_json` with `variants[]` ride-along
metadata so `media fetch` has URLs to download from. Archive-imported tweets
already carry that shape. Before falling back to HTTP, `media fetch` looks for
bytes already extracted by `import archive` under
`~/.birdclaw/media/originals/archive/tweets/<tweetId>/` and copies those into
the canonical path; reuses are counted in the JSON output as
`reused_from_archive` and never spend CDN bandwidth.

Legal posture: this is a respectful client-rendering cache, not a scraper. The
command never enumerates, crawls, or derives Twitter/X CDN URLs. It only
fetches URLs that birdclaw already has from an archive or API/live sync
record, skips files that already exist locally, sends a birdclaw user agent,
paces image requests sequentially by default, caps optional image parallelism
at five, runs video downloads serially with their own `--video-pacing-ms`,
streams response bodies to a `.tmp` file with `Range: bytes=<size>-` resume,
caps each file at `--max-bytes` (100MB default), backs off on `429`, and
relies on the local file cache for idempotency.

Thumbnail generation and automatic invocation from sync commands are
intentionally left out. Run it separately, for example from cron or launchd
every few hours:

```bash
birdclaw media fetch --json
birdclaw media fetch --dry-run --limit 20
birdclaw media fetch --include-video --video-pacing-ms 1500 --max-bytes 209715200 --json
birdclaw media fetch --no-include-video --parallel 3 --pacing-ms 250 --json
```

Notes:

- `--include-video` is on by default; pass `--no-include-video` for images
  only
- `--kind`, `--since`, and `--limit` scope which tweet rows are inspected
- `--parallel` applies to image fetches only; video fetches stay serial
- JSON output reports `images_fetched`, `videos_fetched`, `gifs_fetched`,
  `reused_from_archive`, and per-kind byte counters

## Requirements

- Node `25.8.1` or Node 26.x
- `pnpm`
- macOS recommended for Spotlight archive discovery
- `xurl` optional for live reads / writes
- `bird` optional for cookie-backed likes, bookmarks, mentions, DMs, and write fallback
- OpenAI API key optional for inbox scoring

## Install

Homebrew:

```bash
brew install steipete/tap/birdclaw
```

From source:

```bash
fnm use
pnpm install
```

## Run

```bash
pnpm dev
```

Open:

```text
http://localhost:3000
```

## Quick Start

Initialize local state:

```bash
birdclaw init
birdclaw auth status --json
birdclaw db stats --json
```

Find and import an archive:

```bash
birdclaw archive find --json
birdclaw import archive --json
birdclaw import archive ~/Downloads/twitter-archive-2025.zip --json
```

Optional profile hydration can improve bios, follower counts, and avatars, but it performs live X profile reads and can spend API credits on large archives:

```bash
birdclaw import hydrate-profiles --json
```

`import archive` is idempotent. Re-running parses follower/following edges into the local follow graph, streams bundled media files under `data/tweets_media/`, `data/direct_messages_media/`, and the other archive media folders into `~/.birdclaw/media/originals/archive/<kind>/<id>/`, and pulls `video_info.variants[]` so archive video and animated-GIF rows carry mp4 URLs for the live media fetcher. Already-extracted files are skipped when size matches.

Re-import only one part of a newer archive when you already have live or local data you want to keep:

```bash
birdclaw import archive ~/Downloads/twitter-archive-2026.zip --select tweets --json
birdclaw import archive ~/Downloads/twitter-archive-2026.zip --select likes,bookmarks --json
birdclaw import archive ~/Downloads/twitter-archive-2026.zip --select directMessages --json
```

Valid `--select` slices are `tweets`, `likes`, `bookmarks`, `profiles`, `directMessages`, `followers`, and `following`. `dms` and `direct-messages` are accepted aliases for `directMessages`.

Back up the local SQLite store as canonical JSONL text:

```bash
birdclaw backup sync --repo ~/Projects/backup-birdclaw --remote https://github.com/steipete/backup-birdclaw.git --json
```

Merge the backup into the current `BIRDCLAW_HOME`:

```bash
birdclaw backup import ~/Projects/backup-birdclaw --json
```

Start the app:

```bash
birdclaw serve
```

Use the Sync button in Home, Mentions, Likes, Bookmarks, or DMs to run the matching live sync from the web UI and then reload the local view. These controls are explicit because live reads can be slow, auth-dependent, or rate-limited.

When running behind a trusted reverse proxy such as Tailscale Serve, add any extra proxy hostnames to `BIRDCLAW_ALLOWED_HOSTS`. The clawmac Tailscale hostname is allowed by default.

First moderation pass:

```bash
pnpm cli mentions export --mode xurl --refresh --all --max-pages 9 --limit 100
pnpm cli profiles replies @borderline_handle --limit 12 --json
pnpm cli blocks import ~/triage/blocklist.txt --account acct_primary --json
```

## CLI Highlights

### Search local tweets

```bash
pnpm cli search tweets "local-first" --json
pnpm cli search tweets "sync engine" --limit 20 --json
pnpm cli search tweets --since 2020-01-01 --until 2021-01-01 --originals-only --hide-low-quality --limit 500 --json
pnpm cli search tweets --liked --limit 20 --json
pnpm cli search tweets --bookmarked --limit 20 --json
```

### Sync authored tweets, likes, bookmarks, home timeline, and mentions

`auto` tries `xurl` first for likes/bookmarks, then falls back to `bird`. Use `bird` directly when the API path is unavailable for the account/token you have locally. For repeated xurl collection syncs, add `--early-stop` to stop paging once a whole page already exists locally; without `--all` or `--max-pages`, it caps at 10 pages.

```bash
pnpm cli sync authored --mode xurl --limit 100 --json
pnpm cli sync likes --mode auto --limit 100 --refresh --json
pnpm cli sync bookmarks --mode auto --limit 100 --refresh --json
pnpm cli sync likes --mode auto --limit 100 --max-pages 5 --early-stop --refresh --json
pnpm cli sync bookmarks --mode auto --limit 100 --max-pages 5 --early-stop --refresh --json
pnpm cli sync bookmarks --mode bird --all --max-pages 5 --limit 100 --refresh --json
pnpm cli sync timeline --limit 100 --refresh --json
pnpm cli sync mentions --mode xurl --limit 100 --max-pages 3 --refresh --json
pnpm cli sync mention-threads --limit 30 --delay-ms 1500 --timeout-ms 15000 --json
```

Mention context is a two-step sync pipeline: run `sync mentions` to ingest recent mention rows with `kind='mention'`, then run `sync mention-threads --mode xurl` to fill parent/root conversation context.

### Follow graph queries

Follow graph sync is cache-first and defaults to dry-run so repeated agent queries do not keep spending live reads. `auto` prefers `bird` for this path and falls back to `xurl`.

```bash
pnpm cli sync followers --json
pnpm cli sync following --json
pnpm cli sync followers --yes --json
pnpm cli sync following --yes --json
pnpm cli sync followers --mode bird --yes --json
pnpm cli graph summary --json
pnpm cli graph events --since 2026-05-01 --json
pnpm cli graph top-followers --limit 20 --json
pnpm cli graph unfollowed --date 2026-05-01 --json
pnpm cli graph non-mutual-following --sort followers --limit 100 --json
pnpm cli graph mutuals --json
```

Use `--refresh` only when you intentionally want a new live fetch. The `graph` commands are local SQLite reads and never call X. See [follow-graph.md](docs/follow-graph.md) for long-term agent usage notes.

### Export mentions for agents

Default `birdclaw` mode exports DB-backed mention items with `text`, `plainText`, `markdown`, author metadata, and canonical URLs:

```bash
pnpm cli mentions export "agent" --unreplied --limit 10
```

Cached live modes return `xurl`-compatible `data/includes/meta`, but stay in the local SQLite cache so repeat reads do not keep spending live calls:

```bash
pnpm cli mentions export --mode bird --limit 20
pnpm cli mentions export --mode bird --refresh --limit 20
pnpm cli mentions export --mode xurl --limit 5
pnpm cli mentions export --mode xurl --refresh --limit 5
pnpm cli mentions export --mode xurl --refresh --all --max-pages 9 --limit 100
pnpm cli mentions export "courtesy" --mode xurl --limit 5
```

Home config lives in `~/.birdclaw/config.json`. Example:

```json
{
	"actions": {
		"transport": "auto"
	},
	"mentions": {
		"dataSource": "bird",
		"birdCommand": "/Users/steipete/Projects/bird/bird"
	}
}
```

Notes:

- `--refresh` forces a live fetch
- `--cache-ttl <seconds>` tunes freshness
- `--all` walks every retrievable mentions page; `--max-pages` caps that scan
- in paged `xurl` mode, `--limit` is the per-page size
- `mentions.dataSource` controls live mention reads only
- `actions.transport` controls live block/mute writes only
- `actions.transport` accepts `auto`, `bird`, or `xurl`
- `bird` mode uses your local `bird` CLI and caches its mentions output into birdclaw's canonical store
- filters still work in `xurl` mode; filtered payloads are rebuilt from the local canonical store after sync
- `sync authored`, `sync mentions`, `sync mention-threads`, `sync likes`, `sync bookmarks`, and `sync timeline` store live results in the canonical local store; per-account authored/home/mention/like/bookmark membership is kept as edges so shared tweets do not clobber account ownership
- the web UI has explicit Sync buttons for home timeline, mentions, likes, bookmarks, and DMs; they call the same sync paths and then reload the local DB-backed view

### Research bookmarks and threads

`birdclaw research` turns bookmarked tweets into a markdown brief with local thread expansion, live ancestor lookup when needed, and extracted links/handles:

```bash
birdclaw research "codex" --limit 20 --thread-depth 10 --json
birdclaw research --account acct_primary --out ~/research/codex.md
```

### What happened today

`birdclaw today` streams a local "what happened" digest from the SQLite store. It uses the OpenAI Responses API with `gpt-5.5`, medium reasoning, and priority service tier by default. Set `OPENAI_API_KEY`; override with `BIRDCLAW_AI_MODEL`, `BIRDCLAW_OPENAI_REASONING_EFFORT`, or `BIRDCLAW_OPENAI_SERVICE_TIER` when needed.

```bash
birdclaw today
birdclaw digest 24h --refresh
birdclaw digest week --json
birdclaw digest --since 2026-05-16T00:00:00Z --until 2026-05-17T00:00:00Z
birdclaw digest today --include-dms
```

The web UI exposes the same stream under `What happened`. DMs are excluded unless explicitly enabled. Final structured results are cached by the exact local context hash, model, reasoning effort, and service tier.

### Search and triage DMs

```bash
pnpm cli search dms "prototype" --json
pnpm cli search dms "layout" --min-followers 1000 --min-influence-score 120 --sort influence --json
pnpm cli search dms "blacksmith" --context 4 --resolve-profiles --expand-urls --no-xurl-fallback --json
pnpm cli whois "blacksmith guy" --context 4 --no-xurl-fallback --json
pnpm cli whois "github guy" --current-affiliation github --exclude-domain-only --no-xurl-fallback
pnpm cli whois "blacksmith" --tweets --context 4 --no-xurl-fallback --json
pnpm cli dms sync --limit 50 --refresh --json
pnpm cli dms list --refresh --limit 10 --json
pnpm cli dms list --unreplied --min-followers 500 --min-influence-score 90 --sort influence --json
```

`--resolve-profiles` fills archive-imported numeric DM profiles through the local
cache first, then `bird`, then `xurl` unless `--no-xurl-fallback` is set.
Resolved profiles keep bio, location, profile URL, verification type, structured
URL entities, raw profile JSON, and any X affiliation badge metadata Birdclaw can
see. When a highlighted-label badge only gives a synthetic label plus handle,
Birdclaw tries to hydrate that org handle through `bird` and rewrites the edge to
the real local organization profile id. Profile changes are snapshotted over
time, and bios are indexed for `@handles`, domains, and company phrases.
`whois` uses that profile context plus DM context and cached URL expansion to
return typed evidence such as `profile_bio`, `profile_url`, `profile_bio_url`,
`affiliation`, `bio_handle`, `bio_domain`, `bio_company`, `profile_history`,
`dm_context`, and `expanded_url`. It keeps a derived `identity_search_index`
for fast local profile-evidence lookups, ranks current affiliation and bio
identity evidence above plain domains, and groups human output into likely
affiliated, ecosystem, link-only, and DM-context buckets. Use
`--affiliation`, `--current-affiliation`, and `--exclude-domain-only` when you
want "GitHub people" rather than anyone with a `github.com` link.

### AI inbox

```bash
pnpm cli inbox --json
pnpm cli inbox --kind dms --limit 10 --json
pnpm cli inbox --score --hide-low-signal --limit 8 --json
```

### Blocklist

```bash
pnpm cli blocks list --account acct_primary --json
pnpm cli blocks sync --account acct_primary --json
pnpm cli blocks import ~/triage/blocklist.txt --account acct_primary --json
pnpm cli blocks add @amelia --account acct_primary --json
pnpm cli blocks record @amelia --account acct_primary --json
pnpm cli blocks remove @amelia --account acct_primary --json
pnpm cli ban @amelia --account acct_primary --transport auto --json
pnpm cli unban @amelia --account acct_primary --transport bird --json
```

Notes:

- `ban` / `unban` accept `--transport auto|bird|xurl`
- `auto` tries `bird` first, then falls back to `xurl`, then `x-web` cookie-backed block/unblock when both fail
- forced `xurl` writes still verify through `bird status` before sqlite changes
- Twitter still rejects pure OAuth2 block writes, so `auto` is the safe default for block/unblock
- `blocks import` accepts newline-delimited blocklists with comments and markdown bullets
- `blocks sync` is for slow/manual remote reconciliation; not for a hot cron loop
- `blocks record` stores a known-good remote block locally without issuing another live write

Example blocklist file:

```text
# crypto / AI slop
@jpctan
@SystemDaddyAi
- @Pepe202579 memecoin bait
https://x.com/someone/status/2030857479001960633?s=20
```

### Profile reply scan

```bash
pnpm cli profiles replies @jpctan --limit 12 --json
```

Notes:

- for the "unsure if AI" case
- scans recent authored tweets, excludes retweets, keeps replies
- useful for spotting repeated generic praise, abstraction soup, or cross-thread templated cadence

Typical tell:

- same upbeat, generic reply shape across unrelated threads in a short time window

### Mutes

```bash
pnpm cli mutes list --account acct_primary --json
pnpm cli mute @amelia --account acct_primary --transport xurl --json
pnpm cli mutes record @amelia --account acct_primary --json
pnpm cli unmute @amelia --account acct_primary --transport auto --json
```

Notes:

- `mute` / `unmute` accept `--transport auto|bird|xurl`
- target profile resolution prefers `bird user --json` before any `xurl /2/users` lookup
- `auto` tries `bird` first, then falls back to `xurl` when bird fails
- forced `xurl` writes still verify through `bird status` before sqlite changes
- `mutes record` stores a known-good remote mute locally without issuing another live write

### Test env hardening

- Playwright strips inherited `--localstorage-file` from `NODE_OPTIONS` before starting Vite
- this avoids cross-repo test warnings when another repo injected that flag

### Compose / reply

```bash
pnpm cli compose post "Ship local software."
pnpm cli compose reply tweet_004 "On it."
pnpm cli compose dm dm_003 "Send it over."
```

### Text Backup

`birdclaw backup export` writes deterministic JSONL shards that can rebuild the local SQLite index without committing SQLite WAL/SHM files, FTS shadow tables, or transient live caches.

Layout:

```text
manifest.json
data/accounts.jsonl
data/profiles.jsonl
data/profile_affiliations.jsonl
data/profile_snapshots.jsonl
data/profile_bio_entities.jsonl
data/tweets/YYYY.jsonl
data/tweets/unknown.jsonl
data/timeline_edges/home.jsonl
data/timeline_edges/mention.jsonl
data/collections/likes.jsonl
data/collections/bookmarks.jsonl
data/dms/conversations.jsonl
data/dms/YYYY.jsonl
data/moderation/blocks.jsonl
data/moderation/mutes.jsonl
```

Tweets are sharded by year for human browsing and yearly analysis. Collection-only tweets whose real creation date is unknown go into `data/tweets/unknown.jsonl` instead of pretending they belong to 1970. Timeline membership is stored in `data/timeline_edges`; likes and bookmarks are stored as account-scoped collection edges in `data/collections`. DMs are sharded by year with `conversation_id` in each row; this keeps Git fast while preserving conversation membership.

Use `backup sync` when the target is a private Git repo. It pulls first, merge-imports the remote backup into local SQLite, exports the local union back into text shards, commits, and pushes.

```bash
pnpm cli backup sync --repo ~/Projects/backup-birdclaw --remote https://github.com/steipete/backup-birdclaw.git --json
pnpm cli backup validate ~/Projects/backup-birdclaw --json
```

Configure stale-aware backup reads in `~/.birdclaw/config.json`:

```json
{
	"backup": {
		"repoPath": "/Users/steipete/Projects/backup-birdclaw",
		"remote": "https://github.com/steipete/backup-birdclaw.git",
		"autoSync": true,
		"staleAfterSeconds": 900
	}
}
```

Read paths such as CLI search, inbox, API status/query, and web startup pull + merge from Git only when the last backup check is stale. Data-changing commands run a full backup sync afterward when this config is enabled. Set `BIRDCLAW_BACKUP_AUTO_SYNC=0` to disable that behavior for one process.

### Scheduled Bookmark Sync

`birdclaw jobs sync-bookmarks` refreshes live bookmarks and appends one JSONL audit entry per run. Each entry includes host, timestamps, duration, before/after bookmark counts, source transport, fetched count, backup sync result, and any error.

```bash
birdclaw --json jobs sync-bookmarks --mode auto --limit 100 --max-pages 5 --refresh
tail -n 5 ~/.birdclaw/audit/bookmarks-sync.jsonl | jq .
```

After a successful bookmark refresh, the job runs the normal backup auto-sync path. If `~/.birdclaw/config.json` has `backup.autoSync` enabled, the changed local data is merged into the configured Git backup repo, committed, and pushed. The audit entry records that backup result so scheduled runs are inspectable later.

On macOS, install the 3-hour LaunchAgent after choosing the Birdclaw executable path for that machine:

```bash
birdclaw --json jobs install-bookmarks-launchd --program /opt/homebrew/bin/birdclaw
```

If the machine uses `bird` with browser cookies that are not available to launchd, write an export-only env file with mode `0600` and install with `--env-file ~/.config/bird/env.sh`. Birdclaw sources that file inside the scheduled process without storing the secrets in the plist.

The LaunchAgent writes `~/Library/LaunchAgents/com.steipete.birdclaw.bookmarks-sync.plist`, runs at load, then every 10,800 seconds. It writes the audit log to `~/.birdclaw/audit/bookmarks-sync.jsonl` and stdout/stderr to `~/.birdclaw/logs/bookmarks-sync.*.log`. A lock file prevents overlapping runs and records an `already-running` skip when needed. The default job fetches up to 5 pages every 3 hours; pass `--all` if you want every retrievable page each run.

Useful checks:

```bash
launchctl print gui/$(id -u)/com.steipete.birdclaw.bookmarks-sync
launchctl kickstart -k gui/$(id -u)/com.steipete.birdclaw.bookmarks-sync
tail -n 1 ~/.birdclaw/audit/bookmarks-sync.jsonl | jq .
```

## Typical Workflow

1. import your archive if you have one
2. hydrate imported profiles from live Twitter metadata
3. use `Home` for reading
4. use `Mentions` for reply triage
5. when one account feels borderline, inspect `profiles replies`
6. collect keepers into a blocklist file and run `blocks import`
7. use `DMs` for high-context conversation work
8. use `Inbox` when you want AI help cutting noise
9. use CLI exports when agents need stable JSON

## Live Transport

Current preference:

- `xurl` first
- `bird` fallback for surfaces where cookie-backed reads work better

Without `xurl` or `bird`, `birdclaw` still works in local/archive mode.

Check transport:

```bash
pnpm cli auth status --json
```

## Architecture

- SQLite is the canonical local truth
- archive import and live transport should converge on the same model
- CLI and web UI share the same normalized core
- AI ranking is layered on top of local data, not the source of truth

## Testing

```bash
pnpm check
pnpm test
pnpm coverage
pnpm build
pnpm e2e
pnpm perf:browser -- --scenario=links,links-toggle --iterations=5
```

Current bar:

- branch coverage above `80%`
- Playwright coverage for core UI flows
- browser perf smoke reports ready/action timings plus API endpoint fan-out

## CI

GitHub Actions runs:

- `pnpm check`
- `pnpm coverage`
- `pnpm build`
- `pnpm e2e`

Workflow: [ci.yml](.github/workflows/ci.yml)

## Docs

- [spec.md](docs/spec.md)
- [cli.md](docs/cli.md)
- [data-architecture.md](docs/data-architecture.md)
- [follow-graph.md](docs/follow-graph.md)
