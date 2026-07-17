# CLI Spec

Designed with `create-cli` defaults:

- humans first
- scriptable
- stable `--json`
- diagnostics on stderr
- prompts only on TTY

## Name

`birdclaw`

## One-liner

`birdclaw` imports, syncs, searches, and operates on a local Twitter archive.

## Usage

```text
birdclaw [global flags] <subcommand> [args]
```

## Global flags

- `-h, --help`
- `--version`
- `--json`

## Config precedence

Command flags > environment overrides > user config

User config:

- `~/.birdclaw/config.json`

## Env vars

- `BIRDCLAW_HOME`
- `BIRDCLAW_CONFIG`
- `BIRDCLAW_ACTIONS_TRANSPORT`
- `BIRDCLAW_BIRD_COMMAND`
- `BIRDCLAW_BASH_COMMAND`
- `BIRDCLAW_MCP_TOKEN`
- `BIRDCLAW_MCP_PUBLIC_URL`
- `BIRDCLAW_MCP_ACCOUNT`

## Command tree

```text
birdclaw init
birdclaw auth status
birdclaw auth use <transport>
birdclaw import archive [path]
birdclaw import tweet <tweet-id-or-url...> --fxtwitter
birdclaw sync all
birdclaw sync tweets
birdclaw sync authored
birdclaw sync dms
birdclaw sync bookmarks
birdclaw sync likes
birdclaw sync timeline
birdclaw sync mentions
birdclaw sync mention-threads
birdclaw sync followers
birdclaw sync following
birdclaw sync lists
birdclaw lists list
birdclaw lists members [name]
birdclaw search tweets <query>
birdclaw search dms <query>
birdclaw discuss <query>
birdclaw today
birdclaw digest [today|24h|yesterday|week]
birdclaw mentions export [query]
birdclaw media fetch
birdclaw dms list
birdclaw mute <handle-or-id>
birdclaw unmute <handle-or-id>
birdclaw mutes list
birdclaw blocks list
birdclaw blocks add <handle-or-id>
birdclaw blocks remove <handle-or-id>
birdclaw ban <handle-or-id>
birdclaw unban <handle-or-id>
birdclaw show tweet <id>
birdclaw show thread <id>
birdclaw show dm <conversation-id>
birdclaw inbox
birdclaw serve
birdclaw graph summary
birdclaw graph events
birdclaw graph top-followers
birdclaw graph unfollowed
birdclaw graph non-mutual-following
birdclaw graph mutuals
birdclaw compose post
birdclaw compose reply <tweet-id>
birdclaw db stats
birdclaw db vacuum
birdclaw backup export --repo <path>
birdclaw backup sync --repo <path> --remote <url>
birdclaw backup import <path>
birdclaw backup validate <path>
birdclaw debug transport
```

## Subcommand semantics

### `today`

- alias for `digest today`
- streams Markdown as model tokens arrive
- uses `gpt-5.5`, medium reasoning, and priority service tier by default
- requires `OPENAI_API_KEY`
- excludes DMs unless `--include-dms` is passed
- supports `--refresh`, `--model`, `--language <locale-id>`, `--max-tweets`, and `--max-links`
- reads the default report language from `BIRDCLAW_DIGEST_LANGUAGE`

### `digest [period]`

- period: `today`, `24h`, `yesterday`, or `week`
- accepts explicit `--since <iso>` and `--until <iso>` windows
- caches the final structured result by local context hash, model, reasoning effort, service tier, and canonical report language
- accepts the same language tag through `GET /api/period-digest?language=zh-CN`
- `--json` suppresses token streaming and emits the final envelope

### `init`

- create app dir
- create DB
- write default config if absent
- optionally detect `xurl` and `bird`

### `import tweet <tweet-id-or-url...>`

- disabled unless `--fxtwitter` is passed on the same invocation
- sends only requested public tweet IDs to the fixed read-only `https://api.fxtwitter.com` service
- rejects custom origins, redirects, noncanonical URLs, and batches larger than 20 tweets
- stores `fxtwitter` source markers in `tweet_sources` and `data/tweet_sources.jsonl` backups
- discloses requested IDs plus ordinary network metadata such as IP address and request time to the third-party service

See [Public tweet import](public-tweets.md) for the full privacy and capability boundary.

### `auth status`

