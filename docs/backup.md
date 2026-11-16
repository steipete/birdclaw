---
title: Backup
description: "Export, sync, and validate Git-friendly JSONL backups of your local SQLite store."
---

# Backup

birdclaw can write the canonical SQLite store as deterministic JSONL shards that Git can diff and merge. The backup repo is the long-lived, version-controlled record; the SQLite file is just a fast local index built from it.

## Layout

Schema 9 separates frequently changing observations from content. For example:

```text
manifest.json
data/v9/tweets/2026-11-13.jsonl
data/v9/tweets/2026-11-13.observations.jsonl
data/v9/tweet_revisions/2026-11-13.jsonl
data/v9/tweet_revisions/2026-11-13.observations.jsonl
data/v9/collections/likes/2026-11-13.jsonl
data/v9/collections/likes/2026-11-13.observations.jsonl
data/v9/timeline_edges/mention/2026-11-13.jsonl
data/v9/timeline_edges/mention/2026-11-13.observations.jsonl
data/v9/profiles/ab.jsonl
data/v9/profile_snapshots/ab.jsonl
data/v9/profile_snapshots/2026-11-13.observations.jsonl
data/v9/dms/2026-11-13.jsonl
data/accounts.jsonl
data/dms/conversations.jsonl
```

Content uses UTC creation days; revisions and account edges use the referenced tweet's creation day. Unknown dates use an identifier hash bucket. Profiles and profile snapshots use the first byte of the SHA-256 of the profile ID (256 buckets), so one profile change does not rewrite every profile. Other tables retain their previous paths.

Observation files hold primary keys and `like_count` (tweets), `observed_at` (revisions), `updated_at` (collections), `last_seen_at`/`updated_at`/`seen_count` (account edges), or `last_seen_at` (profile snapshots). They are grouped by their observation's UTC day. Tweet counts use their revision's observation day, falling back to the creation day. These are current values, not an additional observation log. Reobserving a row moves only its small observation record; it leaves content bytes unchanged. A newly discovered historical tweet or a content correction can still change its older content shard.

All fields survive reassembly before the existing merge rules run. Row order depends on primary keys, never observation times. Export layout depends only on the database state, not which machine exported it or earlier exports.

### Migration

Upgrade every reader and writer before publishing schema 9. This release imports schemas 1–8 unchanged and migrates to schema 9 on the next normal export through the existing staged, validated publication. Older binaries reject schema 9 rather than silently importing part of it. No SQLite migration, history rewrite, or change to sync commands is required. The first migrated commit establishes a new layout; old Git history remains available.

Design rules:

- **tweets** are sharded by UTC creation day to bound the files rewritten by additions
- **DMs** are sharded by UTC creation day with `conversation_id` in each row, so Git stays fast while preserving conversation membership
- **collection-only tweets** with unknown timestamps go to identifier hash buckets instead of pretending they belong to 1970
- **tweet tombstones and revisions** preserve explicit deletions, subordinate media/quote deletion state, and observable edit chains without re-exposing deleted or superseded rows through search
- **likes** and **bookmarks** are stored as collection edges and mirrored into the timeline rows so existing queries keep working
- **profiles** include bio, follower/following counts, profile URL, location, verification type, structured URL entities, and raw profile JSON so the snapshot is meaningful on its own
- **profile affiliations** preserve X badge/highlighted-label organization edges separately from profile rows
- **profile snapshots** preserve deduplicated profile-history states for identity evidence over time
- **profile bio entities** preserve extracted `@handle`, domain, and company-phrase identity hints, including inactive historical values
- **follow graph** shards preserve followers/following snapshots, snapshot members, current edges, and append-only churn events
- **X Lists** preserve owned-List freshness/completeness metadata and current/ended member edges
- **no SQLite WAL/SHM, FTS shadow tables, or transient live cache rows** ever land in the backup
- **line endings** for hashed JSONL and manifest files stay LF on every platform via the generated `.gitattributes`
- **large logical shards** split deterministically into numbered parts capped at 48 MiB, keeping every Git blob below common hosted-repository limits without Git LFS

The manifest pins per-shard byte counts, row counts, and SHA hashes. Validation walks every shard and verifies they line up.

## `backup export`

Write text shards to a local directory. Validates the manifest by default.

```bash
birdclaw backup export --repo ~/Projects/birdclaw-store --json
birdclaw backup export --repo ~/Projects/birdclaw-store --commit --push
```

Flags:

- `--repo <path>` — target directory (created if missing)
- `--commit` — create a Git commit in the backup repo
- `--push` — implies `--commit` and pushes the backup repo
- `--no-validate` — skip post-export validation (not recommended)

The `data/` directory is fully rewritten on every export. Anything outside `data/` (your README, license, hooks) is left alone.
Logical shards at or below 48 MiB keep their filename. Larger shards become numbered `.part-0001.jsonl` files; import and validation accept these parts in both old and new layouts.

## `backup sync`

The recommended round-trip workflow:

```bash
birdclaw backup sync \
  --repo ~/Projects/backup-birdclaw \
  --remote https://github.com/steipete/backup-birdclaw.git \
  --json
```

