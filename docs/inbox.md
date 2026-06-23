---
title: Inbox
description: "AI-ranked actionable queue for mentions and DMs with optional OpenAI low-signal scoring."
---

# Inbox

`birdclaw inbox` is the unified triage queue. It mixes mentions and DMs, applies heuristic and (optionally) OpenAI-driven scoring, and lets you filter low-signal items out so the high-context stuff floats up.

## Default

```bash
birdclaw inbox --json
```

Returns a flat list of actionable items, ranked by:

- explicit reply state (unreplied first)
- recency
- author influence (follower count plus the derived score)
- low-signal heuristic (templated AI cadence, generic praise, link-only spam → demoted)

## By kind

```bash
birdclaw inbox --kind mentions --limit 10 --json
birdclaw inbox --kind dms --limit 10 --json
birdclaw inbox --kind mixed --limit 20 --json
```

`mixed` is the default. The mixed queue interleaves mentions and DMs while preserving the same ranking heuristic.

## OpenAI scoring

Pass `--score` to refresh stored OpenAI scores before listing. This requires `OPENAI_API_KEY` in the environment (or in `~/.profile`). Set `OPENAI_BASE_URL` to use an OpenAI-compatible endpoint instead of the default OpenAI API:

```bash
birdclaw inbox --score --hide-low-signal --limit 8 --json
birdclaw inbox --score --kind mentions --min-score 60 --limit 12 --json
```

What `--score` does:

- batches items that do not yet have a fresh score
- sends them to OpenAI with a structured prompt that asks for a 0–100 actionability score and a one-line reason
- stores `(score, reason, model, scored_at)` against the canonical record
- never mutates the canonical row itself

The raw mention or DM is the source of truth. Scores are overlays.

Without `OPENAI_API_KEY`:

- `--score` is a no-op and prints a warning to stderr
- the heuristic ranker still works
- `--hide-low-signal` and `--min-score` still filter on cached scores when present

## Filters

- `--limit <n>` — max items to return
- `--kind mentions|dms|mixed`
- `--replied` / `--unreplied`
- `--score` — refresh OpenAI scores before listing
- `--min-score <n>` — only include items at or above this score
- `--hide-low-signal` — drop items flagged by the low-signal heuristic OR scored under the low-signal threshold
- `--account <id>`

## Web UI

The `Inbox` lane wraps the same query. It exposes the score reason in the row hover and lets you re-score on demand without dropping back to the CLI.

## How to think about scoring

OpenAI scoring is an overlay, not a verdict. Use it to:

- **bucket noisy days** — "show me anything OpenAI thinks is at least 50/100"
- **demote obvious slop** — `--hide-low-signal` plus `--min-score 30` clears the worst cases
- **batch decisions** — pre-rank a 200-item queue, then walk top-to-bottom

Do not use it to:

- decide whom to block — read the actual content first
- replace your own judgment on borderline cases — fall back to [`profiles replies`](mentions.md#profile-reply-scan) for templated-AI checks

## See also

- [Mentions](mentions.md) — `mentions export` is the same queue without ranking
- [DMs](dms.md) — list/sync/search reference
- [Configuration](configuration.md) — `OPENAI_API_KEY` setup
