---
title: Archive Import
description: "Import a Twitter/X archive into local SQLite — autodiscovery, selective re-imports, full DM mode, bundled media extraction, follower/following parsing, idempotent re-runs, and profile hydration."
---

# Archive import

`birdclaw import archive` parses a Twitter/X archive ZIP and writes everything into the canonical SQLite tables: tweets, likes, bookmarks, profiles, followers/following edges, DMs, bundled media files, and (when present) blocklists.

It is **idempotent**. Re-running on the same archive replays the import without producing duplicates, so you can import, then re-import after a fresh archive download to top up.

By default, archive import is a full archive replay. It refreshes archive-owned data from the ZIP and rebuilds the local rows for all supported archive slices. Use `--select` when you want to refresh only one or two slices from a newer archive while preserving the rest of your local store.

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

- `--select <kinds>` — comma-separated subset of `tweets,likes,bookmarks,profiles,directMessages,followers,following`

`--select` is for targeted re-imports. It clears and replays only the selected archive slices for `acct_primary`, then leaves unselected local data alone. This matters when you have live-synced likes/bookmarks, local replies, another account in the same DB, or a fresh archive that only needs one stale surface refreshed.

Accepted DM aliases:

- `directMessages`
- `directmessages`
- `direct-messages`
- `dms`

Examples:

```bash
birdclaw import archive ~/Downloads/twitter-archive.zip --select tweets,directMessages
birdclaw import archive ~/Downloads/twitter-archive.zip --select likes,bookmarks --json
birdclaw import archive ~/Downloads/twitter-archive.zip --select dms --json
```

Use `--select profiles` when you want archive profile metadata refreshed. When selecting only tweets, likes, bookmarks, DMs, followers, or following, birdclaw preserves compatible existing profile rows and only inserts missing stubs needed for references.

Selected imports validate the existing `acct_primary` account before writing. If the local default account does not match the archive account ID or handle, the command fails instead of merging two identities into one account.

## Full import vs selected import

Full import:

- reads every supported archive file
- refreshes archive-owned tweets, collections, profiles, DMs, and follow edges together
- best for a clean first import or a deliberate full archive refresh

Selected import:

- reads only the selected archive data plus the small account/profile baseline needed to validate identity and resolve references
- clears only rows owned by the selected slice
- preserves unselected tweets, DMs, likes/bookmarks, live collection rows, profile metadata, and other accounts

Typical targeted re-imports:

```bash
# New archive has fresher original tweets, but keep live likes/bookmarks.
birdclaw import archive ~/Downloads/twitter-archive.zip --select tweets --json

# Refresh saved-post collections without touching DMs or follow graph.
birdclaw import archive ~/Downloads/twitter-archive.zip --select likes,bookmarks --json

# Rebuild DM search after downloading a newer archive.
birdclaw import archive ~/Downloads/twitter-archive.zip --select directMessages --json

# Refresh archive follow graph only.
birdclaw import archive ~/Downloads/twitter-archive.zip --select followers,following --json
```

## Bundled media files

Archive ZIPs ship the actual image and video files for every media kind X exports. `import archive` streams them out of the ZIP and into the local originals cache:

```text
~/.birdclaw/media/originals/archive/<kind>/<id>/<filename>
```

`<kind>` is one of the seven archive media kinds X currently exports:

- `tweets` — tweet image and video attachments (`data/tweets_media/`)
- `dms` — 1:1 DM attachments (`data/direct_messages_media/`)
- `community` — Community-tweet attachments (`data/community_tweet_media/`)
- `deleted` — attachments on tweets the user has since deleted (`data/deleted_tweets_media/`)
- `profile` — profile banner and avatar history (`data/profile_media/`)
- `moments` — moments-tweet attachments (`data/moments_tweets_media/`)
- `dmGroup` — group DM attachments (`data/direct_messages_group_media/`)

`<id>` is the parent tweet or DM event id. `<filename>` is the original file name X chose. Extraction is idempotent: a file is rewritten only if its size on disk differs from the size in the ZIP.

## video_info.variants extraction

Archive tweet rows ship `extended_entities.media[].video_info.variants[]` for every video and animated GIF. `import archive` lifts that array onto each media row's `media_json` payload so:

- `birdclaw search tweets` and the local web UI can render archive video without a live call
- downstream live media fetchers can pick the highest-bitrate mp4 from `variants[]` rather than re-deriving the URL

Bitrate, content type, and URL fields stay verbatim from the archive, so a fresh archive download replaces stale variants on re-import.

## Follower and following edges

When the archive ships with `data/follower.js` and `data/following.js`, `import archive` parses both files and writes the rows into the same local follow graph that [`sync followers`](sync.md#sync-followers-following) and `sync following` populate:

- each entry becomes a stub `profiles` row plus a current `follow_edges` row
- counts land in the archive-import result envelope under `counts.followers` and `counts.following`
- re-importing the same archive is a no-op; switching to a fresher archive tops up new edges

A fresh install with just an archive and no live transport still gets a usable [follow graph](follow-graph.md). `birdclaw graph summary`, `graph mutuals`, and `graph top-followers` all work against archive-imported edges. Live `sync followers --yes` can layer churn on top later.

## Hydrate profiles

The archive ships with stale profile metadata (bios, follower counts, avatars from years ago). Hydrate from live Twitter when you can:

```bash
birdclaw import hydrate-profiles --json
```

This walks the imported profiles table and refreshes each entry through whichever transport is available (`xurl` first, `bird` second). On large archives, that can mean hundreds or thousands of live X profile reads and may spend API credits. Without a live transport, hydration is a no-op and the archive's snapshot stays.

Avatars are written to `~/.birdclaw/media/thumbs/avatars/` so the web UI does not re-fetch them on every render.

## What ends up where

After import, archive data and live data live in the same canonical tables. There is no `archive_*` shadow universe.

- **Tweets** → `tweets` table, indexed by FTS5 — searchable via `birdclaw search tweets`
- **Likes** → `tweets` table + a `likes` collection edge — searchable via `--liked`
- **Bookmarks** → `tweets` table + a `bookmarks` collection edge — searchable via `--bookmarked`
- **DMs** → `dm_conversations` and `dm_events` tables, indexed by FTS5 — searchable via `birdclaw search dms`
- **Profiles** → `profiles` table — drives @mention resolution, profile evidence, and DM influence scoring
- **Bundled media** → files on disk under `~/.birdclaw/media/originals/archive/<kind>/<id>/<filename>` for the seven archive media kinds
- **Video variants** → `tweets.media_json[].video_info.variants[]` carries the mp4 URL list for every archive video and animated GIF
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
