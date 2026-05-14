---
title: Overview
permalink: /
description: "birdclaw is a local-first Twitter workspace: archive import, cached live reads, focused triage, and reply flows in one local web app + CLI."
---

## Try it

After [installing](install.md) and running [`birdclaw init`](quickstart.md), every workflow is a one-liner.

```bash
# Find and import your Twitter archive (auto-discovered on macOS).
birdclaw archive find --json
birdclaw import archive --json
birdclaw import archive ~/Downloads/twitter-archive.zip --select likes,bookmarks --json

# Pull in mentions, likes, bookmarks, and the home timeline.
birdclaw sync timeline --limit 100 --refresh --json
birdclaw sync bookmarks --mode auto --all --json

# Search every tweet you've ever liked, locally, with FTS5.
birdclaw search tweets "local-first" --json
birdclaw search tweets --bookmarked --hide-low-quality --limit 100 --json

# Triage with AI ranking and reply from the CLI.
birdclaw inbox --score --hide-low-signal --limit 8 --json
birdclaw compose reply 1891234567890 "On it."
```

Stable `--json` envelopes go to stdout, progress and warnings to stderr — pipes stay parseable.

## What birdclaw does

- **One local SQLite database** for tweets, DMs, likes, bookmarks, mentions, follows, blocks, and mutes — multi-account, FTS5-indexed.
- **Archive-first, live-aware.** Import a Twitter archive when you have one, selectively re-import stale slices with `--select`, or stay live-only. All paths converge on the same canonical tables.
- **Cached live reads** through [`xurl`](https://github.com/xdevplatform/xurl) and [`bird`](https://github.com/steipete/bird), so repeated reads do not keep spending the API budget.
- **Local web app** for `Home`, `Mentions`, `Likes`, `Bookmarks`, `DMs`, `Inbox`, and `Blocks` — light/dark/system theme, focused timeline lane, no dashboard chrome.
- **AI-ranked inbox** (OpenAI) for low-signal filtering on mentions and DMs.
- **Account-scoped moderation** with bulk blocklist import and a cookie-backed fallback when OAuth2 block writes get rejected.
- **Git-friendly text backups** with yearly tweet shards and per-conversation DM shards — push the local SQLite truth into a private Git repo.

## Pick your path

- **First time using birdclaw.** [Install](install.md) → [Quickstart](quickstart.md). Five minutes from `brew install` to your first authenticated query.
- **Have a Twitter archive ZIP.** [Archive import](archive.md) walks through autodiscovery, selected re-imports, and idempotent re-runs.
- **No archive, just want to read live.** [Sync](sync.md) covers likes, bookmarks, timeline, mention threads, and rate-limit-aware resumable runs.
- **Triaging mentions or DMs.** [Search](search.md), [Mentions](mentions.md), [DMs](dms.md), and [Inbox](inbox.md).
- **Maintaining a blocklist.** [Moderation](moderation.md) covers blocks, mutes, ban/unban, and bulk imports.
- **Caching tweet media locally.** [Media](media.md) covers `media fetch` for images, video, and GIFs, plus archive-byte reuse.
- **Backing up to Git.** [Backup](backup.md) for deterministic JSONL shards and `backup sync` round-trips.
- **Looking up a flag.** The [CLI reference](cli.md) lists every subcommand and option.

## Project

Active development. Status: real and usable, not finished. Schema churn, transport gaps, and rough edges are expected while the core settles.

The [changelog](https://github.com/steipete/birdclaw/blob/main/CHANGELOG.md) tracks what shipped recently. Goals and non-goals live in the [spec](spec.md). Released under the [MIT license](https://github.com/steipete/birdclaw/blob/main/LICENSE). Not affiliated with X Corp.
