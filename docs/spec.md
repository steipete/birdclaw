# birdclaw Spec

Status: draft 3
Owner: Peter Steinberger
Repo: `steipete/birdclaw`

## One-liner

`birdclaw` is a local-first Twitter archive and operator console:
- import full account archives
- auto-find archives on disk when present
- work well without an archive by syncing everything possible and waiting through rate limits
- sync tweets, likes, bookmarks, mentions, followers, following, and DMs
- cache media locally
- search all history fast, offline
- provide an AI-sorted inbox so Twitter is less chaotic
- let the user read, draft, and reply from a local web app or CLI
- maintain account-scoped block and mute lists with add/remove flows

## Goals

- full personal archive in local SQLite
- one shared local database for multiple accounts from day 1
- default storage root in `~/.birdclaw` with config override
- fast offline search for tweets and DMs
- incremental sync so local state stays current
- full sync path that is resumable and rate-limit-aware
- followers/following modeled with current state plus history
- CLI for scripts and automation
- local web app for home timeline, mentions/replies, DMs, triage, reply, and AI-assisted workflows
- local blocklist and mutelist maintenance for multiple accounts
- clean minimal UI that keeps focus on tweet/message content
- system/light/dark theme switcher with persisted local preference and smooth transition
- DMs surface sender bio and influence context without extra hunting
- block/mute actions should be local-first and transport-aware
- easy agent access to archive and live data via filters and structured output
- reuse proven pieces from `sweetistics`, `bird`, and `xurl`
- OSS-friendly setup and npm distribution

## Non-goals

- multi-tenant SaaS
- cloud-required backend
- perfect parity with every Twitter surface on day 1
- custom mobile app in v1
- heavy vector infra in v1

## Decisions

- language: TypeScript
- runtime: Node 25.8.1 with pnpm workspace
- database: SQLite
- query layer: Kysely
- search: FTS5 day 1
- UI: React
- local app shell: TanStack Start
- import/source priority: archive first when available
- live transport priority: `xurl` first, `bird` second, official third, experimental `xweb` later
- product shape: shared core for CLI + local web app
- multi-account from day 1
- DM default: `full`
- media cache: originals + thumbnails
- `serve` should background sync automatically
- local app auth: none by default; local-only app
- archive discovery on macOS: Spotlight (`mdfind`) first, plus Sweetistics-style filename/path heuristics
- no-archive mode is first-class, not fallback
- long-running syncs must be resumable and wait through rate limits automatically
- followers/following are first-class entities with history from day 1
- OpenAI is the day-1 AI provider for ranking / low-signal filtering
- DM triage filters include sender follower count and derived influence score

## Why TypeScript

- direct reuse from `sweetistics`
- direct reuse from `bird`
- one type system across CLI, server, UI, sync, and ranking
- easier npm distribution
- faster path to AI-assisted features

## Stack

### Runtime / workspace

- Node.js 25.8.1
- pnpm workspace
- TypeScript `strict: true`
- ESM only
- latest stable dependencies at scaffold time

### Tooling

- formatter: `oxfmt`
- linter: `oxlint`
- tests: `vitest`
- migrations: checked-in SQL or Kysely migrator

### App shell

- React
- TanStack Start for local full-stack routing/server functions

Note:
- TanStack Start is still presented by TanStack as RC as of March 8, 2026.
- fallback if needed later: thin Vite + Express/Hono local server

## Product Shape

Two surfaces, one core:

1. CLI
   - import archives
   - auto-discover archives on disk
   - run sync jobs
   - search and inspect records
   - expose stable filtered `--json` output for agents
   - inspect the follow graph and churn history
   - script/agent-friendly
2. Local web app
   - read home timeline
   - read mentions / replies
   - read tweets / threads / DMs
   - maintain block and mute lists
   - triage AI-ranked inbox
   - filter replied vs unreplied items
   - filter DMs by sender follower count and derived influence score
   - filter low-signal items out
   - draft replies/posts
   - inspect sync state and transport health
   - inspect follower/following graph changes over time

## Reuse Plan

### From `sweetistics`

- archive parsing shape from `packages/archive-core`
- Spotlight-based archive discovery shape from CLI archive finder
- DM normalized schema ideas
- follow graph history model
- provider-neutral client seam
- canonical normalized ingest pipeline
- search capability design

Do not copy:
- Better Auth
- Next.js app surface
- Inngest
- cloud/vector infra

### From `bird`

