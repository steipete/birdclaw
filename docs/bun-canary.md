---
title: Bun 1.4 canary
description: "Exact Bun 1.4 Rust-port build, compatibility constraints, verification, and rollback boundaries."
---

# Bun 1.4 canary

Birdclaw source development and its source-backed production deployment use one experimentally verified Bun 1.4 canary. This is not a floating `bun upgrade --canary` policy.

## Exact build

| Field | Value |
| --- | --- |
| Runtime revision | `1.4.0-canary.1+f972c287f` |
| Source commit | `f972c287f9b7a71754b0b0b1cd18722aa3c75280` |
| Buildkite build | `bun/bun#90456` |
| macOS arm64 asset id | `505967771` |
| macOS arm64 archive SHA-256 | `a172ae4984af3eaf986ab28268c9084a746f168fa77160bcd67d9bf83a9d50f9` |
| macOS arm64 binary SHA-256 | `9ff964c8b0cc9090f2b6f05a2e3f1da5c6d335ddfb7dbf23b47b14b70e53feac` |
| Linux x64 asset id | `505967785` |
| Linux x64 archive SHA-256 | `c6633a63e54d2371cfc1841f1a985fadae686a60f0b67e7d7248d8e0254772bf` |
| Linux x64 binary SHA-256 | `f150600ea0d05d12bfb3817052760591c30f870184a3008fca9667132be957a9` |

The machine-readable source of truth is `toolchains/bun-canary.conf`. `scripts/install-bun-canary.sh` downloads the revision-specific Buildkite artifact from build `90456`, verifies both checksums, then requires the exact `bun --revision`. A cached archive can be supplied through `BIRDCLAW_BUN_ARCHIVE`.

The GitHub `canary` release replaces same-named assets as Bun's `main` branch advances; its observed asset ids are retained only as provenance. Birdclaw never downloads that moving alias. If the immutable Buildkite artifact is unavailable, installation fails closed and requests a cached exact archive rather than substituting a newer canary.

## What “Rust port” means

Bun 1.4 is the first release line after Bun's Zig-to-Rust port. It preserves Bun's architecture rather than becoming a pure-Rust runtime: JavaScriptCore, SQLite, BoringSSL, and other native components remain embedded. Birdclaw describes it as the Rust-port Bun 1.4 canary, not as an all-Rust stack.

## Compatibility constraints

### Node contract

The npm and Homebrew package remains a Node CLI with `#!/usr/bin/env node` and `engines.node: >=26.5.1 <27`. CI builds and runs the installed package under real Node 26.5.1 as well as the exact Bun binary.

Bun reports Node compatibility `26.3.0`, below Birdclaw's public Node floor. Birdclaw does not weaken that floor or pretend Bun is a qualifying Node binary; Bun is identified through `process.versions.bun` and its own exact revision.

### SQLite and WAL

Birdclaw keeps the shared `node:sqlite` adapter. Bun's implementation supports the APIs Birdclaw uses, including FTS5, WAL, transactions, iterators, and BLOBs.

SQLite WAL readers sometimes need to create `-wal`/`-shm` coordination files after a clean process exit. Birdclaw therefore opens managed readers normally under Bun and immediately applies `pragma query_only = on`; Node keeps its native read-only open. Both connections remain unable to execute application writes or DDL, while Bun's SQLite library can establish WAL coordination. Dual-runtime package smoke covers MCP startup from a clean installed database, the case that exposed this constraint.

### Tests and coverage

Vitest runs under both runtimes. Bun needs `zod` inlined through Vitest's dependency server to avoid an externalization interop failure in the exact canary.

Bun uses JavaScriptCore, so the primary Bun coverage gate uses Istanbul. The same suite reports 79.08% Istanbul branch coverage versus 80.20% under Node/V8 because the providers count generated/default branches differently. Birdclaw keeps the original 80% Node/V8 branch gate and an explicit 79% Bun/Istanbul gate rather than disguising the provider change; line, statement, and function thresholds remain 85%. Coverage runs get a 30-second per-test ceiling for instrumentation overhead, while ordinary tests retain the tighter 10-second ceiling.

