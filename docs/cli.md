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

`birdclaw` imports, syncs, searches, and operates on a local X archive.

## Usage

```text
birdclaw [global flags] <subcommand> [args]
```

## Global flags

- `-h, --help`
- `--version`
- `--json`
- `--plain`
- `-q, --quiet`
- `-v, --verbose`
- `--no-color`
- `--no-input`
- `--config <path>`
- `--profile <name>`
- `--db <path>`

## Config precedence

Flags > env > project config > user config

User config:
- `~/.birdclaw/config.json`

Project config:
- `./.birdclawrc.json5`

## Env vars

- `BIRDCLAW_DB`
- `BIRDCLAW_PROFILE`
- `BIRDCLAW_TRANSPORT`
- `BIRDCLAW_LOG`
- `NO_COLOR`

## Command tree

```text
birdclaw init
birdclaw auth status
birdclaw auth use <transport>
birdclaw import archive <path>
birdclaw sync all
birdclaw sync tweets
birdclaw sync dms
birdclaw sync bookmarks
birdclaw sync likes
birdclaw sync followers
birdclaw sync following
birdclaw search tweets <query>
birdclaw search dms <query>
birdclaw mentions export [query]
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
birdclaw graph mutuals
birdclaw compose post
birdclaw compose reply <tweet-id>
birdclaw db stats
birdclaw db vacuum
birdclaw debug transport
```

## Subcommand semantics

### `init`

- create app dir
- create DB
- write default config if absent
- optionally detect `xurl` and `bird`

### `auth status`

- show transport availability
- show active account/profile
- never print secrets

### `auth use <transport>`

- set preferred transport for profile
- allowed: `auto`, `xurl`, `bird`, `official`, `xweb`

### `import archive <path>`

- validate archive
- analyze contents
- import selected slices
- idempotent

Flags:
- `--select <kinds>`
- `--dm-mode metadata|full`
- `--dry-run`
- `--force`

Default:
- DMs import in `full` mode

### `sync *`

- fetch deltas
- update canonical tables
- refresh cursors
- refresh FTS incrementally
- `sync likes` and `sync bookmarks` use cached live transport; `auto` tries `xurl`, then `bird`

Common flags:
- `--since <cursor-or-id>`
- `--limit <n>`
- `--transport <kind>`
- `--dry-run`
- `--mode auto|xurl|bird`
- `--all`
- `--max-pages <n>`
- `--refresh`
- `--cache-ttl <seconds>`

Examples:

```bash
birdclaw sync likes --mode auto --limit 100 --refresh --json
birdclaw sync bookmarks --mode auto --limit 100 --refresh --json
birdclaw sync bookmarks --mode bird --all --max-pages 5 --limit 100 --refresh --json
```

### `search tweets <query>`

Flags:
- `--author <handle-or-id>`
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
```

### `search dms <query>`

Flags:
- `--conversation <id>`
- `--participant <handle-or-id>`
- `--min-followers <n>`
- `--max-followers <n>`
- `--min-influence-score <n>`
- `--max-influence-score <n>`
- `--sort recent|influence`
- `--replied`
- `--unreplied`
- `--since <date>`
- `--until <date>`
- `--limit <n>`

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
- optionally refreshes live DMs through `bird` before listing

Flags:
- `--refresh`
- `--cache-ttl <seconds>`
- `--participant <handle-or-id>`
- `--min-followers <n>`
- `--max-followers <n>`
- `--min-influence-score <n>`
- `--max-influence-score <n>`
- `--sort recent|influence`
- `--replied`
- `--unreplied`
- `--account <name>`
- `--limit <n>`

### `dms sync`

- refresh live direct messages through `bird`
- merge conversations/messages into the local SQLite store
- supports `--json`

Flags:
- `--account <account-id>`
- `--limit <n>`
- `--refresh`
- `--cache-ttl <seconds>`

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
- accepts handle, `@handle`, X URL, local profile id, or numeric X user id
- attempts live block transport via `xurl` when resolvable
- falls back to the X web cookie session if `xurl` is rejected for OAuth2 block writes
- still records the local block if live transport is unavailable

Flags:
- `--account <account-id>`

### `blocks import <path>`

- import a blocklist file in one call
- reads newline-delimited handles, ids, or X URLs
- ignores blank lines and `#` comments
- tolerates markdown bullets like `- @handle`
- returns per-entry success/failure in `--json`

Flags:
- `--account <account-id>`

### `blocks remove <handle-or-id>`

- remove a local block entry for one account
- attempts live unblock transport via `xurl` when resolvable
- falls back to the X web cookie session if `xurl` is rejected for OAuth2 block writes

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
- accepts handle, `@handle`, X URL, local profile id, or numeric X user id
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
- starts background sync automatically by default
- stdout prints URL in plain mode

Flags:
- `--host <host>`
- `--port <port>`
- `--open`
- `--no-open`
- `--sync`
- `--no-sync`

### `graph summary`

- current graph counts
- inbound/outbound
- mutuals
- recent churn

### `graph events`

- append-only follow/unfollow history
- supports date window filters
- supports `--json`

### `graph mutuals`

- current mutuals
- sortable by recency / follower size / interaction hints later

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
birdclaw dms list --unreplied --min-followers 500 --min-influence-score 90 --sort influence
birdclaw inbox --json
birdclaw serve --sync
birdclaw graph events --json
birdclaw compose reply 1891234567890
```
