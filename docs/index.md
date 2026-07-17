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

# Explicitly import named public tweets through the third-party FxTwitter service.
birdclaw import tweet 20 --fxtwitter --json

# Pull in mentions, likes, bookmarks, and the home timeline.
birdclaw sync timeline --limit 100 --refresh --json
birdclaw sync bookmarks --mode auto --all --json

# Search every tweet you've ever liked, locally, with FTS5.
birdclaw search tweets "local-first" --json
birdclaw search tweets --bookmarked --hide-low-quality --limit 100 --json

# Triage with AI ranking and reply from the CLI.
birdclaw inbox --score --hide-low-signal --limit 8 --json
birdclaw compose reply 1891234567890 "On it."

# Stream a local "what happened" digest.
birdclaw today
birdclaw today --language zh-CN
birdclaw digest week --json
```

Stable `--json` envelopes go to stdout, progress and warnings to stderr — pipes stay parseable.

## What birdclaw does

- **One local SQLite database** for tweets, DMs, likes, bookmarks, mentions, follows, blocks, and mutes — multi-account, FTS5-indexed.
- **Archive-first, live-aware.** Import a Twitter archive to establish account identity, then selectively re-import stale slices with `--select` or refresh through live transports.
- **Cached live reads** through recommended [`xurl`](https://github.com/xdevplatform/xurl) setups or existing private `bird` installations, so repeated reads do not keep spending the API budget.
- **Local web app** for `What happened`, `Home`, `Mentions`, `Likes`, `Bookmarks`, `DMs`, `Inbox`, and `Blocks` — light/dark/system theme, focused timeline lane, no dashboard chrome.
- **AI-ranked inbox** (OpenAI) for low-signal filtering on mentions and DMs.
- **Streaming AI digest** (OpenAI Responses API) for today, 24h, yesterday, or week, with DMs excluded unless explicitly enabled.
- **Account-scoped moderation** with bulk blocklist import and a cookie-backed fallback when OAuth2 block writes get rejected.
- **Git-friendly text backups** with yearly tweet shards and per-conversation DM shards — push the local SQLite truth into a private Git repo.
- **Read-only MCP server** for secured agent access to locally cached tweet search and threads, without exposing DMs or write/live transports.

## Pick your path

- **First time using birdclaw.** [Install](install.md) → [Quickstart](quickstart.md) covers archive-first account setup, live transports, and the local web app.
- **Have a Twitter archive ZIP.** [Archive import](archive.md) walks through autodiscovery, selected re-imports, and idempotent re-runs.
- **Need a few named public tweets without X credentials.** [Public tweet import](public-tweets.md) documents the explicit FxTwitter opt-in and third-party disclosure tradeoff.
- **Already initialized, want fresh live data.** [Sync](sync.md) covers likes, bookmarks, timeline, mention threads, and rate-limit-aware resumable runs.
- **Triaging mentions or DMs.** [Search](search.md), [Mentions](mentions.md), [DMs](dms.md), and [Inbox](inbox.md).
- **Exploring your network.** [Network Map](network-map.md) plots current followers/following by profile location.
- **Maintaining a blocklist.** [Moderation](moderation.md) covers blocks, mutes, ban/unban, and bulk imports.
- **Caching tweet media locally.** [Media](media.md) covers `media fetch` for images, video, and GIFs, plus archive-byte reuse.
- **Backing up to Git.** [Backup](backup.md) for deterministic JSONL shards and `backup sync` round-trips.
- **Connecting an agent.** [MCP server](mcp.md) covers the read-only tools, bearer boundary, and private-proxy deployment.
- **Looking up a flag.** The [CLI reference](cli.md) lists every subcommand and option.

## Project

Active development. Status: real and usable, not finished. Schema churn, transport gaps, and rough edges are expected while the core settles.

The [changelog](https://github.com/steipete/birdclaw/blob/main/CHANGELOG.md) tracks what shipped recently. Product order and boundaries live in the [vision](https://github.com/steipete/birdclaw/blob/main/VISION.md); detailed goals and decisions live in the [spec](spec.md). Released under the [MIT license](https://github.com/steipete/birdclaw/blob/main/LICENSE). Not affiliated with X Corp.
