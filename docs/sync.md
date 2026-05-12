---
title: Sync
description: "Sync likes, bookmarks, home timeline, and mention threads into local SQLite via xurl or bird."
---

# Sync

`birdclaw sync` mirrors the live Twitter surfaces you actually use into the local SQLite store. Every sync command:

- pulls from the best live transport for the surface; follow graph sync prefers `bird`, while likes/bookmarks still try `xurl` before `bird`
- writes into the same canonical tables that archive import uses
- refreshes the FTS5 index incrementally
- saves cursors so the next run resumes where the last one stopped
- caches results so repeat reads do not keep spending the API budget

## Common flags

All `sync *` commands accept:

- `--mode auto|xurl|bird` — transport selection; `auto` chooses the preferred transport for that command and falls back when possible
- `--limit <n>` — page size in `xurl` mode, total in single-page modes
- `--all` — keep paginating until the retrievable window is exhausted
- `--max-pages <n>` — cap a paged scan; implies `--all`
- `--early-stop` — on `sync likes` and `sync bookmarks`, stop paging once a fetched page is 100% already local (dedupe saturation); without `--all` or `--max-pages`, caps at 10 pages
- `--refresh` — bypass the cache and force a live fetch
- `--cache-ttl <seconds>` — tune freshness without forcing a full refresh
- `--since <cursor-or-id>` — resume from a known cursor or tweet ID
- `--transport <kind>` — alias for `--mode` on some subcommands
- `--dry-run` — read but do not write
- `--json` — stable machine-readable output

## sync likes

Mirror the authenticated user's Likes feed:

```bash
birdclaw sync likes --mode auto --limit 100 --refresh --json
birdclaw sync likes --mode bird --all --max-pages 5 --refresh --json
birdclaw sync likes --mode auto --limit 100 --max-pages 5 --early-stop --refresh --json
```

Liked tweets land in the same `tweets` table as archive imports and can be queried with `birdclaw search tweets --liked`.

`--early-stop` halts pagination as soon as one fetched page is 100% already in the local store. Pair it with `--max-pages` on a cron loop: the first run after a long absence walks back as far as `--max-pages` allows, every subsequent run stops at the first saturated page and spends one X API page read instead of `--max-pages` of them. If neither `--all` nor `--max-pages` is present, Birdclaw applies a 10-page cap.

## sync bookmarks

Mirror Bookmarks:

```bash
birdclaw sync bookmarks --mode auto --limit 100 --refresh --json
birdclaw sync bookmarks --mode bird --all --max-pages 5 --limit 100 --refresh --json
birdclaw sync bookmarks --mode auto --limit 100 --max-pages 5 --early-stop --refresh --json
```

Bookmarks are queried via `birdclaw search tweets --bookmarked` and drive the [research](research.md) workflow.

`--early-stop` behaves the same way as on `sync likes`: stop paging when a full page is already locally known. Recommended default for any scheduled bookmark sync against a stable account.

## sync timeline

Pull the chronological Following timeline through `bird`:

```bash
birdclaw sync timeline --limit 100 --refresh --json
```

`sync timeline` defaults to the chronological feed, not the algorithmic For You. The home timeline is stored in the same `tweets` table so search, filters, and the web UI's `Home` lane all see one set of rows.

## sync mention-threads

Fetch conversation context for recent mentions through `bird thread`:

```bash
birdclaw sync mention-threads --limit 30 --delay-ms 1500 --timeout-ms 15000 --json
```

Extra flags:

- `--delay-ms <ms>` — delay between thread fetches; raise this when X starts rate-limiting
- `--timeout-ms <ms>` — per-thread network timeout

This is the gentlest sync command on purpose. It walks back up the reply chain so the web UI can render quoted ancestors without a separate live call later.

## sync followers / following

Followers and following are first-class entities with append-only history. Both syncs record current state plus a `follow_events` row for every change.

```bash
birdclaw sync followers --json
birdclaw sync following --json
birdclaw sync followers --yes --json
birdclaw sync following --yes --json
```

The first two commands are dry runs. Live fetches require `--yes`; pass `--refresh` only when you intentionally want to bypass the 24-hour follow-graph cache. `auto` prefers `bird` for followers/following because the browser-cookie GraphQL path works when OAuth2 follow reads are unavailable.

After the first run, `birdclaw graph events` shows the diff log and `birdclaw graph mutuals` lists current mutuals.

## sync all

```bash
birdclaw sync all --transport xurl
birdclaw sync all --transport auto
```

`sync all` runs every individual sync in a sane order (likes → bookmarks → timeline → mention-threads → followers → following). It is resumable and rate-limit-aware: if Twitter slows you down, it persists the cursor and exits with code `5` (partial sync) so a scheduler can retry.

## DMs sync

DMs sit on a separate command because they need `bird` for full-content reads:

```bash
birdclaw dms sync --limit 50 --refresh --json
birdclaw dms list --refresh --limit 10 --json
```

See [DMs](dms.md) for the full triage workflow.

## Mentions

`birdclaw mentions export` is both a live cache fetcher and an agent-friendly export format. See [Mentions](mentions.md).

## Caching model

Every cached live mode (`--mode bird` or `--mode xurl`) stores the response in SQLite alongside the canonical normalized rows. Subsequent reads return from cache until the TTL elapses or you pass `--refresh`.

Cache rules:

- the canonical store is always the source of truth for filters and search
- the response cache is what `--mode xurl` returns for `xurl`-shape compatibility
- `--refresh` purges the response cache for that surface and refetches
- `--cache-ttl <seconds>` overrides the default freshness window
- write commands invalidate any read cache that overlaps the write

This is what lets `birdclaw mentions export --mode xurl` mirror the `xurl mentions` JSON shape without re-hitting the live API every time.

## Exit codes

- `0` — success
- `4` — transport unavailable (e.g. `xurl` not installed and `--mode xurl`)
- `5` — partial sync; resume with `--since <cursor>` or just re-run

See also: [CLI reference for sync](cli.md#sync) for the canonical flag list.
