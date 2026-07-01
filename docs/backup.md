---
title: Backup
description: "Export, sync, and validate Git-friendly JSONL backups of your local SQLite store."
---

# Backup

birdclaw can write the canonical SQLite store as deterministic JSONL shards that Git can diff and merge. The backup repo is the long-lived, version-controlled record; the SQLite file is just a fast local index built from it.

## Layout

```text
.gitattributes
manifest.json
data/accounts.jsonl
data/profiles.jsonl
data/profile_affiliations.jsonl
data/profile_snapshots.jsonl
data/profile_bio_entities.jsonl
data/tweets/YYYY.jsonl
data/tweets/unknown.jsonl
data/collections/likes.jsonl
data/collections/bookmarks.jsonl
data/dms/conversations.jsonl
data/dms/YYYY.jsonl
data/moderation/blocks.jsonl
data/moderation/mutes.jsonl
data/follow_snapshots.jsonl
data/follow_snapshot_members.jsonl
data/follow_edges.jsonl
data/follow_events.jsonl
```

Design rules:

- **tweets** are sharded by year for human browsing, partial loads, and yearly analysis
- **DMs** are sharded by year with `conversation_id` in each row, so Git stays fast while preserving conversation membership
- **collection-only tweets** with unknown timestamps go to `data/tweets/unknown.jsonl` instead of pretending they belong to 1970
- **likes** and **bookmarks** are stored as collection edges and mirrored into the timeline rows so existing queries keep working
- **profiles** include bio, follower/following counts, profile URL, location, verification type, structured URL entities, and raw profile JSON so the snapshot is meaningful on its own
- **profile affiliations** preserve X badge/highlighted-label organization edges separately from profile rows
- **profile snapshots** preserve deduplicated profile-history states for identity evidence over time
- **profile bio entities** preserve extracted `@handle`, domain, and company-phrase identity hints, including inactive historical values
- **follow graph** shards preserve followers/following snapshots, snapshot members, current edges, and append-only churn events
- **no SQLite WAL/SHM, FTS shadow tables, or transient live cache rows** ever land in the backup
- **line endings** for hashed JSONL and manifest files stay LF on every platform via the generated `.gitattributes`

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

## `backup import`

```bash
birdclaw backup import ~/Projects/birdclaw-store --json
```

Validates the backup first (unless `--no-validate`), then merge-imports rows into local SQLite. Local-only rows are preserved by default.

`--replace` restores exactly from backup and **deletes local portable rows first**. Use it when you want a known-clean state from the backup, e.g. on a new machine.

The FTS5 shadow tables for tweets and DMs are rebuilt from the JSONL text after import, so search is immediately available.

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

- read paths (CLI search, inbox, API status/query, web startup) pull + merge from Git **only** when the last backup check is older than `staleAfterSeconds`
- data-changing commands (compose, sync, blocks, mutes, etc.) run a full backup sync afterward
- the freshness window is per-process; nothing pings Git on every command

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
