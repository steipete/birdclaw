---
title: Install
description: "Install birdclaw via Homebrew, npm, or from source. Optional xurl and bird improve live transport coverage."
---

# Install

The published `birdclaw` package is a Node CLI plus a local web app. Source development and Birdclaw's production deployment use one checksum-pinned Bun 1.4 canary, while the npm/Homebrew artifact retains its public Node 26 contract.

## Requirements

- **Homebrew/npm runtime:** Node.js `>=26.5.1 <27`
- **Source toolchain:** the exact Bun `1.4.0-canary.1+f972c287f` recorded in `toolchains/bun-canary.conf`
- **Source bootstrap:** `curl`, `unzip`, and either macOS arm64 or Linux x64
- **macOS** is recommended for archive autodiscovery (Spotlight `mdfind`); Linux works for everything else
- **SQLite** uses the shared `node:sqlite` API under Node and Bun — no separate SQLite install is needed

Bun 1.4 is the Rust port of Bun, but it still embeds JavaScriptCore, SQLite, and other C/C++ components. The selected build is a canary rather than a stable release. Birdclaw verifies the archive checksum, extracted binary checksum, full source revision, and `bun --revision` before using it.

Bun's public `canary` download is rolling, so Birdclaw does not use it. The bootstrap downloads the revision-specific artifact from Bun's Buildkite build `90456` and fails closed on any checksum or revision mismatch. You can also pass a verified cached archive explicitly:

```bash
BIRDCLAW_BUN_ARCHIVE=~/Downloads/bun-darwin-aarch64.zip \
  ./scripts/install-bun-canary.sh
```

Optional but encouraged:

- [`xurl`](https://github.com/xdevplatform/xurl) — recommended official-API live reads/writes (likes, bookmarks, blocks, mutes, posting)
- an existing private `bird` installation — optional browser-cookie-backed compatibility fallback
- `OPENAI_API_KEY` — inbox scoring and low-signal filtering

birdclaw still works in pure local/archive mode without any of the optional tools.

## Homebrew (macOS, Linux)

```bash
brew install steipete/tap/birdclaw
birdclaw --version
```

The Homebrew formula lives in `steipete/homebrew-tap` and installs the npm artifact with its Node runtime contract.

## npm

```bash
npm install -g birdclaw
birdclaw --version
```

The package is published as [`birdclaw`](https://www.npmjs.com/package/birdclaw) on npm. Its `#!/usr/bin/env node` launcher and `engines.node` range remain tested in CI.

## From source

```bash
git clone https://github.com/steipete/birdclaw.git
cd birdclaw
./scripts/bun-canary.sh install --frozen-lockfile
./scripts/bun-canary.sh run --bun build
./scripts/bun-canary.sh bin/birdclaw.mjs --version
```

`./scripts/bun-canary.sh` installs the exact verified binary under the ignored project-local `.toolchains/` directory, prepends only that binary to `PATH`, disables Bun's implicit `.env` loading, and sets `DO_NOT_TRACK=1` unless you override it.

The source build produces the same compiled `bin/` plus `dist/cli`, `dist/client`, and `dist/server` artifact shape used by the npm package. Runtime TypeScript loaders are not shipped.

### Node compatibility from source

Node remains a named public contract rather than a fallback hidden inside the default scripts:

```bash
fnm use
./scripts/bun-canary.sh run test:node
./scripts/bun-canary.sh run coverage:node
./scripts/bun-canary.sh run build:node
```

Bun owns dependency installation through `bun.lock`; Node executes the same sources and compiled package in the compatibility lane.

## Verify the install

```bash
birdclaw --version
birdclaw auth status --json
birdclaw db stats --json
```

`auth status` runs Birdclaw's coarse xurl status probe. Verify xurl with `xurl whoami`. Existing private bird users can verify bird with `bird whoami`. See [Sign in](auth.md) for the complete setup and transport-selection model.

## Optional: xurl

```text
# macOS
brew install --cask xdevplatform/tap/xurl

# macOS or Linux
npm install -g @xdevplatform/xurl

xurl auth oauth2 --app my-app
xurl whoami
```

Alternatively, use xurl's [no-sudo install script](https://github.com/xdevplatform/xurl#installation). Register `my-app` through the [xurl authentication guide](https://github.com/xdevplatform/xurl#authentication), keeping the client secret out of shared shell history and process listings. The redirect URI configured in the X developer portal must match xurl's configured URI. Birdclaw shells out to xurl and does not own `~/.xurl`.

## Existing bird installations

Birdclaw preserves compatibility with existing private bird installations, but bird is not a public setup path for new users. If bird is already installed, verify it with `bird whoami`.

This compatibility path matters most for DMs, mentions, timeline reads, and moderation flows where X rejects OAuth2 writes.

If you only run birdclaw via `launchd` (`jobs install-bookmarks-launchd`), `bird` may need its `AUTH_TOKEN`/`CT0` exported via an env file because launchd does not see your interactive browser session. See [Jobs](jobs.md#env-files-for-launchd).

## Optional: OpenAI

```bash
export OPENAI_API_KEY="sk-..."
```

Add it to `~/.profile` or your shell rc to persist. The inbox uses OpenAI for low-signal scoring; without the key, `inbox --score` is a no-op and the heuristic ranker still works.

## Updating

- **Homebrew:** `brew upgrade birdclaw`.
- **npm:** `npm i -g birdclaw@latest`.
- **Source:** `git pull && ./scripts/bun-canary.sh install --frozen-lockfile && ./scripts/bun-canary.sh run --bun build`.

If the pinned Buildkite artifact is unavailable, use the previously verified archive through `BIRDCLAW_BUN_ARCHIVE`. Updating to a different Bun canary is a repository change with new artifact URLs, checksums, and a full compatibility/performance rerun, not an automatic upgrade.

### Upgrading to 0.14.0

[Birdclaw 0.14.0](https://github.com/steipete/birdclaw/releases/tag/v0.14.0) adds feed video/GIF playback, faster follower maps, archive permalinks, and optional Bird transports. See the [changelog](https://github.com/steipete/birdclaw/blob/main/CHANGELOG.md) for all changes.

Stop older web and scheduled writer processes before upgrading. Install the new version, then initialize each existing database with writable access before restarting services:

```bash
BIRDCLAW_DEPLOYMENT_READ_ONLY=0 BIRDCLAW_BACKUP_AUTO_SYNC=0 birdclaw init --json
birdclaw --version
birdclaw db stats --json
```

Use the same `BIRDCLAW_HOME` as the service. Writable initialization applies migrations in order through schema 14, including Note Tweet storage (11), read indexes (12), incremental search indexes (13), and map revision counters (14). Resume all writers with 0.14.0; older writers do not maintain the new search mappings. Read-only servers require this prepared schema and never run migrations themselves. Portable backups remain at schema 8.

## Uninstall

```bash
# Homebrew
brew uninstall birdclaw

# npm
npm rm -g birdclaw

# Optional source toolchain cache
rm -rf .toolchains/bun

# Optional: also remove local data
rm -rf ~/.birdclaw
```

The local data root defaults to `~/.birdclaw` (override via `BIRDCLAW_HOME`). Removing it deletes your imported archive, media cache, and live cache. Backup shards are stored separately if you set up [`backup sync`](backup.md).
