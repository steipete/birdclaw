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

- one shared SQLite DB for multiple accounts
- FTS5 search over tweets and DMs
- archive autodiscovery on macOS
- archive import for tweets, likes, profiles, and full DMs
- archive import for bookmark exports when present
- live likes and bookmarks sync through `xurl` or `bird`
- Git-friendly text backups with yearly tweet shards and per-conversation DM shards
- profile hydration from live Twitter metadata
- local avatar cache
- local media cache root under `~/.birdclaw`

### Web UI

- `Home` timeline
- `Mentions` queue
- `Likes` and `Bookmarks` review lanes
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

## Still In Progress

- broader resumable live sync beyond the targeted paths already wired
- fuller media fetch pipeline
- richer multi-account UX
- more complete transport coverage
- more archive edge-case handling

If you need polished product-grade sync parity today, this is not there yet.

## Screens

- `Home`: read and reply without fighting the main Twitter timeline
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
- avatar cache: `~/.birdclaw/media/thumbs/avatars`
- Playwright test home: `.playwright-home`

Override the root:

```bash
export BIRDCLAW_HOME=/path/to/custom/root
```

## Requirements

- Node `25.8.1`
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
birdclaw import hydrate-profiles --json
```

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

### Sync likes and bookmarks

`auto` tries `xurl` first, then falls back to `bird`. Use `bird` directly when the API path is unavailable for the account/token you have locally.

```bash
pnpm cli sync likes --mode auto --limit 100 --refresh --json
pnpm cli sync bookmarks --mode auto --limit 100 --refresh --json
pnpm cli sync bookmarks --mode bird --all --max-pages 5 --limit 100 --refresh --json
```

### Export mentions for agents

Default `birdclaw` mode returns normalized items with `text`, `plainText`, `markdown`, author metadata, and canonical URLs:

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
- `sync likes` and `sync bookmarks` store live results in the same local timeline table, so `search tweets --liked` and `search tweets --bookmarked` work across archive and live data

### Search and triage DMs

```bash
pnpm cli search dms "prototype" --json
pnpm cli search dms "layout" --min-followers 1000 --min-influence-score 120 --sort influence --json
pnpm cli dms sync --limit 50 --refresh --json
pnpm cli dms list --refresh --limit 10 --json
pnpm cli dms list --unreplied --min-followers 500 --min-influence-score 90 --sort influence --json
```

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
- `auto` tries `bird` first, then falls back to `xurl` when bird fails
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
data/tweets/YYYY.jsonl
data/tweets/unknown.jsonl
data/collections/likes.jsonl
data/collections/bookmarks.jsonl
data/dms/conversations.jsonl
data/dms/YYYY.jsonl
data/moderation/blocks.jsonl
data/moderation/mutes.jsonl
```

Tweets are sharded by year for human browsing and yearly analysis. Collection-only tweets whose real creation date is unknown go into `data/tweets/unknown.jsonl` instead of pretending they belong to 1970. DMs are sharded by year with `conversation_id` in each row; this keeps Git fast while preserving conversation membership. Likes and bookmarks are stored as collection edges in `data/collections` and mirrored into the timeline rows for current query compatibility.

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
fnm exec --using 25.8.1 pnpm check
fnm exec --using 25.8.1 pnpm test
fnm exec --using 25.8.1 pnpm coverage
fnm exec --using 25.8.1 pnpm build
fnm exec --using 25.8.1 pnpm e2e
```

Current bar:

- branch coverage above `80%`
- Playwright coverage for core UI flows

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