- show transport availability
- show active account/profile
- never print secrets

### `auth use <transport>`

- set preferred moderation action transport
- allowed: `auto`, `xurl`, `bird`

### `backup export`

- writes Git-friendly canonical JSONL text shards
- removes and rewrites the `data/` directory in the backup repo
- validates the manifest and file hashes by default
- `--commit` creates a Git commit in the backup repo
- `--push` implies commit and pushes the backup repo

```bash
birdclaw backup export --repo ~/Projects/birdclaw-store --commit --push
```

### `backup sync`

- clones/configures the backup Git repo when needed
- pulls the backup repo before reading
- merge-imports remote backup rows into local SQLite
- exports the local union back into deterministic text shards
- commits and pushes the backup repo

```bash
birdclaw backup sync --repo ~/Projects/backup-birdclaw --remote https://github.com/steipete/backup-birdclaw.git --json
```

Shard contract:

- tweets: `data/tweets/YYYY.jsonl`
- tweet provenance: `data/tweet_sources.jsonl`
- unknown tweet dates: `data/tweets/unknown.jsonl`
- profiles: `data/profiles.jsonl` includes bio, follower/following counts, profile URL, location, verification type, structured URL entities, and raw profile JSON
- affiliations: `data/profile_affiliations.jsonl` includes X badge/highlighted-label organization edges
- identity history: `data/profile_snapshots.jsonl` and `data/profile_bio_entities.jsonl` preserve profile-change states and extracted bio identity hints
- collections: `data/collections/likes.jsonl`, `data/collections/bookmarks.jsonl`
- DMs: `data/dms/conversations.jsonl` plus `data/dms/YYYY.jsonl`
- moderation: `data/moderation/blocks.jsonl`, `data/moderation/mutes.jsonl`
- no SQLite WAL/SHM, FTS shadow tables, or transient live cache rows

Backup auto-sync config lives in `~/.birdclaw/config.json`:

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

Read commands pull + merge only when the last backup check is stale. Data-changing commands run a full backup sync afterward. Set `BIRDCLAW_BACKUP_AUTO_SYNC=0` to disable backup auto-sync for one process.

### local `bird` command

Live local likes, bookmarks, DMs, and moderation verification use `bird` on PATH
by default. Override it with `BIRDCLAW_BIRD_COMMAND` or:

```json
{
	"mentions": {
		"birdCommand": "/absolute/path/to/bird"
	}
}
```

On Windows, Birdclaw runs the redirect wrapper through Git Bash. Common Git for
Windows installations are detected automatically; set `BIRDCLAW_BASH_COMMAND`
to the full path of `bash.exe` for a portable or non-standard installation.

### `backup import`

- validates the backup first unless `--no-validate` is passed
- merge-imports by default so local-only rows are not deleted
- `--replace` restores exactly from backup and deletes local portable rows first
- rebuilds tweet and DM FTS from the JSONL text

```bash
birdclaw backup import ~/Projects/birdclaw-store --json
```

### `backup validate`

- checks `manifest.json`
- checks every listed shard hash, byte count, row count, and JSONL parseability
- exits non-zero on validation failure

```bash
birdclaw backup validate ~/Projects/birdclaw-store --json
```

### `import archive [path]`

- validate archive
- analyze contents
- import selected slices
- stream bundled media files from `data/tweets_media/`, `data/direct_messages_media/`, `data/community_tweet_media/`, `data/deleted_tweets_media/`, `data/profile_media/`, `data/moments_tweets_media/`, and `data/direct_messages_group_media/` into `~/.birdclaw/media/originals/archive/<kind>/<id>/<filename>`
- extract `extended_entities.media[].video_info.variants[]` onto each tweet media row for archive video and animated GIFs
- parse `data/follower.js` and `data/following.js` into the local follow graph
- idempotent
- path is optional; without one, macOS archive autodiscovery picks the newest likely ZIP

Flags:

- `--select <kinds>` — comma-separated subset of `tweets,likes,bookmarks,profiles,directMessages,followers,following`

`--select` details:

- selected re-imports preserve unselected slices
- valid aliases for `directMessages`: `directmessages`, `direct-messages`, `dms`
- duplicate names are ignored
- empty values and unknown names exit as invalid usage
- selected imports validate that existing `acct_primary` matches the archive account before writing
- selected imports preserve compatible existing profile rows unless `profiles` is selected

