---
title: Bird-First Status
description: "Current bird-first coverage across sync commands, web sync, and scheduled jobs."
---

# Bird-First Status

This page tracks where Birdclaw is already bird-first, where xurl still remains, and why.

## Status Legend

- `bird-first` - bird is the default or preferred live transport
- `still xurl` - xurl remains the active path for this surface
- `bird unavailable` - bird support is not available yet, so xurl stays
- `not applicable` - no live transport is involved

## Sync Surfaces

| Surface | Current status | Notes |
| --- | --- | --- |
| `sync authored` | `bird-first` | CLI defaults to bird. `xurl` stays available for `--since-id` and `--until-id`. The internal xurl path remains for explicit historical backfills. |
| `sync timeline` | `bird-first` | `auto` prefers bird. Non-default account handling is still account-aware. Bird Following sync supports early-stop against local home rows. |
| `sync mentions` | `bird-first` | CLI and web ingest prefer bird, but xurl remains available and is still used for some historical or fallback cases. |
| `sync mention-threads` | `bird-first` | Bird CLI exposes `thread`, so the live sync path now uses bird by default. |
| `sync likes` | `bird-first` | `auto` resolves to bird and the bird transport is the preferred path. Bird and xurl collection syncs support saturated-page early-stop. |
| `sync bookmarks` | `bird-first` | Same as likes. |
| `sync followers` / `sync following` | `bird-first` | `auto` prefers bird and falls back to xurl when needed. |
| `dms sync` / `dms list` | `bird unavailable` | The current bird CLI does not expose DM reads or sends, so xurl is still required for read-side live DM work. |

## Scheduled Jobs

| Job | Current status | Notes |
| --- | --- | --- |
| `jobs sync-account` | `bird-first` | Timeline and mentions prefer bird. Likes and bookmarks now use bird when the account has a bird relay profile name. Timeline, likes, and bookmarks use local-row early-stop in steady state. Mention threads now use bird. DMs remain xurl where needed. |
| `jobs sync-bookmarks` | `bird-first` | Uses the shared collection sync path and therefore prefers bird. |
| `jobs install-account-launchd` | `bird-first` | Installs the account sync job above. |
| `jobs install-bookmarks-launchd` | `bird-first` | Installs the bookmark sync job above. |

## Web Sync

| Endpoint / action | Current status | Notes |
| --- | --- | --- |
| `/api/sync timeline` | `bird-first` | Default account uses bird when configured; account handling remains account-aware. |
| `/api/sync mentions` | `bird-first` | Mentions ingest is bird-first, and mention-thread hydration now uses bird. |
| `/api/sync likes` | `bird-first` | Uses the shared collection path. |
| `/api/sync bookmarks` | `bird-first` | Uses the shared collection path. |
| `/api/sync dms` | `bird unavailable` | Bird does not yet support the needed DM read path. |

## Default Operating Model

The preferred bird-first setup is to keep recent data warm in SQLite, then query
that local store:

```bash
birdclaw accounts set-bird-profile --account acct_openclaw --profile-name work
birdclaw --json jobs install-account-launchd --account acct_openclaw --program /opt/homebrew/bin/birdclaw
birdclaw search tweets "local-first" --since 2026-01-01 --json
birdclaw discuss "local-first" --mode local
birdclaw today
```

`search tweets --since/--until`, `discuss --mode local`, and `today` read local
SQLite rows. They do not perform a live historical backfill. The scheduled job is
the place where live bird reads happen.

## What Still Uses Xurl

- explicit `sync authored --mode xurl --since-id/--until-id`
- explicit digest live refresh with `today --live-sync` or `digest --live-mode xurl`
- bounded timeline and mention backfills such as `sync timeline --mode xurl --start-time` and `sync mentions --mode xurl --since-id/--start-time`
- live search/discuss windows that ask the live transport for `--since/--until`
- profile analysis backfills that page through historical authored tweets and conversations
- DM reads and message-request work

## What This Means

The user-facing defaults are now bird-first for the common live sync surfaces,
and digest/search reads are local by default. The remaining xurl use is
concentrated in explicit bounded historical backfills or unsupported cases rather
than the normal path.
