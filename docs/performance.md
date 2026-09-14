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
Links with fixed date bounds or the All range. Rolling Links ranges recalculate
on every request so their time windows remain accurate. Pooled readers share a
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
