---
title: Mentions
description: "Mentions ingest, cached live export, and conversation backfill — xurl-compatible JSON, replied/unreplied filters, paged scans."
---

# Mentions

There are two commands and they do different things:

- [`birdclaw sync mentions`](sync.md#sync-mentions) is the ingest path. It pulls live mentions through `bird` by default, with `xurl` as the explicit fallback, writes them into the canonical local store with `kind='mention'`, and exits. Run this on cron.
- `birdclaw mentions export` is the read-side, agent-and-script-friendly view onto what `sync mentions` already wrote. It always emits JSON, supports three modes, and caches every live response so repeated reads do not keep spending the API budget.

The full pipeline:

```bash
birdclaw sync mentions --limit 100 --max-pages 3 --refresh --json
birdclaw sync mention-threads --limit 30 --delay-ms 1500 --timeout-ms 15000 --json
birdclaw mentions export --unreplied --limit 10 --json
```

`mentions export --refresh` still works as a single-shot ingest-plus-read for one-off agent calls, but `sync mentions` is the cron-friendly canonical path.

## Three modes

### `birdclaw` (default)

Returns normalized items from the local SQLite store with rendered text variants:

```bash
birdclaw mentions export "agent" --unreplied --limit 10
```

Each item carries:

- raw `text`
- rendered `plainText` with URLs/handles expanded
- rendered `markdown` for chat or doc embeds
- canonical tweet URL
- author metadata (handle, display name, avatar URL, follower count, verified)
- reply-state metadata (`replied` / `unreplied`, last-replied-at)

This is what an agent should consume by default — it stays inside the local cache and never touches the live API.

### `xurl`

Mirrors the `xurl mentions` response shape: `data`, `includes.users`, `meta`. The payload is cached in SQLite and reused until the cache TTL expires:

```bash
birdclaw mentions export --mode xurl --limit 5
birdclaw mentions export --mode xurl --refresh --limit 5
birdclaw mentions export --mode xurl --refresh --all --max-pages 9 --limit 100
birdclaw mentions export "courtesy" --mode xurl --limit 5
```

In paged `xurl` mode, `--limit` is the **page size**, not the total returned count.

### `bird`

Shells out to your local `bird` CLI, normalizes the response into the same `xurl`-compatible shape, and caches it. Useful when `xurl` is rate-limited or when an account only has relay/profile-backed access:

```bash
birdclaw mentions export --mode bird --limit 20
birdclaw mentions export --mode bird --refresh --limit 20
```

## Common flags

- `--account <account-id>` — pick the account when multiple are configured
- `--mode birdclaw|xurl|bird`
- `--replied` / `--unreplied`
- `--refresh` — force a live fetch
- `--cache-ttl <seconds>` — tune cache freshness
- `--all` — paginate until exhausted (paged modes only)
- `--max-pages <n>` — cap the paged scan; implies `--all`
- `--limit <n>` — page size in paged modes, total otherwise

## Filters keep working in cached live modes

Query filters (`"agent"`, `--replied`, `--unreplied`) and reply-state filters still apply in `--mode xurl` and `--mode bird`. The filtered payload is rebuilt from the local canonical store after the response cache lands, so the response shape stays `xurl`-compatible while the filter behavior matches the local view.

## Default source via config

If you use `bird` for mentions most of the time, set it once:

```json
{
  "mentions": {
    "dataSource": "bird",
    "birdCommand": "/Users/steipete/Projects/bird/bird"
  }
}
```

Now `birdclaw mentions export` defaults to `--mode bird` for that user. `--mode xurl` still works for one-off live API checks.

## Wiring it into an agent

The `birdclaw` mode is designed for agents:

```bash
birdclaw mentions export --unreplied --limit 20 --json | jq '.items[] | {url, plainText}'
```

Pair with the [profile reply scan](#profile-reply-scan) below to pre-flight whether a mention came from a likely AI/templated account before drafting a response.

## Profile reply scan

When one mention feels borderline ("is this actually a person?"), look at the recent replies that account sent across other threads:

```bash
birdclaw profiles replies @borderline_handle --limit 12 --json
```

What it does:

- pulls the live authored timeline
- excludes retweets, keeps replies only
- surfaces repeated generic praise, abstraction soup, and templated cadence

Typical tells:

- the same upbeat, generic reply shape across unrelated threads in a short time window
- replies that praise the OP without engaging with the content
- short replies that map 1:1 to a small set of templates

Use this to bucket "definitely a person", "unsure", and "obviously templated" before deciding whether to mute, block, or just archive.

## Live mention threads

If you want the conversation context for each mention (the parent tweet, the reply chain), run [`sync mention-threads`](sync.md#sync-mention-threads) first. That populates ancestor tweets in the local store so `mentions export` can reference them without an extra live call per mention.

Both `--mode bird` and `--mode xurl` are supported; pick `xurl` if you do not have the `bird` CLI installed. The xurl path uses `/2/tweets/search/recent` keyed on `conversation_id` plus a parent-walk fallback for older threads outside the 7-day search window.

## See also

- [Inbox](inbox.md) — same items, ranked by heuristics or OpenAI
- [Sync](sync.md) — cursor / pagination behavior
- [Moderation](moderation.md) — turn a borderline reply scan into a block decision
