---
title: Quickstart
description: "Five minutes from a clean machine to a working birdclaw setup with one Twitter account."
---

# Quickstart

Five minutes from a clean machine to a local SQLite store full of your tweets, DMs, likes, and bookmarks — plus a working web UI.

## 1. Install

```bash
brew install steipete/tap/birdclaw
birdclaw --version
```

Other install options (npm, source) are on [Install](install.md).

## 2. Initialize local state

```bash
birdclaw init
birdclaw auth status --json
birdclaw db stats --json
```

`init` creates `~/.birdclaw/`, opens the shared SQLite database, writes a default config when none exists, and probes for `xurl` and `bird` on `PATH`.

`auth status` prints which transports are available and which account is active. Right after `init`, no account is configured yet — that comes in step 4.

## 3. Find and import an archive

If you downloaded your Twitter/X archive from <https://x.com/settings/your_archive>, point birdclaw at it. On macOS, autodiscovery looks in `~/Downloads` and Spotlight first.

```bash
birdclaw archive find --json
birdclaw import archive --json
# or with an explicit path:
birdclaw import archive ~/Downloads/twitter-archive-2025.zip --json
```

Optional profile hydration fills bios, follower counts, and avatars from live Twitter metadata using whichever transport is available. It can perform hundreds or thousands of live profile reads on large archives, so run it only when you are ready to spend those X API reads:

```bash
birdclaw import hydrate-profiles --json
```

Later, when you download a newer archive, you can refresh only one stale slice without wiping live-synced or local data:

```bash
birdclaw import archive ~/Downloads/twitter-archive-2026.zip --select likes,bookmarks --json
birdclaw import archive ~/Downloads/twitter-archive-2026.zip --select directMessages --json
```

Valid slices: `tweets`, `likes`, `bookmarks`, `profiles`, `directMessages`, `followers`, `following`. Use `dms` as a short alias for `directMessages`.

No archive yet? Skip to step 4 — birdclaw is fully usable in live-only mode.

## 4. Sync live state

`auto` tries `xurl` first, then falls back to `bird`. Use `bird` directly for surfaces where the API path is rate-limited.

```bash
birdclaw sync likes --mode auto --limit 100 --refresh --json
birdclaw sync bookmarks --mode auto --limit 100 --refresh --json
birdclaw sync timeline --limit 100 --refresh --json
birdclaw sync mention-threads --limit 30 --delay-ms 1500 --json
```

Without `xurl` or `bird`, sync stays in archive-only mode and just verifies the local cache.

## 5. Start the web app

```bash
birdclaw serve
```

Open <http://localhost:3000>. The default lanes:

- **Home** — read and reply without fighting the main Twitter timeline
- **Mentions** — work the reply queue with replied/unreplied filters
- **Likes** / **Bookmarks** — revisit saved posts
- **DMs** — triage by sender follower count, bio, and influence
- **Inbox** — let heuristics or OpenAI float likely-important items
- **Blocks** — maintain a local-first account-scoped blocklist

Use the Sync button in Home, Mentions, Likes, Bookmarks, or DMs when you want fresh live data. Browser reloads only reread local SQLite; explicit sync avoids surprise live reads and rate-limit spend.

## 6. Run real CLI workflows

Search every tweet you ever liked or bookmarked:

```bash
birdclaw search tweets "local-first" --json
birdclaw search tweets --liked --hide-low-quality --limit 20 --json
birdclaw search tweets --since 2020-01-01 --until 2021-01-01 --originals-only --limit 500 --json
```

Triage mentions for an agent:

```bash
birdclaw mentions export "agent" --unreplied --limit 10
birdclaw inbox --score --hide-low-signal --limit 8 --json
```

Bulk-block a list of obvious AI/spam accounts:

```bash
birdclaw blocks import ~/triage/blocklist.txt --account acct_primary --json
```

Reply from the CLI:

```bash
birdclaw compose post "Ship local software."
birdclaw compose reply 1891234567890 "On it."
birdclaw compose dm dm_003 "Send it over."
```

## 7. Back up locally

`backup export` writes deterministic JSONL shards that round-trip back into SQLite. Push them to a private Git repo:

```bash
birdclaw backup sync \
  --repo ~/Projects/backup-birdclaw \
  --remote https://github.com/steipete/backup-birdclaw.git \
  --json
```

Set `backup.autoSync` in `~/.birdclaw/config.json` and read paths pull + merge from Git when the last check is stale; data-changing commands push back automatically. Full details in [Backup](backup.md).

## Where to go next

- [Configuration](configuration.md) — `~/.birdclaw/config.json`, env vars, and per-account profiles
- [Sync](sync.md) — full reference for likes, bookmarks, timeline, and resumable mention-thread fetches
- [Moderation](moderation.md) — blocks, mutes, bans, and bulk imports
- [Inbox](inbox.md) — heuristic and OpenAI-ranked triage
- [Backup](backup.md) — Git-friendly text shards
- [CLI reference](cli.md) — every subcommand, every flag
