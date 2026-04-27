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
