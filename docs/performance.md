---
title: Performance
description: Profile page reads against a large synthetic archive.
---

# Page performance

## Compiled response validation

Shared API response and report-event schemas use Zod's `compile()` once when
their modules load. Server response checks and browser parsing reuse these
schemas. Field schemas remain available for composition and type inference;
defaults, media normalization, unknown-field handling, and detailed validation
errors retain their existing behavior. Zod uses its ordinary parser when a
schema cannot be compiled, including environments that disallow dynamic code
generation.

Run the synthetic parser benchmark with the pinned Bun runtime:

```bash
./scripts/bun-canary.sh scripts/validation-perf.ts
```

To compare on Node using the same installed dependencies:

```bash
./scripts/bun-canary.sh build scripts/validation-perf.ts --target=node --packages=external --outfile=node_modules/.cache/birdclaw-validation-perf.mjs
node node_modules/.cache/birdclaw-validation-perf.mjs
```

The harness compares each compiled schema with an ordinary clone of the same
definition, checks complete output equality, warms both parsers, and alternates
their order over eight samples. It also verifies strict compilation support and
reports compilation time separately. On this local synthetic workload:

| Validation workload | Bun speedup | Node speedup |
| --- | ---: | ---: |
| Feed with 50 posts, media, and quoted posts | 1.50× | 1.78× |
| DM conversation with 100 messages | 1.88× | 1.94× |
| Map with 1,000 profiles | 9.18× | 6.96× |
| Report text delta | 7.19× | 4.11× |

