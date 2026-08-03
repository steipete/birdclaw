# birdclaw 🪶 — Your Twitter history, with a longer memory

[![CI](https://img.shields.io/github/actions/workflow/status/steipete/birdclaw/ci.yml?branch=main&style=flat-square&label=ci)](https://github.com/steipete/birdclaw/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/birdclaw?style=flat-square)](https://registry.npmjs.org/birdclaw)
[![Node](https://img.shields.io/node/v/birdclaw?style=flat-square)](https://registry.npmjs.org/birdclaw)
[![License](https://img.shields.io/github/license/steipete/birdclaw?style=flat-square)](LICENSE)
[![Homebrew](https://img.shields.io/badge/homebrew-steipete%2Ftap-blue?style=flat-square)](https://github.com/steipete/homebrew-tap)
[![Docs](https://img.shields.io/badge/docs-birdclaw.sh-blue?style=flat-square)](https://birdclaw.sh)

Birdclaw imports Twitter/X archives into local SQLite, adds explicit cached live reads, and exposes the result through a web app, CLI, and optional read-only MCP server. It is for people who want their own searchable history, DMs, saved posts, and follow graph without a cloud backend.

![Birdclaw's local Home timeline populated with demo data](docs/birdclaw-app.png)

## Install

Homebrew is the shortest path on macOS and Linux:

```bash
brew install steipete/tap/birdclaw
```

The package is also published on npm:

```bash
npm install -g birdclaw
```

The npm and source installs require Node.js `>=26.5.1 <27`. See the [installation guide](https://birdclaw.sh/install.html) for pnpm, source builds, updates, and optional live transports.

## Quick start

Create a self-contained demo, search it locally, then open the web app:

```bash
birdclaw init --demo
birdclaw search tweets "local-first" --limit 3 --json
birdclaw serve
```

Open <http://localhost:3000>. The demo seeds sample tweets, DMs, profiles, and links without credentials or network requests.

## Use your archive

A Twitter/X archive establishes the account identity for a new real database and imports tweets, DMs, likes, bookmarks, profiles, media, and follow edges:

```bash
birdclaw import archive ~/Downloads/twitter-archive.zip --json
```

Imports are idempotent and merge destination-only rows by default. Selected re-imports and exact replacement are documented in [Archive import](https://birdclaw.sh/archive.html).

Birdclaw stores its database, configuration, and media under `~/.birdclaw`. Set `BIRDCLAW_HOME` to use another root.

## Add live data

Archive and local search work without an X login. Live sync delegates to [`xurl`](https://github.com/xdevplatform/xurl) or an existing private `bird` installation and only runs when requested:

```bash
birdclaw sync timeline --limit 100 --refresh --json
birdclaw sync bookmarks --mode auto --limit 100 --refresh --json
```

Import an archive before the first live sync on a new database. The [sign-in guide](https://birdclaw.sh/auth.html) explains xurl setup and transport selection; the [sync guide](https://birdclaw.sh/sync.html) covers caching, pagination, and rate limits.

## Work locally

SQLite is the canonical store. Archive imports and live transports converge on the same tables, and FTS5 powers local tweet and DM search.

| Surface | What it provides | Guide |
| --- | --- | --- |
| Web app | Home, mentions, saved posts, DMs, inbox, moderation, and network views | [Quickstart](https://birdclaw.sh/quickstart.html) |
| CLI | Search, sync, moderation, research, JSON output, and scheduled jobs | [CLI reference](https://birdclaw.sh/cli.html) |
| Backup | Deterministic JSONL shards that round-trip through Git | [Backup](https://birdclaw.sh/backup.html) |
| MCP | Read-only cached tweet search and thread tools behind a dedicated token | [MCP server](https://birdclaw.sh/mcp.html) |

Local reads do not trigger network traffic by default. The web server listens on loopback, live writes can be disabled with `BIRDCLAW_DISABLE_LIVE_WRITES=1`, and the MCP endpoint remains off until its token and public URL are configured.

## Configuration

`~/.birdclaw/config.json` selects default accounts, transport preferences, mention sources, and backup behavior. Command flags override environment variables, which override the config file.

See [Configuration](https://birdclaw.sh/configuration.html) for the complete file and environment reference. Product boundaries live in [VISION.md](VISION.md), and storage and transport details live in [Data and architecture](https://birdclaw.sh/data-architecture.html).

## Development

```bash
fnm use
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
```

The CI workflow also runs coverage, the installed-package smoke test, and Playwright end-to-end tests.

## License

MIT. Created by [Peter Steinberger](https://github.com/steipete). Birdclaw is not affiliated with X Corp.
