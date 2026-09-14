---
title: Performance
description: Profile page reads against a large synthetic archive.
---

# Page performance

Archive feeds select a bounded set of recent tweet candidates before hydrating
profile, reply, quote, and collection details. Account selection, saved-post
filters, dates, and pagination cursors apply within that selection. If it cannot
fill the requested page, the complete query runs so older or sparse matches are
never omitted. Full-text search and literal-account security limits retain their
specialized query paths.

Read-only deployments reuse validated JSON for feeds, DMs, Inbox, Blocks, and
Links with fixed date bounds or the All range. Rolling Links ranges probe indexed
time boundaries and reuse a result only while the included occurrence set stays
the same, updating the displayed bounds on every request. Pooled readers share a
cache per database, validated through the original connection's data version;
external commits and closed reader pools invalidate it. Account and filter keys
remain separate, writable deployments bypass response caching, and authorization
runs before cache lookup. Cache storage is bounded to two databases with 100
entries / 4 MiB each; oversized responses are not retained.

## Reproduce the page audit

Create a fresh synthetic home (the destination must not exist):

```bash
./scripts/bun-canary.sh scripts/page-perf-fixture.ts /tmp/birdclaw-page-fixture
```

It contains 100,000 profiles, 250,000 posts, 40,000 conversations, 200,000 messages,
10,000 blocks, and 25,000 link occurrences, with no credentials or real content.

Build and run the production server:

```bash
./scripts/bun-canary.sh run --bun build
BIRDCLAW_HOME=/tmp/birdclaw-page-fixture BIRDCLAW_DEPLOYMENT_READ_ONLY=1 BIRDCLAW_LOCAL_WEB=1 ./scripts/bun-canary.sh bin/birdclaw.mjs serve --port 3143
```

In another terminal:

```bash
./scripts/bun-canary.sh scripts/page-perf.mjs http://127.0.0.1:3143 audit
```

The benchmark checks HTML for all 15 page routes and measures the nine archive
surfaces, including both fixed and rolling Links ranges. Six provider/live-mode
pages are intentionally gated in read-only mode. The browser smoke test also
covers these enabled and gated routes using synthetic data.

Report first API request time separately from warm median/p95, and compare
response digests to guard correctness. HTML timings do not measure client paint;
first-request results are sensitive to filesystem caches and host load. Run
before/after benchmarks sequentially against the same archive and runtime.

## SQLite audit

Run the database workload directly, without HTTP response caching:

```bash
./scripts/bun-canary.sh scripts/sqlite-perf.ts > sqlite-performance.json
```

The harness creates and removes its own synthetic archive, runs six samples per
workload, records the first sample separately, and reports the median of the five
warm samples. It exercises real feed, search, DM, Links, map, and cached DM sync
code, verifies stable result hashes, captures query plans, and measures index
storage and bulk insert costs. Writes are rolled back between samples. It never
accepts an existing archive path. DM input comes from a synthetic sync-cache entry.

For CPU attribution, run separately with Bun's profiler:

```bash
./scripts/bun-canary.sh --cpu-prof --cpu-prof-md --cpu-prof-dir=/tmp scripts/sqlite-perf.ts
```

The September 2026 audit compared schema 11 and schema 12 on the page fixture
above using the pinned Bun runtime. Unprofiled medians were:

| Workload | Before | After |
| --- | ---: | ---: |
| Home feed, 50 posts | 15.8 ms | 13.7 ms |
| Uncached full map, 100,000 profiles | 201.8 ms | 191.6 ms |
| Sync 10,000 DMs and read back the complete search index | 999.0 ms | 277.1 ms |
| Select 5,000 tweet IDs from 250,000 identical timestamps | 42.6 ms | 0.46 ms |
| Insert 10,000 current follow edges | 13.6 ms | 25.1 ms |
| Insert 10,000 tweets | 17.8 ms | 18.0 ms |