Playwright 1.63.0 is not generally documented as a Bun-supported runtime, but its full Birdclaw Chromium suite passes on this exact canary. CI pins that observed combination and tests the built production server, rather than claiming compatibility with arbitrary Bun versions.

### Environment and telemetry

Direct Bun execution loads `.env` files unless disabled. Birdclaw's wrapper and launchd examples always pass `--no-env-file`. The wrapper also defaults `DO_NOT_TRACK=1` so Bun does not upload crash reports from private local archives.

## Verification

```bash
./scripts/bun-canary.sh scripts/verify-bun-canary.mjs
./scripts/bun-canary.sh install --frozen-lockfile
./scripts/bun-canary.sh run --bun check
./scripts/bun-canary.sh run --bun coverage
./scripts/bun-canary.sh run --bun build
./scripts/bun-canary.sh run --bun e2e
```

Node compatibility:

```bash
fnm use
./scripts/bun-canary.sh run coverage:node
./scripts/bun-canary.sh run build:node
```

Installed-package proof creates npm and Bun tarballs with identical file lists, installs the npm tarball, then runs CLI, SQLite, SSR, static assets, MCP, and SIGTERM checks under both runtimes:

```bash
BIRDCLAW_NODE_BIN="$(command -v node)" \
  ./scripts/bun-canary.sh scripts/package-smoke.mjs --json
```

## Performance comparison

`runtime-perf.mjs` records raw cold CLI, server-listening, first-response, and RSS samples with median, p95, deterministic bootstrap intervals, runtime identity, artifact digests, physical database hashes, and WAL-aware logical SQLite hashes. Run it separately for the landed pre-migration artifact on Node (A), the migration artifact on Node (B), and the same migration artifact on Bun (C):

```bash
./scripts/bun-canary.sh scripts/runtime-perf.mjs \
  --label=migration-bun \
  --runtime="$(./scripts/install-bun-canary.sh)" \
  --runtime-arg=--no-env-file \
  --entry=bin/birdclaw.mjs \
  --home=/tmp/birdclaw-perf-home \
  --iterations=30 > runtime-perf-bun.json
```

Use separate byte-identical copies of the input database for each cell. A→B exposes build/package regressions; B→C isolates the runtime effect. `browser-perf.mjs` accepts the same explicit runtime/entry controls and runs against the built production server instead of a Vite development server.

The accepted comparison ran on an otherwise idle Apple Silicon M4 Max host with macOS 27.0, Node 26.7.0, byte-identical demo databases, and 30 cold runtime samples per cell. Each browser scenario also used 30 samples per cell after its request vector was made deterministic.

| Metric | Migration Node vs landed Node | Bun vs same migration artifact on Node |
| --- | ---: | ---: |
| CLI startup median | 0.4% faster | 44.0% faster |
| Server listening median | 1.2% faster | 44.4% faster |
| First response median | 0.6% faster | 52.5% faster |
| RSS median | 0.7% lower | 18.8% lower |

Across the six browser scenarios, Bun changed ready medians by -5.9% to +0.3% and action medians by -2.8% to +0.1%; the worst ready/action p95 regression was +0.4%. Endpoint counts, query scoping, row counts, preview counts, the deferred links prefetch, and the cached Home round trip matched exactly. WAL-aware logical database hashes were unchanged in every runtime cell. The sanitized summary is checked in at `docs/benchmarks/bun-canary-f972c287f-summary.json`; bounded raw runtime and browser shards live beside it.

## Production rollback boundary

Production installs the canary in a revision-specific side-by-side path. It does not overwrite `/opt/homebrew/bin/bun`, the stable Bun channel, the Node 26 runtime, or the saved Node LaunchAgent plist. Rollback restores the previous Node command vector and restarts the existing service; no database or package-manager downgrade is required.