What `sync` does:

1. clones / configures the backup Git repo if needed
2. pulls the backup repo before reading
3. merge-imports remote backup rows into local SQLite
4. exports the local union back into deterministic text shards
5. commits and pushes the backup repo

Git operations are rooted at the configured `repoPath`. If that directory sits inside another worktree, Birdclaw initializes or uses a separate repository there instead of staging backup files into the enclosing project.

This is what makes birdclaw safe across multiple machines: each machine can sync independently, and the merge step preserves rows that only one side has.

Validation ignores regular files named exactly `.DS_Store` anywhere under `data/`, and Git staging excludes them from backup commits. Other unexpected files, directories, and symlinks (including symlinks named `.DS_Store`) still fail validation.

### Note Tweet compatibility

Note Tweets keep their complete text and matching entities in the existing schema-8 tweet fields. New exports add an optional `note_tweet_json` field so current readers can preserve the full body when a later live payload contains only a preview. Schema 9 preserves these fields when splitting tweet bodies from observations.

Older writers omit that optional marker when re-exporting. They retain the full text and entities, but do not provide the new protection against preview-only live updates or the expandable Note Tweet presentation. Use current Birdclaw versions on machines that refresh Note Tweets.

The local SQLite database migrates to version 14 on writable startup. Prepare read-only archive deployments with a writable initialization before serving the updated application. Stop older writer processes before upgrading; all writers must use the current incremental search-index implementation. Map revision counters are derived locally and do not change the portable backup schema, which is now 9 because of the storage layout change.

## `backup import`

```bash
birdclaw backup import ~/Projects/birdclaw-store --json
```

Validates the backup first (unless `--no-validate`), then merge-imports rows into local SQLite. Local-only rows are preserved by default.

Merge-import folds legacy profile rows with proven numeric X identities into their canonical profiles after importing all references. Current canonical handles and mutable state are preserved unless matching imported profile snapshots establish a newer state; unproven legacy rows remain separate and receive reserved handles when necessary to avoid collisions.

`--restore` restores exactly from backup and **deletes local portable rows first**. Use it when you want a known-clean state from the backup, e.g. on a new machine. The older `--replace` spelling remains as a deprecated alias.

The FTS5 shadow tables for tweets and DMs are rebuilt from the JSONL text after import, so search is immediately available.

The portable database fingerprint is computed after the write transaction commits and streams rows in canonical order inside a read snapshot. Large first imports therefore keep bounded memory, do not hold the SQLite write lock while producing the verification hash, and remain atomically usable even while the fingerprint is being calculated.

Revision topology reconciliation visits only multi-revision or explicitly edge-connected components. Canonical singleton revisions are imported directly instead of each triggering an identical recursive component query and rewrite.

## `backup validate`

```bash
birdclaw backup validate ~/Projects/birdclaw-store --json
```

Checks:

- `manifest.json` is well-formed
- every listed shard exists
- per-shard byte counts match
- per-shard row counts match
- per-shard SHA hashes match
- every JSONL row parses

Exits non-zero on validation failure. Run it in CI before publishing a backup, or after a noisy disk event.

## Auto-sync config

```json
{
	"backup": {
		"repoPath": "/Users/steipete/Projects/backup-birdclaw",
		"remote": "https://github.com/steipete/backup-birdclaw.git",
		"autoSync": true,
		"staleAfterSeconds": 900
	}
}
```

When `autoSync` is enabled:

- CLI read paths pull + merge from Git before returning when the last backup check is older than `staleAfterSeconds`
- web startup and API reads serve the current local SQLite snapshot immediately and request the stale backup check in the background
- stale checks compare the manifest `backupHash` and skip validation/import when the already-applied backup is unchanged
- after a changed backup import, Birdclaw reopens its read pool and requests a passive WAL checkpoint
- data-changing commands (compose, sync, blocks, mutes, etc.) run a full backup sync afterward
- a changed import still uses synchronous SQLite work in the server process, so concurrent requests may briefly pause while that import commits; use a separate scheduled updater when strict isolation is required

Set `backup.readOnly: true` for a replica that only pulls and imports. Automatic
backup checks after local writes also pull instead of exporting; local research
stays in that instance’s database. Explicit export, sync and pending-push recovery
for the configured repository fail without writing or pushing. Exports to other
paths remain available. This is an application preference, not a Git access control;
use read-only credentials if the replica must have no write access to the remote.

Set `BIRDCLAW_BACKUP_AUTO_SYNC=0` to disable auto-sync for one process — useful for local debugging.

## Why not commit `birdclaw.sqlite`?

- the FTS5 shadow tables are non-portable and create huge diffs
- WAL / SHM files churn constantly
- transient live response caches are noise
- a SQLite blob is opaque to Git review

Sharded JSONL is the opposite: human-readable, Git-friendly, and reproducible.

## See also

- [Jobs](jobs.md) — scheduled bookmark sync writes a JSONL audit log alongside the backup output
- [CLI reference](cli.md#backup-export) — every flag for every backup subcommand
- [Configuration](configuration.md) — auto-sync env var and config keys
