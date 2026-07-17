---
title: Configuration
description: "birdclaw config files, env vars, transport precedence, and multi-account profiles."
---

# Configuration

birdclaw reads configuration from these layers:

1. **Command flags** — for example `--account`, `--mode`, and `--transport`.
2. **Environment variables** — global paths plus feature-specific overrides.
3. **User config** — `~/.birdclaw/config.json`, or the file selected by `BIRDCLAW_CONFIG`.

## Storage root

The default root is `~/.birdclaw`. It holds:

```text
~/.birdclaw/
  birdclaw.sqlite              # canonical local truth
  config.json                  # user config
  media/                       # original media cache
  media/thumbs/avatars/        # avatar cache
  audit/                       # JSONL audit logs (e.g. bookmarks-sync.jsonl)
  logs/                        # launchd stdout/stderr
  locks/                       # job lock files
```

Override the root for one process:

```bash
export BIRDCLAW_HOME=/path/to/custom/root
```

The Playwright test home is `.playwright-home` in the repo, which is why CI never touches the production root.

## Config file

`~/.birdclaw/config.json` controls live transport, scheduled jobs, mention sourcing, and backup auto-sync.

```json
{
	"accounts": {
		"default": "steipete"
	},
	"actions": {
		"transport": "auto"
	},
	"mentions": {
		"dataSource": "bird",
		"birdCommand": "/Users/steipete/Projects/bird/bird"
	},
	"backup": {
		"repoPath": "/Users/steipete/Projects/backup-birdclaw",
		"remote": "https://github.com/steipete/backup-birdclaw.git",
		"autoSync": true,
		"staleAfterSeconds": 900
	}
}
```

### `accounts.default`

Set a Birdclaw account username (with or without `@`) or stored account ID. Commands with an `--account` option use this value when the flag is omitted. An explicit `--account` always wins.

Selection is per operation. Birdclaw resolves the existing account row, routes xurl through that username for the command, then restores the process environment. It never creates an account, changes the database default, or binds a live credential to stored data.

### `actions.transport`

- `auto` — try `bird` first for block/unblock/mute, then fall back to verified `xurl`
- `bird` — force `bird`
- `xurl` — force `xurl`; verifies through `bird status` before mutating SQLite

Twitter still rejects pure OAuth2 block writes for many accounts, so `auto` is the safe default.

### `mentions.dataSource`

- `birdclaw` — local cache only
- `bird` — refresh through `bird mentions --json`, normalize, cache in SQLite
- `xurl` — refresh through `xurl mentions`, cache the response shape

`mentions.birdCommand` overrides the `bird` binary path when you want to point at a non-`PATH` build.

### `backup.*`

See [Backup](backup.md). When `autoSync` is enabled, read commands pull + merge from Git only when the last check is stale, and data-changing commands push back automatically. Set `BIRDCLAW_BACKUP_AUTO_SYNC=0` to disable for one process.

## Environment variables

| Variable                       | Purpose                                                                                                                                              |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BIRDCLAW_HOME`                | Override the storage root (`~/.birdclaw` by default)                                                                                                 |
| `BIRDCLAW_CONFIG`              | Read and write config at a non-default path                                                                                                          |
| `BIRDCLAW_ACTIONS_TRANSPORT`   | Override moderation action transport with `auto`, `xurl`, or `bird` for one process                                                                  |
| `BIRDCLAW_BIRD_COMMAND`        | Override the `bird` executable used by live Bird transports                                                                                          |
| `BIRDCLAW_BASH_COMMAND`        | Override the Git Bash executable used for Bird subprocess redirection on Windows                                                                     |
| `BIRDCLAW_HOST`                | Host interface for the production `birdclaw serve` listener; defaults to `127.0.0.1`                                                                 |
| `BIRDCLAW_PORT`                | Port for the production `birdclaw serve` listener; defaults to `3000`                                                                                |
| `BIRDCLAW_ALLOWED_HOSTS`       | Comma-separated extra hostnames accepted by the source `pnpm dev` server                                                                             |
| `BIRDCLAW_LOCAL_WEB`           | Internal local-server mode; production derives local access from the peer socket, while forwarded/proxied requests still require remote-token config |
| `BIRDCLAW_WEB_TOKEN`           | Optional app-level token for remote web API access; send as `x-birdclaw-token` or `birdclaw_token`                                                   |
| `BIRDCLAW_ALLOW_REMOTE_WEB`    | Set to `1` to allow remote access through a trusted private proxy                                                                                    |
| `BIRDCLAW_MCP_TOKEN`           | Dedicated 32+ byte bearer secret required by the read-only `/mcp` endpoint                                                                            |
| `BIRDCLAW_MCP_PUBLIC_URL`      | Exact public MCP URL, including `/mcp`; enables strict Host/Origin checks but does not terminate TLS                                                   |
| `BIRDCLAW_DISABLE_LIVE_WRITES` | Set to `1` to block any live mutation (used by tests and CI)                                                                                         |
| `BIRDCLAW_BACKUP_AUTO_SYNC`    | Set to `0` to disable auto-sync for one process                                                                                                      |
| `NO_COLOR`                     | Disable ANSI color in human output                                                                                                                   |
| `OPENAI_API_KEY`               | Enable inbox scoring and low-signal filtering                                                                                                        |
| `BIRDCLAW_OPENAI_MODEL`        | Override the model used for inbox scoring (default `gpt-5.2`)                                                                                        |
| `BIRDCLAW_OPENAI_BASE_URL`     | Point at an OpenAI-compatible server (e.g. Ollama `http://localhost:11434/v1`); takes precedence over the compatible `OPENAI_BASE_URL` fallback; default `https://api.openai.com/v1` |
| `BIRDCLAW_DEBUG`               | Set to any value to log OpenAI request URLs, statuses, and error bodies to stderr                                                                   |

`BIRDCLAW_DISABLE_LIVE_WRITES=1` is set automatically in CI and Playwright runs so test code can never publish a tweet, send a DM, or block an account.

## Multi-account

birdclaw was built around multiple accounts in a single shared database from day one. Pass `--account <username>` (or a stored account ID) on commands that support account selection, including moderation, profile hydration, profile reply inspection, mentions, DMs, live sync, and scheduled jobs.

```bash
birdclaw sync timeline --account steipete --mode xurl
birdclaw import hydrate-profiles --account @steipete
birdclaw compose post --account acct_primary "Ship it."
```

For a recurring choice, set `accounts.default` in `config.json`. Explicit flags remain reversible one-command overrides. xurl can select a named OAuth2 account; Bird has one active cookie identity, so Bird-backed operations verify that identity matches the selected Birdclaw account before reading or writing.

Per-account state — cursors, transport preferences, last-sync watermarks, OpenAI score caches — lives inside the same `birdclaw.sqlite`. There is no per-account directory tree.

## Transport selection

There is no single global transport order:

- Archive imports and local reads need no live transport.
- Sync commands select their source with `--mode`; supported modes and defaults vary by command.
- Mentions export resolves its data source separately.
- Moderation writes use command `--transport`, then `BIRDCLAW_ACTIONS_TRANSPORT`, then `actions.transport`, then `auto`.

For moderation, `auto` tries bird first and falls back to xurl. Persist that choice with `birdclaw auth use <auto|bird|xurl>`.

## Disabling live writes

For dry runs, demos, or development against a fresh archive:

```bash
export BIRDCLAW_DISABLE_LIVE_WRITES=1
birdclaw compose post "this will not actually post"
birdclaw blocks add @someone --account acct_primary
```

Both commands record the intent locally where applicable but skip every transport call. Tests and CI rely on this exact mechanism.
