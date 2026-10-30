---
title: Public FxTwitter Import
description: "Explicitly import public tweets, threads, conversations, profiles, and bounded searches through the fixed read-only FxTwitter endpoint."
---

# Public FxTwitter import

Birdclaw can import selected public X data through FxTwitter without X credentials. This transport is off by default and runs only when `--fxtwitter` is present on that invocation:

```bash
birdclaw import tweet 20 2030857479001960633 --fxtwitter --json
birdclaw import thread 2030857479001960633 --fxtwitter --json
birdclaw import conversation 2030857479001960633 --fxtwitter --limit 200 --json
birdclaw import profile @jack --fxtwitter --json
birdclaw search tweets "local-first software" --fxtwitter --limit 50 --max-pages 3 --json
```

Tweet inputs must be numeric IDs or canonical HTTPS `x.com/<handle>/status/<id>` or `twitter.com/<handle>/status/<id>` URLs. Profile lookup accepts a public handle. Search accepts a non-empty query and the `latest`, `top`, or `media` feed.

Every request uses the hardcoded `https://api.fxtwitter.com` origin. There is no configuration, environment variable, or flag for a custom or self-hosted origin. Birdclaw sends no cookies or credentials, rejects redirects without following them, limits response size and total time, fetches sequentially, caps searches at 10 pages and 1,000 results, and applies capped Retry-After-aware backoff to rate limits and transient failures.

## Privacy and disclosure

FxTwitter is a third-party service. Passing `--fxtwitter` sends the requested tweet IDs, handles, or search queries to `api.fxtwitter.com`. The service and its hosting/network providers can also observe your IP address, request timing, and versioned Birdclaw user agent. Do not use this transport if that disclosure is unacceptable.

Birdclaw does not send X cookies, OAuth credentials, Birdclaw account data, DMs, unrelated local searches, or archive contents. It never falls back to FxTwitter from another transport, performs background polling, or turns an ordinary local read into a network request.

## Completeness and partial results

Every thread, conversation, and search result reports `collection.state`, `partialReasons`, `pagesFetched`, `itemsObserved`, retrieval time, and cursor/count evidence where available.

Thread and conversation responses are always `partial` with `endpoint_has_no_exhaustion_proof`: a clean `200`, a successful provider code, or a matching reply count cannot prove that FxTwitter did not silently omit a tail. Those rows remain useful and are imported.

Search is `complete` only when Birdclaw follows the documented bottom-cursor chain to an explicit terminal cursor. Caller limits, page budgets, timeouts, rate limits, upstream/decode failures, and missing, repeated, or cyclic cursors produce a successful `partial` result when at least one valid tweet was imported. If no usable item exists, JSON errors retain a typed `kind`, HTTP status, and `retryAfterMs` where applicable.

## Canonical persistence

Fetched tweets and profiles merge into the existing canonical tables and FTS index. Canonical tweet provenance remains in `tweet_sources` with `source = 'fxtwitter'`. Append-only fetch metadata and positive item observations live in `fxtwitter_fetches` and `fxtwitter_observations`; backups preserve them in `data/fxtwitter/fetches.jsonl` and `data/fxtwitter/observations.jsonl`.

Partial refreshes never delete rows, remove relationships, or interpret a missing result as negative evidence. Repeated and overlapping pages converge on the same canonical records while retaining endpoint, request context, retrieval, cursor, completeness, and per-item source evidence.

## Read-only boundary

The FxTwitter transport supports named public tweet, author-thread, conversation, profile-object, and bounded post-search reads only. It does not expose user timelines/status feeds, followers/following, trends, typeahead, standalone quote/repost products, bulk archival sync, DMs, home timelines, bookmarks, likes, authenticated mentions, private content, or any write.

## Offline X API v2 JSON import

Import tweet payloads already saved as X API v2 responses (`XurlTweetsResponse`) without network access or credentials. Each document may use `data` as one tweet object or an array; optional per-tweet `url` values are stored as `tweet_sources` provenance with `source = 'x-json'`.

```bash
birdclaw import x-json ./exports/tweets.jsonl --json
cat tweets.jsonl | birdclaw import x-json - --json
```

The import path itself does not call X or FxTwitter. Like other data-changing commands, a successful import still runs backup auto-sync when that preference is enabled, which can reconcile Git history and push your configured backup remote. For a strictly offline run with auto-sync disabled for one process:

```bash
BIRDCLAW_BACKUP_AUTO_SYNC=0 birdclaw import x-json ./exports/tweets.jsonl --json
```

The command prints `{ imported, skipped, errors }`. Malformed JSONL lines are rejected whole; re-importing the same tweet ids is idempotent.