All result hashes matched. Tweet search, follower-sorted DMs, and rolling Links
were effectively unchanged at about 2 ms, 18 ms, and 100 ms respectively. Full
sample data and query plans are in [the benchmark record](https://github.com/steipete/birdclaw/blob/main/docs/benchmarks/sqlite-performance.json).

The main write bottleneck was repeated scanning of unindexed FTS message IDs.
Replacing 500-ID chunks with one JSON-bound batch reduced isolated deletion of
10,000 IDs from about 798 ms to 74 ms on a 200,000-message index. Tweet/archive
ingestion already batches equivalent search replacements. The CPU profile
confirmed native SQLite calls dominated; generic row normalization and statement
wrapping were small enough to leave unchanged.

The tweet index now includes the ID tie breaker, eliminating a temporary sort
and allowing ID-only selection from a covering index. Map membership uses a
partial covering index to avoid sorting and loading full edge rows. These
indexes cost about 2.1 MiB extra for 250,000 tweets and 3.3 MiB for 100,000 current
edges. The extra graph index also increases bulk-insert work, as shown above.
The migration runs once on writable startup; upgrade the database before serving
it in read-only mode.

Map timings include SQL, row decoding, location grouping, and feature creation.
Profiler and garbage-collection overhead can obscure the smaller map gain; one
profiled run was slower after the change, while the paired SQL experiment and
unprofiled run improved. These measurements are local database timings, not
hosted browser latency. Cold Links still reads author influence across tied
candidate groups; the incremental follow-up below addresses repeated reads. The audit made
no changes to journaling, synchronization, foreign keys, or reader ownership.

## Incremental search and rolling Links

Schema 13 adds an indexed mapping from canonical tweet/message IDs to FTS row
IDs. Small updates compare only those documents and leave unchanged text alone.
Large batches avoid probing every old FTS body and replace their selected rows
in bounded groups. Canonical reads finish before search deletion/insertion;
JSON-bound writes process ascending FTS row IDs. Live sync, replies, imports, and
backup merges use the same final-content writer. Retention cleanup also uses
the mapping, so a small sync no longer scans the whole archive twice.

Rolling Links reads can reuse the same result while time advances between
occurrences. Two indexed boundary probes identify the included timestamp range;
the cache updates the response's displayed bounds on each call. Each read-only
reader owns a cache capped at 100 entries / 4 MiB. A read transaction pins the
probes and result to one SQLite snapshot. Crossing either boundary or observing
an external commit recomputes the result. Writable reads bypass reuse.

Reproduce this follow-up with an automatically created synthetic archive:

```bash
./scripts/bun-canary.sh scripts/sqlite-incremental-perf.ts
```

The harness runs actual cached DM sync, tweet ingestion, and rolling Links code.
Search-index verification reads run **outside** the operation timing. Each write
sample rolls back, excluding commit/fsync cost. Rolling timestamps advance on
every sample and are checked separately from the content hash. Unlike the first
audit's DM scenario, these sync timings do not include a complete FTS readback.

A sequential comparison against schema 12 produced these warm medians:

| Workload | Before | After |
| --- | ---: | ---: |
| Sync one changed message | 33.3 ms | 4.2 ms |
| Sync one unchanged message | 33.3 ms | 3.0 ms |
| Sync 100 changed messages | 49.4 ms | 10.4 ms |
| Sync 100 unchanged messages | 47.9 ms | 9.3 ms |
| Sync 10,000 changed messages | 216.5 ms | 216.7 ms |
| Sync 10,000 unchanged messages | 199.8 ms | 205.7 ms |
| Ingest 100 changed tweets | 149.8 ms | 18.2 ms |
| Repeated rolling Links read | 111.1 ms | 0.45 ms |

All full search-index and Links content hashes matched. The large-batch results
are effectively unchanged; the gains target frequent small syncs and repeated
reads. Cold Links ranking still takes roughly 100 ms on this fixture. Absolute
timings vary with host load. The [raw samples](https://github.com/steipete/birdclaw/blob/main/docs/benchmarks/sqlite-incremental-performance.json)
include both initial requests and all five warm samples.

The migration rebuilds the derived search indexes once from active canonical
content, removing legacy duplicates and stale entries. Existing FTS query syntax
and snippets remain compatible. Upgrade a database through writable startup
before serving it with this version in read-only mode. Portable backups retain
their canonical format and rebuild the derived mapping when imported.
Stop older writer processes before upgrading; all writers of the migrated
database must use the indexed search writer in this version.
