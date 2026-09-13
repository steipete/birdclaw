---
title: Network Map
description: "Map current followers/following by profile location."
---

# Network Map

The web app has a **Map** view at `/network-map`. It reads current `follow_edges` plus hydrated `profiles.location`, normalizes free-form locations, geocodes them into the local SQLite cache, and plots followers, following, and mutuals.

The map covers the full selected network. Clustering runs on the server, which
returns markers for the current viewport and 160 people at a time. Use **Next**
and **Previous** to browse everyone in view; search includes every matching
person, including those on later pages. Panning keeps the current map visible
while the next view loads.

Ordinary map views use cached geocodes and coordinate locations without waiting
for external geocoding. **Refresh** can resolve additional locations on writable
deployments. The server reuses its map index for panning, searching, and paging,
and invalidates it after local or external database writes.

The UI requests `/api/network-map?format=view` with `bounds=west,south,east,north`,
`zoom`, `q`, and a zero-based `offset`. This response contains viewport markers,
cluster counts and profile previews, a page of people, and full-network totals.
The existing GeoJSON response remains available when `format` is omitted.

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