- CLI tone and flag ergonomics
- output modes: human vs `--json` vs `--plain`
- cursor pagination and retry logic
- GraphQL/cookie-backed capability adapter

### From `xurl`

- optional transport adapter
- optional auth piggyback
- raw endpoint access via subprocess

Do not make `birdclaw` depend on `xurl` or `bird` internals as its core architecture.

## Architecture

```text
archive zip / xurl / bird / official API / xweb
                    ↓
             transport adapters
                    ↓
          normalized domain mappers
                    ↓
             canonical write pipeline
                    ↓
 SQLite + FTS5 + media cache + raw blobs + graph history
                    ↓
   CLI / local server / React frontend / agent API
                    ↓
   OpenAI ranking, low-signal scoring, summaries, triage
```

Core rule:
- all sources map into one normalized model
- no separate `archive_*` shadow universe as primary truth
- raw source payloads may be retained, but canonical tables stay canonical

## Docs

- architecture + schema + transport: [data-architecture.md](./data-architecture.md)
- CLI spec: [cli.md](./cli.md)

## MVP

Includes:
- archive import
- archive autodiscovery on disk
- no-archive sync path
- sync home timeline, mentions/replies, DMs, bookmarks, likes, followers, following
- offline search
- local web app
- home timeline view
- mentions/replies view
- DM view
- blocklist view
- CLI mute support
- replied/unreplied filters
- DM sender bio/context rail
- DM follower-count + influence-score filters
- inbox prototype
- low-signal AI scoring prototype
- follow graph dashboard and churn history
- media cache with originals + thumbnails
- multi-account support
- shared agent query surface
- compose/reply via transport

Excludes:
- vector search
- full notifications parity
- teams/multi-user
- cloud-required backend

## Storage Model

- default root: `~/.birdclaw`
- configurable root via CLI/config
- one shared SQLite database for all configured accounts
- per-account config, cursors, auth snapshots, and transport preferences live inside the shared root
- media cache stored under the same root with original files plus thumbnail derivatives

## Sync Modes

1. Archive-assisted
   - import archive first when found
   - then fill gaps via live transports
2. Live-first
   - no archive required
   - sync as much as possible via `xurl`
   - wait through rate limits
   - resume from saved cursors/jobs until local state is complete enough

Both modes are first-class and must converge on the same canonical tables.

## Archive Discovery

- on macOS, use Spotlight (`mdfind`) to search for likely Twitter archive zip files
- reuse the Sweetistics-style heuristic set:
  - search `~/Downloads` first
  - then Spotlight in the user home directory
  - prefer names like `twitter-*.zip`, `x-*.zip`, `*archive*.zip`
- allow explicit archive path override in CLI and web flows

## Web UI Principles

- modern, minimal, clean
- focus on content density and reading flow, not dashboard chrome
- primary views:
  - home
  - mentions / replies
  - DMs
- common filters:
  - replied / unreplied
  - account
  - date/window
  - with media
  - sender min/max follower count
  - AI low-signal hidden / shown
  - read/unread or acted/dismissed later
- DM requirement:
  - sender bio and influence context should stay visible without opening a separate profile screen
  - influence should start with follower count and allow later expansion to richer ranking

## Agent Surfaces

- CLI commands must support stable filtered `--json`
- local HTTP/API surface should expose the same underlying query model
- agent use cases should include:
  - load tweet windows by filter
  - load DMs by participant/date/filter
  - load DMs by sender follower-count window
  - fetch replied/unreplied queues
  - fetch AI-ranked actionable items

## AI Ranking

- provider: OpenAI
- key source: shell environment / `.profile`
- block/unblock/mute/unmute writes follow the same live transport safety rules as compose/reply
- day-1 AI features:
  - score tweets/messages for signal
  - allow filtering low-signal items out of inbox/views
  - rank mentions/DMs/home items for actionability
- design requirement:
  - every scored item should retain the raw canonical record
  - AI scores are overlays, not source-of-truth mutations

## Recommendation Summary

Build `birdclaw` as:
- TypeScript
- pnpm workspace
- React + TanStack Start
- SQLite + Kysely + FTS5
- shared multi-account DB in `~/.birdclaw`
- `xurl` adapter first
- `bird` and official adapters after that
- full DMs by default
- media cache with originals + thumbs
- follow graph with history from day 1
- archive import from day 1
- archive autodiscovery from day 1
- no-archive resumable sync from day 1
- CLI + local web app sharing one core
- local-only app, no general auth layer
- OpenAI ranking for low-signal filtering and inbox triage
