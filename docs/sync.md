---
title: Sync
description: "Sync authored tweets, likes, bookmarks, home timeline, mentions, and mention threads into local SQLite via xurl or bird."
---

# Sync

`birdclaw sync` mirrors the live Twitter surfaces you actually use into the local SQLite store. Every sync command:

- pulls from the preferred live transport for the surface; authored sync, timeline, mentions, likes, bookmarks, and follow graph default to `bird`
- writes into the same canonical tables that archive import uses
- refreshes the FTS5 index incrementally
- saves cursors so the next run resumes where the last one stopped
- caches results on cache-backed surfaces so repeat reads do not keep spending the API budget

On a fresh database, import your X archive before the first live sync. The archive replaces Birdclaw's bundled demo identity with your account identity; transport authentication alone does not perform that binding.

## Common flags

Most `sync *` commands accept:

- `--mode auto|xurl|bird` — transport selection; `auto` chooses the preferred transport for that command. `xurl` is used only when explicitly selected or required by the command.
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

`sync authored` is intentionally narrower: `--mode bird|xurl`, `--limit`, `--max-pages`, `--since-id`, `--until-id`, `--account`, and `--json`. `bird` is the default; pass `--mode xurl` for `--since-id` or `--until-id`.

## sync authored

Mirror the authenticated user's authored timeline through `bird` by default, or through `xurl` when explicitly selected. Retweets are included and stored with their X `referenced_tweets` marker intact. Bird mode stops once a page reaches the newest tweet already recorded for that account, and keeps its interrupted pagination cursor separate from xurl. The command does not audit old rows or detect deletes.

On a first xurl run with no authored cursor, Birdclaw seeds `since_id` from the newest local archive-backed tweet authored by that account when one exists. Fresh installs with no local baseline full-scan from X and print a stderr cost hint. Pass `--mode xurl --since-id <id>` to override the archive seed deliberately.

```bash
birdclaw sync authored --limit 100 --json
birdclaw sync authored --account acct_primary --limit 100 --json
birdclaw sync authored --mode xurl --since-id 123 --limit 100 --json
```

Authored tweets land in the canonical `tweets` table and get an `authored` account edge, so shared tweets can also remain home, mention, liked, or bookmarked rows for the same or another account.

## sync likes

Mirror the authenticated user's Likes feed:

```bash
birdclaw sync likes --mode auto --limit 100 --refresh --json
birdclaw sync likes --mode bird --all --max-pages 5 --refresh --json
birdclaw sync likes --mode auto --limit 100 --max-pages 5 --early-stop --refresh --json
```

Liked tweets land in the same `tweets` table as archive imports and can be queried with `birdclaw search tweets --liked`.

`--early-stop` only applies in explicit `--mode xurl`. It halts pagination as soon as one fetched page is 100% already in the local store. Pair it with `--max-pages` on a cron loop: the first run after a long absence walks back as far as `--max-pages` allows, every subsequent run stops at the first saturated page and spends one X API page read instead of `--max-pages` of them. If neither `--all` nor `--max-pages` is present, Birdclaw applies a 10-page cap.

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

## sync mentions

Mirror the authenticated user's mentions feed into local SQLite. This is the cron-friendly ingest path that populates `kind='mention'` rows the rest of the pipeline expects:

```bash
birdclaw sync mentions --mode xurl --limit 100 --max-pages 3 --refresh --json
birdclaw sync mentions --mode bird --limit 50 --json
```

Flags:

- `--account <accountId>` — pick the account when multiple are configured
- `--mode bird|xurl|auto` — transport; defaults to `bird` through `auto`
- `--limit <n>` — page size
- `--max-pages <n>` — cap a paged scan; partial truncation exits with code `5`
- `--since-id <id>` — explicitly fetch mentions newer than a known tweet ID
- `--start-time <iso>` — backfill mentions from an explicit UTC timestamp
- `--refresh` — bypass the live-cache freshness window
- `--cache-ttl <seconds>` — tune the live-cache freshness window (default `120`)

On an explicit xurl run without `--since-id` or `--start-time`, Birdclaw seeds `since_id` from the newest archive/legacy mention row for that account so archive-backed stores do not re-fetch old mentions. Live-only mention edges are not used as a baseline because they may be partial. Use `--mode xurl --start-time` for deliberate historical backfills; an explicit `--since-id` always wins. Bird mode does not support `--since-id` or `--start-time`.

`sync mentions` and [`mentions export`](mentions.md) are now distinct: `sync mentions` is the ingest, `mentions export` is the DB-backed export-to-script view. Run `sync mentions` first, then [`sync mention-threads`](#sync-mention-threads) to backfill parent/root conversation context.

## sync mention-threads

Fetch conversation context for recent mentions through `bird` by default, with `xurl` as a fallback when bird is unavailable:

```bash
birdclaw sync mention-threads --limit 30 --delay-ms 1500 --timeout-ms 15000 --json
birdclaw sync mention-threads --mode xurl --limit 30 --json
```

Flags:

- `--mode bird|xurl` — transport; defaults to `bird`
- `--delay-ms <ms>` — delay between thread fetches; raise this when X starts rate-limiting (bird mode)
- `--timeout-ms <ms>` — per-thread network timeout
- `--all`, `--max-pages <n>` — paged thread retrieval

This is the gentlest sync command on purpose. It walks back up the reply chain so the web UI can render quoted ancestors without a separate live call later.

The `xurl` mode is for users who do not have the `bird` CLI installed. It uses `/2/tweets/search/recent` keyed on `conversation_id`, with a 12-hop parent-walk fallback for threads outside the 7-day search window. Output carries a `generalReadTweets` cost counter so cron runs can budget against the X API rate limit.

Prerequisite: run [`sync mentions`](#sync-mentions) first so the recent mention rows exist locally; `sync mention-threads` walks those rows.

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

DMs sit on a separate command. The current `bird` CLI does not expose DM reads or message-request mutations, so live DM sync must be explicitly xurl and only covers recent accepted OAuth2 DM events:

```bash
birdclaw dms sync --mode xurl --limit 50 --refresh --json
birdclaw dms list --refresh --limit 10 --json
```

See [DMs](dms.md) for the full triage workflow.

## Mentions

`sync mentions` is the canonical ingest path. `mentions export` is the DB-backed export-to-script view that reads what `sync mentions` wrote. See [Mentions](mentions.md) for the full pipeline.

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
