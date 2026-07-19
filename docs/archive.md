---
title: Archive Import
description: "Import a Twitter/X archive into local SQLite — autodiscovery, selective re-imports, full DM mode, bundled media extraction, follower/following parsing, idempotent re-runs, and profile hydration."
---

# Archive import

`birdclaw import archive` parses a Twitter/X archive ZIP and writes everything into the canonical SQLite tables: tweets, likes, bookmarks, profiles, followers/following edges, DMs, bundled media files, and (when present) blocklists.

It is **idempotent and merge-safe**. Re-running on the same archive does not produce duplicates, and importing a newer or incomplete archive preserves destination-only rows by default.

By default, archive import merges all supported slices from the ZIP. Use `--select` to merge only one or two slices, or add `--restore` when you deliberately want the imported slices to replace local state exactly.

## Get an archive

On a fresh Birdclaw database, archive import establishes the account identity required by live sync. Do not sync an empty database before importing your archive. To replace the synthetic identity created by `init --demo`, use `import archive --restore`. An archive is optional only when restoring an existing Birdclaw database or backup that already contains the correct account.

Request flow:

1. Sign in to x.com and go to <https://x.com/settings/download_your_data> (also reachable via _Settings and privacy → Your account → Download an archive of your data_).
2. Re-enter your password and complete 2FA if prompted.
3. Click _Request archive_. X queues the export and emails a download link when it is ready. [X Help](https://help.x.com/en/managing-your-account/how-to-download-your-x-archive) says preparation may take a few days.
4. When the email arrives (subject: _Your X data is ready to download_), open the link, sign in again, and download the ZIP. Typical filename: `twitter-YYYY-MM-DD-<hash>.zip`.
5. Save the ZIP into `~/Downloads` so autodiscovery picks it up, or note its path and pass it explicitly to `import archive`.

The archive is a point-in-time snapshot. You can request a fresh one later and use `--select` (see below) to merge a single slice without wiping the rest of your local store.

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
- `--restore` — exactly replace the imported slices instead of merging them

`--select` is for targeted re-imports. It merges only the selected archive slices for `acct_primary`, then leaves unselected local data alone. This matters when you have live-synced likes/bookmarks, local replies, another account in the same DB, or a fresh archive that only needs one stale surface refreshed.

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
birdclaw import archive ~/Downloads/twitter-archive.zip --restore --json
```

Use `--select profiles` when you want archive profile metadata refreshed. When selecting only tweets, likes, bookmarks, DMs, followers, or following, birdclaw preserves compatible existing profile rows and only inserts missing stubs needed for references.

Every merge import validates the existing `acct_primary` account before writing. If the local default account does not match the archive account ID or handle, the command fails instead of merging two identities into one account. An explicit full `--restore` is the only mode that may replace that identity.

## Full import vs selected import

Full import:

- reads every supported archive file
- merges archive-owned tweets, collections, profiles, DMs, and follow edges together
- best for a clean first import or topping up from a newer archive

Selected import:

- reads only the selected archive data plus the small account/profile baseline needed to validate identity and resolve references
- merges only rows owned by the selected slice
- preserves destination-only and unselected tweets, DMs, likes/bookmarks, live collection rows, profile metadata, and other accounts

Explicit restore:

- clears portable rows owned by the imported full or selected slices before replaying the archive
- removes destination-only rows in those slices, so use it only when exact replacement is intended
- remains identity-scoped for selected imports and preserves unselected slices

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

# Deliberately replace only the archive-owned tweet slice.
birdclaw import archive ~/Downloads/twitter-archive.zip --select tweets --restore --json
```

## Deletions and edit history

Archive absence is not deletion. A tweet that disappears from a home or authored timeline may still exist on X, so a later snapshot that simply does not contain a stored tweet leaves that tweet active locally.

Birdclaw creates a tombstone only from an explicit archive deleted-tweet record. The canonical tweet row retains `deleted_at`, a deletion source, and a reason; active search and timeline reads exclude it. Media identifiers and quoted-tweet relationships belonging to that parent receive subordinate tombstones so deleted content does not leak through media fetching or relationship views.

When X exposes an edit-history ID chain, Birdclaw records the ordered revision identities. The raw body is attached only to a revision actually observed in the archive or a live payload; unobserved earlier IDs remain lossless identity stubs rather than invented content. Superseded bodies stay retained but disappear from active timelines, search, links, and media fetching. An explicit deletion of any observed revision tombstones the whole edit chain. Tombstones and revisions are included in portable backups.

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
- re-importing the same archive is a no-op; switching to a fresher archive tops up new edges without treating missing relationships as ended unless `--restore` is used

A fresh install with just an archive and no live transport still gets a usable [follow graph](follow-graph.md). `birdclaw graph summary`, `graph mutuals`, and `graph top-followers` all work against archive-imported edges. Live `sync followers --yes` can layer churn on top later.

## Hydrate profiles

The archive ships with stale profile metadata (bios, follower counts, avatars from years ago). Hydrate from live Twitter when you can:

```bash
birdclaw import hydrate-profiles --account steipete --json
```

With xurl available, this walks the imported profiles table and refreshes each entry. On large archives, that can mean hundreds or thousands of live X profile reads and may spend API credits. `--account` accepts a username or stored account ID and routes the operation through that account. In Bird-only mode, the command verifies `bird whoami`; without an explicit selection it retains the legacy seeded-account correction, while explicit selection never relabels another stored identity. Without a live transport, hydration is a no-op and the archive's snapshot stays.

Avatars are written to `~/.birdclaw/media/thumbs/avatars/` so the web UI does not re-fetch them on every render.

## What ends up where

After import, archive data and live data live in the same canonical tables. There is no `archive_*` shadow universe.

- **Tweets** → `tweets` table, indexed by FTS5 — searchable via `birdclaw search tweets`
- **Explicit deletions** → retained tweet metadata plus `tweet_subordinate_tombstones`; excluded from active timelines, search, links, and media fetches
- **Edit history** → ordered `tweet_revisions` rows, with raw payloads only for observed revision bodies and superseded canonical rows retained outside active views
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
