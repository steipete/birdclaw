# birdclaw

Local-first X workspace. Multi-account. SQLite-backed. TanStack Start web UI. CLI + local API.

## Current slice

- home timeline view
- AI inbox view for mixed mentions + DMs
- mentions/replies view
- DM workspace with:
  - sender bio always visible
  - sender follower-count and derived influence-score filters
  - sender bio preview in list + full context rail
  - replied/unreplied filtering
  - inline reply composer
- local storage root in `~/.birdclaw` by default
- archive autodiscovery via Spotlight-style scan on macOS
- local action fallbacks when `xurl` is missing

## Run

Use Node `24.12.0` (`.node-version`).

```bash
fnm use
pnpm install
pnpm dev
```

## CLI

```bash
pnpm cli init
pnpm cli auth status
pnpm cli archive find --json
pnpm cli inbox --score --limit 5 --json
pnpm cli search tweets "local-first" --json
pnpm cli search dms "layout" --min-followers 1000 --min-influence-score 120 --sort influence --json
pnpm cli dms list --unreplied --min-followers 500 --min-influence-score 90 --sort influence --json
pnpm cli compose reply tweet_004 "On it."
pnpm cli compose dm dm_003 "Send it over."
```

## Validation

```bash
fnm exec --using 24.12.0 pnpm test
fnm exec --using 24.12.0 pnpm build
```

## Docs

- [spec.md](/Users/steipete/Projects/birdclaw/docs/spec.md)
- [cli.md](/Users/steipete/Projects/birdclaw/docs/cli.md)
- [data-architecture.md](/Users/steipete/Projects/birdclaw/docs/data-architecture.md)
