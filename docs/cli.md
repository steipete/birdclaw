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
- `~/.config/birdclaw/config.json5`

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
birdclaw dms list
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

Common flags:
- `--since <cursor-or-id>`
- `--limit <n>`
- `--transport <kind>`
- `--dry-run`

### `search tweets <query>`

Flags:
- `--author <handle-or-id>`
- `--since <date>`
- `--until <date>`
- `--liked`
- `--bookmarked`
- `--limit <n>`

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

### `dms list`

- list DM conversations or events without requiring a full-text query
- optimized for agent and operator filtering

Flags:
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

### `inbox`

- show AI-ranked actionable queue
- supports `--json`
- supports `--limit`
- supports `--kind mentions|dms|mixed`
- supports replied/unreplied filters
- supports `--score` to refresh stored OpenAI scores before listing
- supports `--min-score` and `--hide-low-signal`

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
birdclaw search dms "invoice" --participant @someone --min-followers 1000
birdclaw dms list --unreplied --min-followers 500 --min-influence-score 90 --sort influence
birdclaw inbox --json
birdclaw serve --sync
birdclaw graph events --json
birdclaw compose reply 1891234567890
```