These are warm parser timings, excluding SQL, JSON encoding/decoding, network,
and rendering. Report deltas take well below a microsecond in either mode.
Compilation adds module initialization work: the broad query schema took about
52 ms on Bun and 26–29 ms on Node; the map and report-event schemas took less
than 1 ms each. Type-only consumers do not load these validators. Absolute
timings vary by runtime and host. Full samples and output hashes are in the
[benchmark record](https://github.com/steipete/birdclaw/blob/main/docs/benchmarks/validation-performance.json).

## Archive page reads

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

## Uncached Videos and maps

Videos queries reject URLs without any video-host fragment before evaluating
the complete scheme/subdomain predicates. The fragments are derived from the
supported host list and only provide a cheap rejection step; the existing exact
checks still decide eligibility. SQLite's lazy `CASE` evaluation avoids running
all host predicates for ordinary non-video URLs.

Map construction now groups normalized locations while counting located and
meaningful profiles. This removes the per-profile location-key map, two filtered
arrays, and a later regrouping pass. Geocode selection, original location text,
point ordering, relationship filters, and counts are unchanged.

Run uncached model reads against the synthetic page archive:

```bash
./scripts/bun-canary.sh scripts/cold-read-perf.ts
```

To compare with a trusted baseline checkout using the same schema, pass its
path as the optional argument. Both versions read the same generated archive;
the harness alternates execution order, checks complete response hashes, and
reports ten samples with the first two excluded from the median. SQLite and
filesystem caches may be warm. Links response caching is bypassed, and maps are
rebuilt with external geocoding disabled. `map-view` includes cluster creation.

| Uncached model read | Before | After |
| --- | ---: | ---: |
| Links control, unchanged algorithm | 112.5 ms | 110.8 ms |
| Videos | 173.4 ms | 97.8 ms |
| Full map data, 100,000 profiles | 236.9 ms | 197.5 ms |
| Map viewport including cluster construction | 273.4 ms | 234.3 ms |

Every response hash matched. These local measurements exclude HTTP transfer and
browser rendering, and absolute times depend on host load. The Videos gain
depends on the archive's mix of video and non-video URLs. This change adds no
database index, migration, or response cache. The [raw sample record](https://github.com/steipete/birdclaw/blob/main/docs/benchmarks/cold-read-performance.json)
includes the initial request timings and all subsequent samples.

## Compact read-only maps

Read-only map views now scan compact profile columns and sort only located
groups, retaining the full GeoJSON point order. Display-only fields (avatar,
following count, verification) are loaded for each response in one batch and
retained in a 4,096-profile LRU. Cluster previews keep point indices, so they do
not retain evicted profile metadata. The owning connection pins validation,
index construction, and hydration to the same read transaction. The follow-up
below narrows external-write invalidation while retaining these snapshot boundaries.

Following and Mutual membership uses the existing direction index and indexed
opposite-edge lookups. It no longer aggregates every follower before selecting
the small Following network. Followers and All retain the covering membership
aggregation, which performed better for those larger selections. No new index,
migration, journaling, or synchronization change is required.

Paired measurements against the preceding implementation, using the same
runtime and alternating execution order, produced these generation medians:

| Map workload | Before | After |
| --- | ---: | ---: |
| Rebuild Followers, 544,560 profiles / 224,706 located | 1,014.7 ms | 793.5 ms |
| Rebuild Following, 5,445 profiles | 181.1 ms | 46.7 ms |
| Rebuild Mutual, 5,445 profiles | 182.5 ms | 45.7 ms |
| Rebuild Followers, 100,000 profiles all located | 217.3 ms | 164.2 ms |
| Full GeoJSON control, 100,000 profiles | 183.6 ms | 187.5 ms |

The large fixture's first map request took 1,031.4 → 733.9 ms. Rebuild results
exclude the first two of ten samples; these are uncached model reads with
potentially warm filesystem pages, not production HTTP or browser latency.
Avatars were null in both fixtures, so the measurements do not assume long avatar
URLs. Full GeoJSON work is effectively unchanged. All response digests matched.

There is a small navigation tradeoff: median pagination including validation and
serialization went from 0.99 to 1.52 ms as newly visible metadata was fetched.
Changing searches measured 5.41 → 5.50 ms, typed searches 1.80 → 2.17 ms, and
fresh pans 7.27 → 6.35 ms. These timings vary with host load; the gain is primarily
initial construction and rebuilds after syncs, not faster cached pagination.

Run `scripts/network-map-perf.ts` with a synthetic home and optional baseline
checkout for the large paired audit. `scripts/cold-read-perf.ts` generates the
100,000-profile fixture and checks full-map and unrelated query controls. Both
compare schema-normalized map responses, ignoring JSON property insertion order.
The [raw record](https://github.com/steipete/birdclaw/blob/main/docs/benchmarks/compact-map-performance.json)
contains all rebuild samples and navigation summaries.

A separate Bun CPU profile of the updated large-fixture harness still attributed
67% of sampled self time to native SQLite `.all` calls. Location grouping was
about 2% and native sorting about 1.5%. The profile supports reducing database
work as the main target; profiled timings are excluded from the comparison table.

## Map invalidation and spatial reads

The next pass targets unnecessary rebuilds and fresh viewport reads. Schema 14
adds transactional counters for map index inputs and display metadata. An
unrelated external commit no longer discards the map. Avatar, following-count,
and verification changes clear only the metadata LRU; actual index changes and
explicit refresh still rebuild it. Null-safe trigger comparisons skip unchanged
fields, and suppression deadlines prevent time-based metadata from staying stale.
The counters are global to the database, while account/type cache keys and owner
snapshot boundaries remain unchanged. Inserts and deletes invalidate conservatively.

Fresh pans use a bounded spatial grid before the existing exact bounds filter.
Small views sort only their matching point indices back into rank order. Broad
views keep the existing scan. This costs one additional numeric index per point
and at most 648 cell arrays; it adds no dependency or database index.

The paired synthetic 544,560-profile / 224,706-point audit measured these median
response times, including schema validation and JSON serialization:

| Request | Before | After |
| --- | ---: | ---: |
| Fresh regional pan | 6.70 ms | 0.52 ms |
| Map after unrelated tweet commit | 762.76 ms | 1.11 ms |
| Map after profile refresh with unchanged map fields | 692.40 ms | 1.57 ms |
| Map after avatar/following-count change | 691.90 ms | 4.47 ms |
| Pagination | 1.32 ms | 1.35 ms |
| Forced follower-map rebuild | 692.13 ms | 696.77 ms |
| Map after follower-count change | 691.96 ms | 767.85 ms |

Every corresponding response digest matched. The improvement is in avoiding
unnecessary work and finding visible people; initial construction still costs
roughly 0.7 seconds on this fixture. Actual index changes retain that full cost,
with some extra grid construction and variable host/GC overhead. These are local
model timings, not hosted browser measurements. Writes happen before each read
timer on a separate connection; the index, revision, and hydrated details are
read within one snapshot.

Reproduce both sides against a trusted checkout of the preceding version:

```bash
./scripts/bun-canary.sh scripts/network-map-perf.ts - /path/to/baseline-checkout
./scripts/bun-canary.sh scripts/network-map-write-perf.ts
```

The write audit uses separate, identical 10,000-profile/edge databases with
schema 13 and 14. It alternates execution order and checks complete canonical
rows outside the timed operation. DML is rolled back, so these measurements omit
commit latency. The schema adds 8 KiB on this fixture. Updates to 100 profiles
measured 0.32 → 0.40 ms for an unchanged-fields refresh, 0.19 → 0.25 ms for display
changes, and 0.14 → 0.20 ms for follower counts. Ending 10,000 follow edges measured
114.5 → 124.9 ms; inserting 1,000 Following edges measured 106.6 → 131.6 ms.
Other bulk write samples varied with page-cache and host I/O behavior; no write
speedup is claimed. WAL, synchronization, and foreign-key settings are unchanged.

The [raw record](https://github.com/steipete/birdclaw/blob/main/docs/benchmarks/map-invalidation-performance.json)
contains all rebuild/post-commit samples, navigation summaries, and write controls.
Further SQL join, covering-index, array-row, and JSON-aggregation experiments did
not provide a reliable improvement over the existing compact scan and were not
adopted.
