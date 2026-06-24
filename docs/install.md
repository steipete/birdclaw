---
title: Install
description: "Install birdclaw via Homebrew, npm, or from source. Optional xurl and bird improve live transport coverage."
---

# Install

`birdclaw` ships as a Node CLI plus a local web app. Pick whichever path fits the machine.

## Requirements

- **Node.js** 25.8.1 or Node 26.x (managed via `fnm`, `nvm`, or `volta`)
- **pnpm** 10.x for source installs
- **macOS** is recommended for archive autodiscovery (Spotlight `mdfind`); Linux works for everything else
- **SQLite** uses Node's native `node:sqlite` runtime — no system install needed

Optional but encouraged:

- [`xurl`](https://github.com/xdevplatform/xurl) — official-API live reads/writes (likes, bookmarks, blocks, mutes, posting)
- [`bird`](https://github.com/steipete/bird) — relay/profile-backed reads/writes for surfaces where `xurl` is rate-limited or unavailable
- `OPENAI_API_KEY` — inbox scoring and low-signal filtering

birdclaw still works in pure local/archive mode without any of the above.

## Homebrew (macOS, Linux)

```bash
brew install steipete/tap/birdclaw
birdclaw --version
```

The Homebrew formula lives in `steipete/homebrew-tap` and installs the `birdclaw` binary plus a launchd plist target.

## npm / pnpm

```bash
pnpm add -g birdclaw
# or
npm install -g birdclaw

birdclaw --version
```

The package is published as [`birdclaw`](https://www.npmjs.com/package/birdclaw) on npm.

## From source

```bash
git clone https://github.com/steipete/birdclaw.git
cd birdclaw
fnm use
pnpm install
pnpm build
node ./bin/birdclaw.mjs --version
```

`fnm use` reads the version from `.node-version`. Source builds run the same `tsx`-based entrypoint as the published binary.

## Verify the install

```bash
birdclaw --version
birdclaw auth status --json
birdclaw db stats --json
```

`auth status` runs Birdclaw's coarse xurl status probe. Verify xurl with `xurl whoami` and bird with `bird whoami`. See [Sign in](auth.md) for the complete setup and transport-selection model.

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

## Optional: bird

```text
npm install -g @steipete/bird
bird whoami
```

bird uses its configured relay profile for auth. This matters most for timeline, mentions, likes/bookmarks, profile lookups, tweet/reply writes, and moderation flows where X rejects OAuth2 writes. The current bird CLI does not expose DMs.

For any Birdclaw account that should use bird-backed syncs, attach the bird relay profile before scheduled syncs:

```text
birdclaw accounts set-bird-profile --account acct_openclaw --profile-name work
```

If you only run birdclaw via `launchd`, use an env file only for process-level settings such as a relay base URL. Account selection still comes from the account's stored `bird_profile_name`. See [Jobs](jobs.md#env-files-for-launchd).

## Optional: OpenAI

```bash
export OPENAI_API_KEY="sk-..."
# Optional: route OpenAI calls to a compatible endpoint.
export OPENAI_BASE_URL="http://127.0.0.1:8080/v1"
```

Add these to `~/.profile` or your shell rc to persist. The inbox uses OpenAI for low-signal scoring; without the key, `inbox --score` is a no-op and the heuristic ranker still works.

## Updating

- **Homebrew:** `brew upgrade birdclaw`.
- **npm:** `pnpm up -g birdclaw` (or `npm i -g birdclaw@latest`).
- **Source:** `git pull && pnpm install && pnpm build`.

The local SQLite store is forward-compatible across point releases. Long-running schema migrations run on startup; `birdclaw db stats --json` reports the current schema version.

## Uninstall

```bash
# Homebrew
brew uninstall birdclaw

# npm
pnpm rm -g birdclaw

# Optional: also remove local data
rm -rf ~/.birdclaw
```

The local data root defaults to `~/.birdclaw` (override via `BIRDCLAW_HOME`). Removing it deletes your imported archive, media cache, and live cache. Backup shards are stored separately if you set up [`backup sync`](backup.md).