Examples:

```bash
birdclaw import archive --json
birdclaw import archive ~/Downloads/twitter-archive.zip --json
birdclaw import archive ~/Downloads/twitter-archive.zip --select tweets --json
birdclaw import archive ~/Downloads/twitter-archive.zip --select likes,bookmarks --json
birdclaw import archive ~/Downloads/twitter-archive.zip --select dms --json
birdclaw import archive ~/Downloads/twitter-archive.zip --select followers,following --json
```

### `sync *`

- fetch deltas
- update canonical tables
- refresh cursors
- refresh FTS incrementally
- `sync likes` and `sync bookmarks` use cached live transport; `auto` tries `xurl`, then `bird`; `--early-stop` caps at 10 pages unless paired with `--all` or `--max-pages`
- `sync authored` uses `xurl`, includes retweets, and resumes from a stored `since_id`
- `sync timeline` stores the live home timeline through `bird`; it defaults to the chronological Following feed
- `sync mentions` ingests recent mentions through `xurl` (default) or `bird` and writes `kind='mention'` rows into the canonical store; this is the cron-friendly ingest path that replaces relying on `mentions export --refresh`
- `sync mention-threads` fetches conversation context for recent mentions through `bird thread` or `xurl`; pass `--mode xurl` when the `bird` CLI is unavailable, otherwise use `--delay-ms` and `--timeout-ms` to stay gentle on live X
- `sync followers` and `sync following` default to dry-run and require `--yes` for live sync or fresh-cache merge; `auto` prefers `bird`, then falls back to `xurl`
- `sync lists` is an explicit read-only walk; it defaults to 20 members, one page, and 1,000 ms pacing per List, and stores `complete|inferred|partial|error` membership state

Common flags:

- `--since <cursor-or-id>`
- `--limit <n>`
- `--transport <kind>`
- `--dry-run`
- `--mode auto|xurl|bird`
- `--all`
- `--max-pages <n>`
- `--early-stop` (on `sync likes` and `sync bookmarks`)
- `--refresh`
- `--cache-ttl <seconds>`

Examples:

```bash
birdclaw sync authored --mode xurl --limit 100 --json
birdclaw sync likes --mode auto --limit 100 --refresh --json
birdclaw sync likes --mode auto --limit 100 --max-pages 5 --early-stop --refresh --json
birdclaw sync bookmarks --mode auto --limit 100 --refresh --json
birdclaw sync bookmarks --mode auto --limit 100 --max-pages 5 --early-stop --refresh --json
birdclaw sync bookmarks --mode bird --all --max-pages 5 --limit 100 --refresh --json
birdclaw sync timeline --limit 100 --refresh --json
birdclaw sync mentions --mode xurl --limit 100 --max-pages 3 --refresh --json
birdclaw sync mention-threads --mode bird --limit 30 --delay-ms 1500 --timeout-ms 15000 --json
birdclaw sync mention-threads --mode xurl --limit 30 --json
birdclaw sync lists --mode auto --max-lists 20 --member-limit 20 --max-member-pages 1 --delay-ms 1000 --json
```

Follow graph examples:

```bash
birdclaw sync followers --json
birdclaw sync following --json
birdclaw sync followers --yes --json
birdclaw sync following --yes --json
birdclaw sync followers --mode bird --yes --json
birdclaw sync followers --yes --max-pages 1 --allow-partial --json
birdclaw sync followers --yes --refresh --json
```

Follow graph sync uses a 24-hour cache by default. Repeating the same sync command with `--yes` reuses fresh cache unless `--refresh` is passed, which prevents duplicate live reads during agent workflows.

`--allow-partial` acknowledges capped/incomplete snapshots and suppresses the warning. Incomplete snapshots are still recorded for audit, but they are not used for churn events.

### `jobs sync-account`

- refreshes home timeline, mentions, mention threads, likes, bookmarks, and DMs for one account
- appends one JSONL audit entry per run to `~/.birdclaw/audit/account-sync.jsonl`
- records each step independently with count, source, and error
- uses `~/.birdclaw/locks/account-sync.lock` to skip overlapping runs
- requires `--allow-bird-account` before Bird-backed steps write to a non-default `--account`
- exits non-zero when any step failed

Examples:

```bash
birdclaw --json jobs sync-account --account acct_openclaw --limit 100 --max-pages 3 --refresh --allow-bird-account
tail -n 20 ~/.birdclaw/audit/account-sync.jsonl | jq .
```

### `jobs install-account-launchd`

- writes `~/Library/LaunchAgents/com.steipete.birdclaw.account-sync.plist`
- runs `jobs sync-account` every 30 minutes by default
- uses `launchctl load -w` unless `--no-load` is passed
- `--steps <steps>` narrows the scheduled surfaces
- `--env-path <path>` sources account-specific `bird` cookies for launchd
- `--allow-bird-account` asserts those cookies match `--account` for Bird-backed timeline, mentions, and DM steps

```bash
birdclaw --json jobs install-account-launchd --account acct_openclaw --program /opt/homebrew/bin/birdclaw --env-path ~/.config/bird/openclaw.env --allow-bird-account
```

### `jobs sync-bookmarks`

- runs a live bookmark refresh with scheduler-friendly defaults
- appends one JSONL audit entry per run
- records host, timestamps, duration, before/after bookmark counts, transport source, fetched count, backup sync result, and errors
- uses `~/.birdclaw/locks/bookmarks-sync.lock` to skip overlapping runs
- exits non-zero when the sync failed

Default audit log:

```text
~/.birdclaw/audit/bookmarks-sync.jsonl
```

Examples:

```bash
birdclaw --json jobs sync-bookmarks --mode auto --limit 100 --max-pages 5 --refresh
tail -n 20 ~/.birdclaw/audit/bookmarks-sync.jsonl | jq .
```

### `jobs install-bookmarks-launchd`

- writes `~/Library/LaunchAgents/com.steipete.birdclaw.bookmarks-sync.plist`
- runs `jobs sync-bookmarks` every 3 hours by default
- uses `launchctl load -w` unless `--no-load` is passed
- writes launchd stdout/stderr to `~/.birdclaw/logs/bookmarks-sync.*.log`
- `--env-path <path>` sources an export-only shell env file inside the scheduled process, useful when `bird` needs `AUTH_TOKEN`/`CT0` outside an interactive browser session

```bash
birdclaw --json jobs install-bookmarks-launchd --program /opt/homebrew/bin/birdclaw
```

### `search tweets <query>`

Flags:

- `--author <handle-or-id>`
- `--account <accountId>`
- `--list <name>`
- `--list-id <id>`
- `--since <date>`
- `--until <date>`
- `--originals-only`
- `--hide-low-quality`
- `--liked`
- `--bookmarked`
- `--limit <n>`

Examples:

```bash
birdclaw search tweets --liked --limit 20 --json
birdclaw search tweets --bookmarked --limit 20 --json
birdclaw search tweets "sqlite" --list Builders --limit 50 --json
```

### `search dms <query>`

Flags:

- `--participant <handle-or-id>`
- `--min-followers <n>`
- `--max-followers <n>`
- `--min-influence-score <n>`
- `--max-influence-score <n>`
- `--sort recent|followers`
- `--context <n>`
- `--resolve-profiles`
- `--expand-urls`
- `--refresh-profile-cache`
- `--refresh-url-cache`
- `--no-xurl-fallback`
- `--replied`
- `--unreplied`
- `--limit <n>`

Profile resolution reads the local profile row first, then the persistent lookup
cache, then `bird user`, then `xurl` unless `--no-xurl-fallback` is set. Failed
lookups are cached briefly so repeated searches do not keep spending live calls.
Resolved profile rows store bio, profile URL, location, verification type,
structured X URL entities, raw profile JSON, and affiliation badge metadata when
the live transport exposes it.

### `discuss <query>`

Fetch live keyword matches through `bird` or `xurl`, store them as local
`search` tweets, then stream an OpenAI Markdown summary and discussion. DMs stay
out unless explicitly requested.

Flags:

- `--account <account-id>`
- `--source all|search|home|mentions|authored|likes|bookmarks`
- `--mode auto|bird|xurl|local`
- `--include-dms`
- `--since <date>` / `--until <date>`
- `--question <prompt>`
- `--originals-only`
- `--hide-low-quality`
- `--refresh`
- `--model <model>`
- `--limit <n>`
- `--max-pages <n>`

Examples:

```bash
birdclaw discuss "local-first" --mode bird
birdclaw discuss "sync engine" --question "what changed over time?"
birdclaw discuss "prototype" --include-dms --limit 500 --max-pages 5 --json
```

### `whois <query>`

Find likely people or orgs from local DM and optional tweet evidence.
Candidates include structured `profileEvidence` entries for profile bio, profile
URL, bio URLs, location, verified type, first-class affiliations, bio entities,
profile-history snapshots, DM context, and expanded URLs. `whois` also searches
significant terms from fuzzy prompts, so `blacksmith guy` can rank a match from
`@useblacksmith` and `blacksmith.sh` even when the literal phrase was not stored
in a DM. Query intent changes ranking: `@github` emphasizes handle and
affiliation evidence, `github.com` emphasizes URL/domain evidence, and
`github guy` emphasizes people/org affiliation evidence. Human output explains
"why this person?" and buckets candidates as likely affiliated, ecosystem,
profile/link-only, DM context, or other local matches.

Flags:

- `--account <account-id>`
- `--no-dms`
- `--tweets`
- `--no-resolve-profiles`
- `--no-expand-urls`
- `--refresh-profile-cache`
- `--refresh-url-cache`
- `--no-xurl-fallback`
- `--affiliation <query>` - require current/bio/history affiliation evidence
- `--current-affiliation <query>` - require an active affiliation badge edge
- `--exclude-domain-only` - drop candidates that only matched domains or URLs
- `--context <n>`
- `--limit <n>`

Examples:

```bash
birdclaw whois blacksmith --context 4 --no-xurl-fallback --json
birdclaw whois "blacksmith guy" --context 4 --no-xurl-fallback --json
birdclaw whois "github guy" --current-affiliation github --exclude-domain-only
birdclaw whois blacksmith --tweets --no-xurl-fallback
```

### `mentions export [query]`

- export local mention tweets for scripts and agents
- always emits JSON
- supports `birdclaw`, cached `xurl`, or cached `bird` output
- each item includes:
  - raw `text`
  - rendered `plainText`
  - rendered `markdown`
  - canonical tweet URL
  - author and reply-state metadata

Flags:

- `--account <account-id>`
- `--mode birdclaw|xurl|bird`
- `--replied`
- `--unreplied`
- `--refresh`
- `--cache-ttl <seconds>`
- `--all`
- `--max-pages <n>`
- `--limit <n>`

Examples:

```bash
birdclaw mentions export "agent" --unreplied --limit 10
birdclaw mentions export --mode bird --limit 20
birdclaw mentions export --mode xurl --limit 5
birdclaw mentions export "codex" --mode xurl --limit 5
birdclaw mentions export --mode xurl --refresh --cache-ttl 30 --limit 5
birdclaw mentions export --mode xurl --refresh --all --max-pages 9 --limit 100
```

Notes:

- `--mode xurl` mirrors the `xurl mentions` response shape: `data`, `includes.users`, `meta`
- `--mode bird` shells out to your local `bird` CLI, normalizes the JSON to that same `xurl`-compatible shape, then caches it in SQLite
- payload is cached in local SQLite and reused until the cache TTL expires
- `--refresh` bypasses the cache and fetches live mentions immediately
- `--all` keeps paginating until the retrievable mentions window is exhausted
- `--max-pages` limits that paged xurl scan and implies `--all`
- in paged `xurl` mode, `--limit` is the page size, not the total returned item count
- query and reply-state filters still work in `xurl` mode, but the filtered response is rebuilt from the local canonical store after sync
- default live source can live in `~/.birdclaw/config.json` under `mentions.dataSource`

### `media fetch`

- fill the local originals cache for images, videos, and animated GIFs whose tweets already live in the local SQLite store
- reuse bytes already extracted by `import archive` before falling back to the CDN; reuses are counted in JSON output as `reused_from_archive` and spend zero CDN bandwidth
- only fetch URLs birdclaw already has from an archive or live sync record; never enumerate, crawl, or derive CDN URLs
- skip files already present on disk; resume partial downloads with `Range: bytes=<size>-`
- back off on `429`; cap each file at `--max-bytes`

Flags:

