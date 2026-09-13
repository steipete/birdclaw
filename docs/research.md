---
title: Research
description: "Turn bookmarked tweets into a markdown brief with thread expansion and extracted links."
---

# Research

`birdclaw research` is a bookmark-driven thinking tool. Point it at a query (or just an account) and it walks the bookmarked tweets that match, expands their threads, and produces a markdown brief with grouped quotes, extracted links, and handles you might want to follow up with.

## Basic use

```bash
birdclaw research "codex" --limit 20 --thread-depth 10 --json
birdclaw research --account acct_primary --out ~/research/codex.md
```

What it does:

- queries the local `tweets` table for matches inside the bookmarks collection
- expands each match into its full thread using the local store first
- when ancestors are missing locally, looks up missing tweets through xurl, with optional bird fallback
- renders one markdown file with each thread as a section: original tweet + replies as block quotes
- pulls out `https://` URLs and `@handle` references into a deduped list at the end

The output is meant to be read in Obsidian, a chat draft, or piped into another tool.

## Flags

- `--limit <n>` — max number of bookmarked tweets to expand into threads
- `--thread-depth <n>` — how many ancestor levels to walk
- `--account <id>` — multi-account selector
- `--out <path>` — write the brief to a file instead of stdout (auto-creates parent directories)
- `--json` — emit a JSON envelope instead of markdown (useful for chaining into agents)

## Live thread expansion

When a thread ancestor is not in the local store, `research` follows the bounded parent chain with the shared tweet lookup: xurl first, with bird fallback if needed. Local ancestors need no live request, and xurl-only installations can expand missing ancestors without bird.

If you do this kind of expansion regularly, run `birdclaw sync mention-threads` and `birdclaw sync bookmarks --all` first. That populates the local store with everything `research` needs and removes the live calls from the hot path.

## Example output

```text
# Research: "codex"

## Bookmark · 2026-04-12

> @author: Original tweet about codex agents.
>
> @reply1: Adds context about scaling.
> @reply2: Pushes back on the framing.

## Bookmark · 2026-04-09

> @another: Different angle on the same topic.

## Links

- https://example.com/codex-explainer
- https://other.example/talk

## Handles

- @author
- @reply1
- @reply2
- @another
```

The `--json` shape mirrors that structure with an `items` array (one per bookmark), `links`, and `handles`.

## See also

- [Search](search.md) — base query model
- [Sync](sync.md) — top up bookmarks before researching
- [Mentions](mentions.md#profile-reply-scan) — same idea applied to a single account
