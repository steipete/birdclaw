---
title: Network Map
description: "Map current followers/following by profile location."
---

# Network Map

The web app has a **Map** view at `/network-map`. It reads current `follow_edges` plus hydrated `profiles.location`, normalizes free-form locations, geocodes them into the local SQLite cache, and plots followers, following, and mutuals.

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

Profile avatars in markers, clusters, popups, and the visible-people list use the
local image cache first. If a cached image is missing, the browser tries the
stored HTTPS Twitter profile-image URL once, without a referrer. Initials remain
when neither source is available. This also works in read-only deployments without
populating the server cache.
