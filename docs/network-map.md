---
title: Network Map
description: "Map current followers/following by profile location."
---

# Network Map

Server-side construction groups normalized locations in one pass, retaining
the first encountered spelling for geocoding and the existing point order.
Missing, suppressed, and empty locations retain their separate counts.

The web app has a **Map** view at `/network-map`. It reads current `follow_edges` plus hydrated `profiles.location`, normalizes free-form locations, geocodes them into the local SQLite cache, and plots followers, following, and mutuals.

The map covers the full selected network. Clustering runs on the server, which
returns markers for the current viewport and 160 people at a time. Use **Next**
and **Previous** to browse everyone in view; search includes every matching
person, including those on later pages. Panning keeps the current map visible
while the next view loads.

Ordinary map views use cached geocodes and coordinate locations without waiting
for external geocoding. **Refresh** can resolve additional locations on writable
deployments. The server reuses its map index for panning, searching, and paging,
and invalidates it when its database inputs change.

The UI requests `/api/network-map?format=view` with `bounds=west,south,east,north`,
`zoom`, `q`, and a zero-based `offset`. This response contains viewport markers,
cluster counts and profile previews, a page of people, and full-network totals.
The existing GeoJSON response remains available when `format` is omitted.

The index also retains four recent viewport results and up to 2,000 cluster
previews. Pagination reuses the viewport's ranked matches. Search text is
normalized lazily once per profile, and extending a search filters its previous
matches. Replacing or shortening a search starts from everyone in view. These
caches belong to the current database index and are discarded together when it
is invalidated.

Read-only deployments build the index from compact profile rows. Only located
groups are sorted, preserving the full GeoJSON order without sorting the entire
network in SQLite. Avatars, following counts, and verification details are loaded
in one batch for each page and its marker previews, with up to 4,096 recently
used profiles retained. Index validation and metadata reads use one transaction
on the index's original connection, so concurrent syncs cannot mix snapshots.
Following and Mutual views start from the indexed Following edges instead of
aggregating the entire follower network. Full GeoJSON exports and writable
geocoding retain their existing behavior.

Schema 14 tracks map inputs separately from other archive data. Read-only maps
survive unrelated external tweet/DM writes and sync timestamp updates. Display
changes clear the profile cache while retaining clustering, ranking, and search
state; relevant profile, relationship, and geocode changes rebuild the index.
Suppressed geocodes expire at their recorded deadline even without another write.
Explicit refresh still rebuilds the map. Prepare read-only deployments with a
writable initialization to schema 14 before serving this version.

Panning uses a 10-degree spatial grid to select nearby point candidates, followed
by the same exact bounds filter and rank ordering. Broad views retain a linear
scan when that is cheaper. Dateline crossings, wrapped worlds, and boundary
points preserve the existing behavior. The grid stores one numeric index per
in-range point across at most 648 cells; unusually ranged longitudes are checked
separately.

## Profiling

Run the reproducible synthetic benchmark with 544,560 profiles and 224,706
located people:

```bash
./scripts/bun-canary.sh scripts/network-map-perf.ts
```

It reports initial-load database time, ten uncached rebuilds for Followers,
Following, and Mutual, and median/p95 request times for 30 different
pages, changing searches, typed searches, and fresh pans. Times include response
validation and JSON serialization; response digests help compare correctness
between implementations. Its temporary database is removed afterward. An
optional existing Birdclaw home argument is opened read-only. The default fixture
also follows every hundredth profile. Pass a trusted baseline checkout as a
second argument to alternate before/after samples on the same archive and verify
every response digest:

```bash
./scripts/bun-canary.sh scripts/network-map-perf.ts /path/to/synthetic-home /path/to/baseline-checkout
```

Use `-` in place of the home to generate and remove a fixture automatically.

Generated fixtures also measure reads after unrelated tweet commits, unchanged
profile refreshes, display changes, and follower-count changes through a separate
writer. Writes are outside the read timer. Existing homes are never modified.
Measure trigger overhead independently with `scripts/network-map-write-perf.ts`,
which creates and removes matching schema-13 and schema-14 fixtures.

Rebuild medians exclude the first two samples. Request times include response
validation and serialization, while generation and database times are also
reported separately. See [Performance](performance.md) for measured tradeoffs.

To capture CPU samples and a readable hot-function report:

```bash
./scripts/bun-canary.sh --cpu-prof --cpu-prof-md --cpu-prof-dir=/tmp/map-profile scripts/network-map-perf.ts /path/to/benchmark-home
```

Use the same fixture and runtime for comparisons, run benchmarks sequentially,
and compare navigation medians separately from the first database read, which
is sensitive to filesystem caches and host load.

## Configuration

Runtime keys:

```bash
OPENCAGE_API_KEY=...
NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN=...
```

`BIRDCLAW_MAPBOX_ACCESS_TOKEN` is also accepted for local-only Birdclaw runs. The Mapbox token is sent to the browser; use a public Mapbox token. If Mapbox is missing, Birdclaw renders a lightweight local scatter map. If OpenCage is missing, Birdclaw uses cached geocodes and explicit coordinate locations only.

Useful refresh flow:

```bash
birdclaw sync followers --yes --json
birdclaw sync following --yes --json
birdclaw import hydrate-profiles --json
./scripts/bun-canary.sh run --bun dev
```

Profile avatars in markers, clusters, popups, and the visible-people list follow
the same [cache and fallback rules](media.md#avatars) as other profile views.