- `--account <accountId>`
- `--limit <n>` - stop after N tweets processed
- `--kind <kind>` - tweet/collection kind, e.g. `home`, `like`, `bookmark`, `mention`
- `--since <isoDate>` - only consider tweets created at or after this date
- `--parallel <n>` - concurrent image workers, capped at 5 (default `1`)
- `--pacing-ms <n>` - delay between image request starts (default `250`)
- `--video-pacing-ms <n>` - separate delay between video request starts
- `--retry-max <n>` - retries per file after rate limiting (default `3`)
- `--include-video` / `--no-include-video` - videos and animated GIFs are on by default
- `--max-bytes <n>` - per-file size cap in bytes (default `104857600`)
- `--dry-run` - list what would be fetched without downloading
- `--json`

JSON output carries `images_fetched`, `videos_fetched`, `gifs_fetched`, `reused_from_archive`, `skipped_cached`, `failed`, `rate_limited`, per-kind byte counters, and a `failures[]` array. See [Media](media.md) for the full pipeline.

Examples:

```bash
birdclaw media fetch --json
birdclaw media fetch --dry-run --limit 20
birdclaw media fetch --include-video --video-pacing-ms 1500 --max-bytes 209715200 --json
birdclaw media fetch --no-include-video --parallel 3 --pacing-ms 250 --json
```

### `profiles replies <handle-or-id>`

- inspect a profile's recent authored replies when one mention feels borderline
- moderation-first: scans the live authored tweet timeline, excludes retweets, keeps reply tweets only
- good for spotting templated AI cadence across unrelated conversations
- supports `--json`

Flags:

- `--limit <n>`

Examples:

```bash
birdclaw profiles replies @jpctan --limit 12 --json
```

### `dms list`

- list DM conversations or events without requiring a full-text query
- optimized for agent and operator filtering
- optionally refreshes live DMs before listing

Flags:

- `--refresh`
- `--mode bird|xurl|auto`
- `--cache-ttl <seconds>`
- `--participant <handle-or-id>`
- `--min-followers <n>`
- `--max-followers <n>`
- `--min-influence-score <n>`
- `--max-influence-score <n>`
- `--sort recent|followers`
- `--replied`
- `--unreplied`
- `--account <name>`
- `--limit <n>`

### `dms sync`

- refresh live direct messages
- merge conversations/messages into the local SQLite store
- supports `--json`

Flags:

- `--account <account-id>`
- `--mode bird|xurl|auto`
- `--limit <n>`
- `--refresh`
- `--cache-ttl <seconds>`

`--mode bird` is the default and the only mode that can sync message requests. `--mode xurl` reads recent OAuth2 `/2/dm_events` as accepted conversations; `--mode auto` tries xurl first for accepted DMs and falls back to bird.

### `inbox`

- show AI-ranked actionable queue
- supports `--json`
- supports `--limit`
- supports `--kind mentions|dms|mixed`
- supports replied/unreplied filters
- supports `--score` to refresh stored OpenAI scores before listing
- supports `--min-score` and `--hide-low-signal`

### `blocks list`

- list current local blocked profiles
- account-scoped
- supports `--json`

Flags:

- `--account <account-id>`
- `--search <query>`
- `--limit <n>`

### `blocks add <handle-or-id>`

- add a local block entry for one account
- accepts handle, `@handle`, Twitter URL, local profile id, or numeric Twitter user id
- attempts live block transport via `xurl` when resolvable
- falls back to the Twitter web cookie session if `xurl` is rejected for OAuth2 block writes
- still records the local block if live transport is unavailable

Flags:

- `--account <account-id>`

### `blocks import <path>`

- import a blocklist file in one call
- reads newline-delimited handles, ids, or Twitter URLs
- ignores blank lines and `#` comments
- tolerates markdown bullets like `- @handle`
- returns per-entry success/failure in `--json`

Flags:

- `--account <account-id>`

### `blocks remove <handle-or-id>`

- remove a local block entry for one account
- attempts live unblock transport via `xurl` when resolvable
- falls back to the Twitter web cookie session if `xurl` is rejected for OAuth2 block writes

Flags:

- `--account <account-id>`

### `ban <handle-or-id>` / `unban <handle-or-id>`

- shorthand aliases for `blocks add` and `blocks remove`
- useful when you want one obvious moderation verb from the CLI

Flags:

- `--account <account-id>`

### `mutes list`

- list current local muted profiles
- account-scoped
- supports `--json`

Flags:

- `--account <account-id>`
- `--search <query>`
- `--limit <n>`

