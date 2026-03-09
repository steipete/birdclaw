# birdclaw

`birdclaw` is a local-first X workspace: archive import, cached live reads, focused triage, and reply flows in one local web app + CLI.

Status: WIP. Real and usable. Not done. Expect schema churn, transport gaps, and rough edges while the core settles.

## What It Does

- keeps your X data in local SQLite
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
- profile hydration from live X metadata
- local avatar cache
- local media cache root under `~/.birdclaw`

### Web UI

- `Home` timeline
- `Mentions` queue
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

### Actions

- post tweets
- reply to tweets
- reply to DMs
- add / remove local blocks
- add / remove local mutes
- sync remote blocks through `xurl` when available

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

- `Home`: read and reply without fighting the main X timeline
- `Mentions`: work the reply queue with clean filters
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

- Node `24.12.0`
- `pnpm`
- macOS recommended for Spotlight archive discovery
- `xurl` optional for live reads / writes
- OpenAI API key optional for inbox scoring

## Install

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
pnpm cli init
pnpm cli auth status --json
pnpm cli db stats --json
```

Find and import an archive:

```bash
pnpm cli archive find --json
pnpm cli import archive --json
pnpm cli import archive ~/Downloads/twitter-archive-2025.zip --json
pnpm cli import hydrate-profiles --json
```

Start the app:

```bash
pnpm dev
```

## CLI Highlights

### Search local tweets

```bash
pnpm cli search tweets "local-first" --json
pnpm cli search tweets "sync engine" --limit 20 --json
```

### Export mentions for agents

Default `birdclaw` mode returns normalized items with `text`, `plainText`, `markdown`, author metadata, and canonical URLs:

```bash
pnpm cli mentions export "agent" --unreplied --limit 10
```

`xurl` mode returns `xurl`-compatible `data/includes/meta`, but cached locally so repeat reads do not keep spending API calls:

```bash
pnpm cli mentions export --mode xurl --limit 5
pnpm cli mentions export --mode xurl --refresh --limit 5
pnpm cli mentions export "courtesy" --mode xurl --limit 5
```

Notes:

- `--refresh` forces a live fetch
- `--cache-ttl <seconds>` tunes freshness
- filters still work in `xurl` mode; filtered payloads are rebuilt from the local canonical store after sync

### Search and triage DMs

```bash
pnpm cli search dms "prototype" --json
pnpm cli search dms "layout" --min-followers 1000 --min-influence-score 120 --sort influence --json
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
pnpm cli blocks add @amelia --account acct_primary --json
pnpm cli blocks remove @amelia --account acct_primary --json
pnpm cli ban @amelia --account acct_primary --json
pnpm cli unban @amelia --account acct_primary --json
```

### Mutes

```bash
pnpm cli mutes list --account acct_primary --json
pnpm cli mute @amelia --account acct_primary --json
pnpm cli unmute @amelia --account acct_primary --json
```

### Compose / reply

```bash
pnpm cli compose post "Ship local software."
pnpm cli compose reply tweet_004 "On it."
pnpm cli compose dm dm_003 "Send it over."
```

## Typical Workflow

1. import your archive if you have one
2. hydrate imported profiles from live X metadata
3. use `Home` for reading
4. use `Mentions` for reply triage
5. use `DMs` for high-context conversation work
6. use `Inbox` when you want AI help cutting noise
7. use CLI exports when agents need stable JSON

## Live Transport

Current preference:

- `xurl` first

Without `xurl`, `birdclaw` still works in local/archive mode.

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
fnm exec --using 24.12.0 pnpm check
fnm exec --using 24.12.0 pnpm test
fnm exec --using 24.12.0 pnpm coverage
fnm exec --using 24.12.0 pnpm build
fnm exec --using 24.12.0 pnpm e2e
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

Workflow: [ci.yml](/Users/steipete/Projects/birdclaw/.github/workflows/ci.yml)

## Docs

- [spec.md](/Users/steipete/Projects/birdclaw/docs/spec.md)
- [cli.md](/Users/steipete/Projects/birdclaw/docs/cli.md)
- [data-architecture.md](/Users/steipete/Projects/birdclaw/docs/data-architecture.md)
