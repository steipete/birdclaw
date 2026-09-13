---
title: DMs
description: "Triage direct messages by sender follower count, derived influence score, and reply state."
---

# DMs

birdclaw treats DMs as first-class content: full-text indexed, multi-account, and filterable by sender context. The web app's `DMs` lane uses the same query model you get from the CLI.

## List conversations

```bash
birdclaw dms list --refresh --limit 10 --json
birdclaw dms list --refresh --mode auto --limit 10 --json
birdclaw dms list --unreplied --min-followers 500 --min-influence-score 90 --sort followers --json
```

`dms list` is the no-query view onto conversations and recent events. It is optimized for agent and operator filtering — you do not need a search query to walk the inbox.

Flags:

- `--refresh` — refresh live DMs before listing
- `--mode web|bird|xurl|auto` — choose the live transport for refreshes
- `--cache-ttl <seconds>` — tune freshness
- `--participant <handle-or-id>`
- `--min-followers <n>` / `--max-followers <n>`
- `--min-influence-score <n>` / `--max-influence-score <n>`
- `--sort recent|followers`
- `--replied` / `--unreplied`
- `--account <name>`
- `--limit <n>`

## Sync

Refresh live direct messages and merge into the canonical conversation/message tables:

```bash
birdclaw dms sync --limit 50 --refresh --json
birdclaw dms sync --mode auto --limit 50 --refresh --json
```

Flags:

- `--account <account-id>`
- `--mode web|bird|xurl|auto`
- `--limit <n>`
- `--refresh` — force a live fetch
- `--cache-ttl <seconds>`

Sync is idempotent — re-running merges new events without disturbing already-imported message bodies.

`--mode auto` is the default. It uses native `web` for request inboxes when session cookies are configured, and for the default account's full inbox so request state is retained. Other reads try xurl, with native-cookie and legacy bird fallback when available. `--mode xurl` imports recent OAuth2 `/2/dm_events` as accepted conversations; that API does not expose accept/reject state. Explicit non-default account reads prefer account-scoped xurl; `--mode web` requires cookies matching the selected account.

## Message requests without bird

Set `AUTH_TOKEN` and `CT0` in a protected environment, then use the native web transport:

```bash
birdclaw dms sync --mode web --inbox requests --limit 20 --max-pages 3 --refresh --json
birdclaw dms accept <conversation-id> --json
birdclaw dms reject <conversation-id> --json
birdclaw dms block <conversation-id> --json
```

Actions default to native `web`; pass `--mode bird` for an existing legacy installation.
Auto read failures can fall back to xurl for accepted/all inboxes or independently
verified bird for request inboxes. Select `--mode web` to require native behavior;
request actions never switch transports or replay a failed mutation.
Blocking requires a single other participant in a one-to-one conversation. Account
verification runs before remote operations, and local request state changes only
after success. All DM transport caches are invalidated after an action so an older
cached request cannot reappear. Native requests never launch a browser or read its
cookie database. Native pagination uses `--max-pages`, or a maximum of 250 extra
pages per inbox with `--all-pages`, with a 15-second timeout per HTTP request,
32 MiB per response, and 128 MiB per operation. See [Sign in](auth.md#run-without-bird).

## Search

```bash
birdclaw search dms "prototype" --json
birdclaw search dms "layout" --min-followers 1000 --min-influence-score 120 --sort followers --json
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

For "find the people from X" tasks, prefer:

```bash
birdclaw whois "github guy" --current-affiliation github --exclude-domain-only --no-xurl-fallback
```

That keeps current affiliation/bio/history evidence ahead of plain profile
links and separates ecosystem mentions from likely staff/company matches.

## Influence score

The CLI rejects non-finite `--min-followers` and `--max-followers` values before refreshing or reading DMs. Existing finite thresholds, including fractions and numeric spellings such as `1e3`, retain their filtering behavior in both `dms list` and `search dms`.

Influence is a derived ranking signal that starts with follower count and folds in:

- verified status
- prior reply / DM history with the active account
- follower-to-following ratio
- account age
- block / mute history

It is intentionally simple. The goal is to bucket noisy inboxes ("strangers with no follow signal" vs "people you actually talk to"), not to produce a global ranking.

When triaging a quiet day, sort by `followers` to surface higher-context conversations first:

```bash
birdclaw dms list --unreplied --sort followers --limit 20 --json
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

## Archive import

Twitter archives include full DM history but the JSON is awkward. `import archive` imports message bodies into SQLite and makes them FTS5-searchable.

Use `--select directMessages` when a newer archive has fresher DMs and you do not want to touch tweets, likes, bookmarks, profiles, or follow data. The selected re-import merges archive DM rows for `acct_primary` and preserves other accounts. Add `--restore` to clear and exactly replay that account's archive DMs before rebuilding DM FTS. `dms` is accepted as a shorter alias.

```bash
birdclaw import archive ~/Downloads/twitter-archive.zip --select directMessages --json
birdclaw import archive ~/Downloads/twitter-archive.zip --select dms --json
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
