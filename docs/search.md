---
title: Search
description: "FTS5 search across archived and live-synced tweets and DMs."
---

# Search

birdclaw indexes every tweet and DM in SQLite FTS5. Search runs locally, returns instantly, and works offline.

## Search tweets

```bash
birdclaw search tweets "local-first" --json
birdclaw search tweets "sync engine" --limit 20 --json
```

Every result includes a snippet of the matching FTS5 fragment plus author, timestamp, canonical URL, reply state, and (for live-synced rows) cache freshness.

### Date windows

```bash
birdclaw search tweets --since 2020-01-01 --until 2021-01-01 --limit 200 --json
```

`--since` and `--until` accept ISO dates and snowflake-encoded tweet IDs.

### Quality filters

```bash
birdclaw search tweets --originals-only --hide-low-quality --limit 500 --json
```

- `--originals-only` — exclude retweets and pure quote-tweet shells
- `--hide-low-quality` — apply the heuristic low-signal filter (mass replies, generic praise patterns, pure emoji, link-only spam)

The same heuristic feeds the [Inbox](inbox.md) low-signal flag.

### Collection filters

```bash
birdclaw search tweets --liked --limit 20 --json
birdclaw search tweets --bookmarked --limit 20 --json
birdclaw search tweets --bookmarked --hide-low-quality --since 2024-01-01 --limit 50 --json
```

`--liked` and `--bookmarked` work uniformly across archive imports and live syncs because both feed the same canonical `tweets` table plus a collection edge.

### Author filter

```bash
birdclaw search tweets "AI" --author @borderline_handle --limit 20 --json
```

`--author` accepts a handle, `@handle`, numeric Twitter user id, or local profile id.

### Full flag list

- `--author <handle-or-id>`
- `--since <date>` / `--until <date>`
- `--originals-only`
- `--hide-low-quality`
- `--liked` / `--bookmarked`
- `--limit <n>`
- `--json` / `--plain`

## Search DMs

```bash
birdclaw search dms "prototype" --json
birdclaw search dms "layout" --min-followers 1000 --min-influence-score 120 --sort influence --json
birdclaw search dms "blacksmith" --context 4 --resolve-profiles --expand-urls --no-xurl-fallback --json
```

DM-specific filters layer follower-count and influence on top of FTS5:

- `--participant <handle-or-id>`
- `--min-followers <n>` / `--max-followers <n>`
- `--min-influence-score <n>` / `--max-influence-score <n>`
- `--sort recent|influence`
- `--context <n>`
- `--resolve-profiles`
- `--expand-urls`
- `--refresh-profile-cache` / `--refresh-url-cache`
- `--no-xurl-fallback`
- `--replied` / `--unreplied`
- `--limit <n>`

Influence is a derived score that starts with follower count and combines verified status, prior interaction, and ratio signals. It is not authoritative — use it to bucket noisy inboxes, not to rank conversations you already care about.

Use `birdclaw whois <query>` when the task is identity-oriented rather than
pure search. It ranks candidate DM threads with evidence, optional tweet matches,
cached profile resolution, first-class profile affiliation metadata, profile
bio/profile URL signals, profile-change snapshots, extracted bio entities, and
cached URL expansion. In JSON, inspect `profileEvidence` for typed reasons such
as `affiliation`, `bio_handle`, `bio_domain`, `profile_history`,
`profile_url`, and `expanded_url`.

## Snippets

FTS5 snippets are returned with `<mark>` boundaries pre-rendered for the web UI. The CLI prints them as plain text in human mode and as `snippet`/`snippetHtml` fields in `--json` mode.

## Performance

The FTS5 index is incremental. Sync and import runs update it as rows land. If the index ever drifts:

```bash
birdclaw db vacuum --json
```

`db vacuum` reclaims space, recomputes FTS5 shadow tables, and reports before/after sizes. It's safe to run any time the database is not actively being written to.

## See also

- [Mentions](mentions.md) — agent-friendly mention export with cached live modes
- [DMs](dms.md) — list/sync/triage flows
- [Inbox](inbox.md) — heuristic + OpenAI ranked queue
