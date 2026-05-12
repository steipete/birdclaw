---
title: Archive Import
description: "Import a Twitter/X archive into local SQLite — autodiscovery, full DM mode, follower/following parsing, idempotent re-runs, and profile hydration."
---

# Archive import

`birdclaw import archive` parses a Twitter/X archive ZIP and writes everything into the canonical SQLite tables: tweets, likes, bookmarks, profiles, followers/following edges, DMs, and (when present) blocklists.

It is **idempotent**. Re-running on the same archive replays the import without producing duplicates, so you can import, then re-import after a fresh archive download to top up.

## Get an archive

Twitter / X publishes account archives at <https://x.com/settings/your_archive>. Requesting one takes ~24 hours; you receive a download link in email.

Save the ZIP somewhere autodiscovery can find it (`~/Downloads` is fastest), or pass an explicit path.

## Autodiscovery

On macOS, archives are autodiscovered via Spotlight (`mdfind`) plus name heuristics borrowed from Sweetistics:

```bash
birdclaw archive find --json
```

This searches `~/Downloads` first, then runs an `mdfind` pass under `$HOME` for files matching `twitter-*.zip`, `x-*.zip`, and `*archive*.zip`.

The result lists every plausible candidate so you can confirm before importing.

## Import

```bash
birdclaw import archive --json
birdclaw import archive ~/Downloads/twitter-archive-2025.zip --json
```

Flags:

- `--select <kinds>` — subset of `tweets,likes,bookmarks,profiles,directMessages,blocks`
- `--dm-mode metadata|full` — default is `full`; `metadata` skips message bodies for speed
- `--dry-run` — analyze without writing
- `--force` — re-import even if a manifest hash matches a previous run

Examples:

```bash
birdclaw import archive ~/Downloads/twitter-archive.zip --select tweets,directMessages
birdclaw import archive ~/Downloads/twitter-archive.zip --dm-mode metadata --json
birdclaw import archive ~/Downloads/twitter-archive.zip --dry-run --json
```

## Follower and following edges

When the archive ships with `data/follower.js` and `data/following.js`, `import archive` parses both files and writes the rows into the same local follow graph that [`sync followers`](sync.md#sync-followers--following) and `sync following` populate:

- each entry becomes a stub `profiles` row plus a current `follow_edges` row
- counts land in the archive-import result envelope under `followGraph.followersCount` and `followGraph.followingCount`
- re-importing the same archive is a no-op; switching to a fresher archive tops up new edges

A fresh install with just an archive and no live transport still gets a usable [follow graph](follow-graph.md). `birdclaw graph summary`, `graph mutuals`, and `graph top-followers` all work against archive-imported edges. Live `sync followers --yes` can layer churn on top later.

## Hydrate profiles

The archive ships with stale profile metadata (bios, follower counts, avatars from years ago). Hydrate from live Twitter when you can:

```bash
birdclaw import hydrate-profiles --json
```

This walks the imported profiles table and refreshes each entry through whichever transport is available (`xurl` first, `bird` second). Without a live transport, hydration is a no-op and the archive's snapshot stays.

Avatars are written to `~/.birdclaw/media/thumbs/avatars/` so the web UI does not re-fetch them on every render.

## What ends up where

After import, archive data and live data live in the same canonical tables. There is no `archive_*` shadow universe.

- **Tweets** → `tweets` table, indexed by FTS5 — searchable via `birdclaw search tweets`
- **Likes** → `tweets` table + a `likes` collection edge — searchable via `--liked`
- **Bookmarks** → `tweets` table + a `bookmarks` collection edge — searchable via `--bookmarked`
- **DMs** → `dm_conversations` and `dm_events` tables, indexed by FTS5 — searchable via `birdclaw search dms`
- **Profiles** → `profiles` table — drives @mention resolution, profile evidence, and DM influence scoring
- **Followers/Following** → `profiles` stub rows plus current `follow_edges` rows; surfaced via `birdclaw graph *`
- **Affiliations** → `profile_affiliations` table when live profile hydration exposes X badge/highlighted-label organization metadata
- **Profile history** → `profile_snapshots` table after live hydration observes profile/bio/affiliation changes
- **Bio entities** → `profile_bio_entities` table for extracted `@handle`, domain, and company-phrase identity hints
- **Blocks** (when present in the archive export) → `blocks` table per account

Tweets whose archive timestamps are missing or impossible (`1970-01-01` rows) get bucketed into `data/tweets/unknown.jsonl` on backup export rather than pretending they belong to 1970.

## After import

```bash
birdclaw db stats --json
birdclaw search tweets "ship local software" --limit 5 --json
birdclaw search tweets --liked --limit 20 --json
```

`db stats` prints row counts per table and the schema version so you can confirm the import landed.

## See also

- [Sync](sync.md) — top up archive data with cached live reads
- [Search](search.md) — FTS5 over tweets and DMs
- [Backup](backup.md) — round-trip the canonical tables to deterministic JSONL shards