### `mute <handle-or-id>`

- add a local mute entry for one account
- accepts handle, `@handle`, Twitter URL, local profile id, or numeric Twitter user id
- resolves remote targets via `bird user --json` before falling back to `xurl /2/users`
- `--transport auto` tries `bird` first, then `xurl`
- still records the local mute if live transport is unavailable

Flags:

- `--account <account-id>`

### `unmute <handle-or-id>`

- remove a local mute entry for one account
- `--transport auto` tries `bird` first, then `xurl`

Flags:

- `--account <account-id>`

### `serve`

- starts local app server
- starts the built production SSR and static-asset server
- stdout prints the listening URL

Flags:

- `--host <host>`
- `--port <port>`

`birdclaw serve` binds the production server to `127.0.0.1:3000` by default and
enables local loopback web APIs without a token. `BIRDCLAW_HOST` and
`BIRDCLAW_PORT` provide environment defaults. Remote access through a trusted
private proxy requires `BIRDCLAW_ALLOW_REMOTE_WEB=1`. To require an app-level
token too, set `BIRDCLAW_WEB_TOKEN` and send it as `x-birdclaw-token` or a
`birdclaw_token` cookie.

The same process can expose an adapter-owned, read-only Streamable HTTP MCP
endpoint at the exact path `/mcp`. Configure both `BIRDCLAW_MCP_TOKEN` and
`BIRDCLAW_MCP_PUBLIC_URL`; the MCP token must be at least 32 bytes and must
differ from `BIRDCLAW_WEB_TOKEN`. `BIRDCLAW_MCP_ACCOUNT` optionally selects one
server-side account by id or handle; otherwise tools read the default account.

When MCP is configured, startup validates the configuration, selected account,
and an existing initialized database at the current schema. It does not create
or migrate the database for MCP. Run `birdclaw init` or import/migrate with a
trusted CLI command before starting the server.

HTTP MCP URLs are accepted only for loopback hosts. External MCP URLs must use
HTTPS on a dedicated hostname. Birdclaw reserves that configured hostname for
MCP and denies every path except `/mcp`; the proxy and outer authentication
policy must enforce the same rule. See the [MCP server guide](mcp.md).

### `graph summary`

- cache-only SQLite read
- current followers/following counts
- mutuals and non-mutual following counts
- last complete and incomplete snapshot times

### `graph top-followers`

- cache-only SQLite read
- current followers sorted by their `public_metrics.followers_count`
- supports `--limit`

### `graph unfollowed`

- cache-only SQLite read
- append-only ended follow edges since `--date`
- defaults to `followers`; pass `--direction following` for outbound ended edges

### `graph events`

- cache-only SQLite read
- append-only `started` and `ended` follow graph history
- supports `--direction followers|following`, `--kind started|ended`, `--since`, `--until`, and `--limit`

### `graph mutuals`

- cache-only SQLite read
- current mutuals
- sorted by follower size

### `graph non-mutual-following`

- cache-only SQLite read
- current following profiles that are not current followers
- supports `--sort followers|handle`

Agent rule: use `graph` commands for analysis. Ask for explicit user approval before `sync ... --yes --refresh`, because that can spend live X API reads.

## I/O contract

stdout:

- primary data
- URLs
- JSON output

stderr:

- progress
- warnings
- diagnostics
- auth hints

## Output modes

- default human output
- `--json` stable machine-readable envelopes
- `--plain` stable line-oriented text, no color

## Exit codes

- `0` success
- `1` runtime failure
- `2` invalid usage / validation
- `3` auth unavailable
- `4` transport unavailable
- `5` partial sync failure

## Examples

```bash
birdclaw init
birdclaw auth status
birdclaw import archive ~/Downloads/twitter-archive.zip --select tweets,directMessages
birdclaw sync all --transport xurl
birdclaw search tweets "openai" --since 2024-01-01 --limit 20
birdclaw search tweets --since 2020-01-01 --until 2021-01-01 --originals-only --hide-low-quality --limit 500
birdclaw search dms "invoice" --participant @someone --min-followers 1000
birdclaw dms list --unreplied --min-followers 500 --min-influence-score 90 --sort followers
birdclaw inbox --json
birdclaw serve
birdclaw graph events --json
birdclaw compose reply 1891234567890
```
