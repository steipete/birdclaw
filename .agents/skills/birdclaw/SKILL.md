---
name: birdclaw
description: Use for X/Twitter archive search, yearly vibe summaries, weird tweets, and quality filters.
---

# Birdclaw

Use this for X/Twitter archive questions before web/API lookup. Local archive first; live X only when explicitly needed for current account state.

## Data

Prefer:

1. Birdclaw CLI in `~/Projects/birdclaw`
2. Installed `birdclaw`
3. SQLite DB `~/.birdclaw/birdclaw.sqlite`

Check basic health/freshness before analysis:

```bash
birdclaw db stats --json
```

```bash
sqlite3 ~/.birdclaw/birdclaw.sqlite "pragma quick_check;"
```

## Picking the Right Approach

Match the depth of read to the task:

- **Single fact / one tweet lookup** → SQL probe is fine.
- **DM identity lookup ("who is the X person?", "blacksmith guy")** → start with `birdclaw whois <query> --context 4 --no-xurl-fallback --json`. This searches local DMs, adds surrounding context, resolves archive numeric profiles from the persistent cache and `bird`, and avoids `xurl` unless you explicitly allow it.
- **DM search with context** → use `birdclaw search dms <query> --context 4 --resolve-profiles --expand-urls --no-xurl-fallback --json` when adjacent messages, profile names, or expanded `t.co` links matter.
- **Year vibe / theme summary** → CLI with `--originals-only --hide-low-quality`, full year, `--limit 20000`. One year at a time.
- **Life summary, biography, "movie script of my life", multi-year arc** → CLI per year across the full archive range, `--originals-only --hide-low-quality`, `--limit 20000` per year. Expect to ingest **50k+ tweets** total. Do NOT shortcut this with a top-N `like_count desc` SQL query — that yields only viral peaks and misses the everyday texture, recurring themes, and emotional tone the task needs.

Top-liked SQL slices are for spot-checking, not for vibe work. A 30-row `order by like_count desc` is the wrong tool for any task that asks for arc, narrative, or "what was X like."

## DM Identity Search

Prefer cached local-first commands before web/API:

```bash
birdclaw whois blacksmith --context 4 --no-xurl-fallback --json
```

```bash
birdclaw search dms "blacksmith" --context 4 --resolve-profiles --expand-urls --no-xurl-fallback --json
```

Caching model:

- profile resolution reads local `profiles`, then `sync_cache`, then `bird user`
- `xurl` is the last fallback; pass `--no-xurl-fallback` when avoiding X API spend matters
- failed profile lookups are cached briefly to avoid repeated live calls
- URL expansion reads `sync_cache` first; use `--refresh-url-cache` only when stale links matter
- resolved profiles preserve bio, profile URL, location, verification type, structured URL entities, raw profile JSON, and X affiliation badge metadata when available
- inspect `profileEvidence` in `whois --json` to separate `affiliation`, `bio_handle`, `bio_domain`, `bio_company`, `profile_url`, `profile_bio_url`, `profile_history`, `dm_context`, and `expanded_url` matches

How the richer identity evidence works:

- `bird user --json` is the preferred profile hydrator because it can expose X GraphQL profile URL entities and highlighted-label affiliations without using the paid X API.
- Birdclaw stores profile metadata on `profiles`, active organization/badge edges in `profile_affiliations`, profile-change history in `profile_snapshots`, and extracted bio identity hints in `profile_bio_entities`; backups include all four shards.
- When X only gives a highlighted-label badge such as "Vercel" plus an org handle, Birdclaw first stores a deterministic synthetic org id, then resolves the handle through `bird` on a fresh profile hydration and rewrites the edge to the real local organization profile id when available.
- Bio entity extraction is first-class: bios/profile URLs/affiliations yield `@handle`, domain, and company-phrase rows. This is why `whois "blacksmith guy"` can rank someone from `@useblacksmith` and `blacksmith.sh` even if the exact phrase was not in the DM text.
- Profile snapshots are deduplicated by identity fields and affiliations. If a hydrated profile changes from "currently Vercel" to another bio/affiliation, `whois` can surface old matching values as `profile_history`.
- `whois` scores profile bio/name/handle matches, profile URL and bio URL matches, affiliation matches, bio entity matches, profile-history matches, DM context, and expanded `t.co` URLs separately. Prefer the typed `profileEvidence` array over reading the free-form `reasons` text when an agent needs to explain why someone matched.
- A cached rerun should show profile resolution from `local`/`sync_cache` and URL expansions from `cache`; use refresh flags only when current profile/bio/link evidence matters.

Use `--expand-urls` when `t.co` links are evidence. It may touch the network on cache miss, but it is not an X API call.

## Year Analysis

For annual summaries, compare raw counts against summary-quality originals:

```bash
birdclaw --json search tweets --since 2020-01-01 --until 2021-01-01 --limit 20000
```

```bash
birdclaw --json search tweets --since 2020-01-01 --until 2021-01-01 --originals-only --hide-low-quality --limit 20000
```

Use exact date bounds: `YYYY-01-01` inclusive to next-year `YYYY-01-01` exclusive. Report counts and note archive gaps if stats show them.

When summarizing vibe:

- sample across the whole year, not just top-liked posts
- include a few representative paraphrases or short quotes
- separate recurring themes, emotional tone, work topics, jokes, travel/events, and relationship/community signals
- do not overfit one viral post

## Current Filters

`--originals-only` is separate from quality. It excludes authored replies using the current Birdclaw query contract.

`--hide-low-quality` maps to `qualityFilter: summary`. It hides common noise while preserving meaningful short posts:

- pure retweets
- low-like, no-media tiny posts under 16 characters after stripping `https://t.co/` URLs
- low-like short authored replies under 60 characters
- low-like short link captions under 45 characters when they only contain `t.co` links and no media

It should preserve:

- media-only posts
- high-like short posts
- normal link posts with meaningful caption text
- longer replies when replies are intentionally included

For full-year summary work, default to exact bounds:

```bash
birdclaw --json search tweets --since 2020-01-01 --until 2021-01-01 --originals-only --hide-low-quality --limit 20000
```

In the current implementation, "low-like" means `like_count < 50`.

## Designing Better Filters

Before changing thresholds, inspect real included and excluded examples.

Recommended checks:

- count how many tweets each proposed rule removes
- sample by year, not just one month
- keep a reason label per rule while tuning
- verify media-only and high-like posts survive
- verify link-only quote posts are removed only when they are low-signal
- add `--min-likes`, media flags, or debug reason output only when the use case needs it

Useful SQL sketch for rule tuning:

```bash
sqlite3 ~/.birdclaw/birdclaw.sqlite "
select id, created_at, favorite_count, full_text
from tweets
where created_at >= '2020-01-01' and created_at < '2021-01-01'
order by random()
limit 50;"
```

## Verification

After query/filter changes, run focused tests first:

```bash
pnpm test src/lib/queries.test.ts src/cli.test.ts src/routes/api/query.test.ts
```

Then run the broader release-relevant gate:

```bash
pnpm run check
pnpm test
pnpm build
```

Smoke the CLI with a real year query:

```bash
pnpm --silent cli --json search tweets --since 2020-01-01 --until 2021-01-01 --originals-only --hide-low-quality --limit 20000
```
