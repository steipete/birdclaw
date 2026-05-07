---
title: DMs
description: "Triage direct messages by sender follower count, derived influence score, and reply state."
---

# DMs

birdclaw treats DMs as first-class content: full-text indexed, multi-account, and filterable by sender context. The web app's `DMs` lane uses the same query model you get from the CLI.

## List conversations

```bash
birdclaw dms list --refresh --limit 10 --json
birdclaw dms list --unreplied --min-followers 500 --min-influence-score 90 --sort influence --json
```

`dms list` is the no-query view onto conversations and recent events. It is optimized for agent and operator filtering — you do not need a search query to walk the inbox.

Flags:

- `--refresh` — refresh live DMs through `bird` before listing
- `--cache-ttl <seconds>` — tune freshness
- `--participant <handle-or-id>`
- `--min-followers <n>` / `--max-followers <n>`
- `--min-influence-score <n>` / `--max-influence-score <n>`
- `--sort recent|influence`
- `--replied` / `--unreplied`
- `--account <name>`
- `--limit <n>`

## Sync

Refresh live direct messages through `bird` and merge into the canonical conversation/message tables:

```bash
birdclaw dms sync --limit 50 --refresh --json
```

Flags:

- `--account <account-id>`
- `--limit <n>`
- `--refresh` — force a live fetch
- `--cache-ttl <seconds>`

Sync is idempotent — re-running merges new events without disturbing already-imported message bodies.

## Search

```bash
birdclaw search dms "prototype" --json
birdclaw search dms "layout" --min-followers 1000 --min-influence-score 120 --sort influence --json
birdclaw search dms "invoice" --participant @someone --replied --json
birdclaw search dms "blacksmith" --context 4 --resolve-profiles --expand-urls --no-xurl-fallback --json
birdclaw whois "blacksmith guy" --context 4 --no-xurl-fallback --json
birdclaw whois "blacksmith" --context 4 --no-xurl-fallback --json
```

Same FTS5 backbone as tweet search, with the DM-specific filters layered on top. See [Search](search.md#search-dms) for the full flag list.

For identity lookups, `whois` clusters matching conversations, includes nearby DM
context, resolves numeric archive profiles through cache-backed `bird`/`xurl`
lookups, preserves richer profile metadata, checks first-class affiliations,
bio entities, and profile-change snapshots, and expands URLs through the
persistent cache. JSON candidates include `profileEvidence` so agents can
separate bio/profile URL/affiliation/history evidence from plain DM keyword
matches. Fuzzy identity prompts such as `blacksmith guy` search significant
terms and can rank a profile from bio `@handle`, domain, and company-phrase
evidence even when the literal phrase was not in the DM.

## Influence score

Influence is a derived ranking signal that starts with follower count and folds in:

- verified status
- prior reply / DM history with the active account
- follower-to-following ratio
- account age
- block / mute history

It is intentionally simple. The goal is to bucket noisy inboxes ("strangers with no follow signal" vs "people you actually talk to"), not to produce a global ranking.

When triaging a quiet day, sort by `influence` to surface higher-context conversations first:

```bash
birdclaw dms list --unreplied --sort influence --limit 20 --json
```

When triaging a noisy day, hide low-influence senders entirely:

```bash
birdclaw dms list --unreplied --min-influence-score 80 --limit 20 --json
```

## Reply

```bash
birdclaw compose dm dm_003 "Send it over."
```

Replies use the active live transport (`auto` by default). Without a working transport, the command fails fast with exit code `4` rather than recording a half-state local row.

## DM mode on archive import

Twitter archives include full DM history but the JSON is awkward. By default, `import archive` runs `--dm-mode full` so message bodies land in SQLite and become FTS5-searchable. Pass `--dm-mode metadata` if you only want conversation skeletons (faster import, no body content).

```bash
birdclaw import archive ~/Downloads/twitter-archive.zip --dm-mode metadata --json
birdclaw import archive ~/Downloads/twitter-archive.zip --dm-mode full --json
```

## Web UI

The `DMs` lane uses a two-column layout:

- left: conversation list, filterable by participant, follower count, influence, reply state
- right: detail view with sender bio, follower count, and influence visible in the header so you do not have to dig

Theme follows the system / light / dark switcher with an animated transition.

## See also

- [Search](search.md#search-dms) — full filter reference
- [Inbox](inbox.md) — mixed mention + DM triage with AI ranking
- [Sync](sync.md) — DMs share the cursor / cache rules of other syncs
