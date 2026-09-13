---
title: Sign in
description: "Connect birdclaw to X through xurl or bird, verify each tool, and choose the moderation write transport."
---

# Sign in

birdclaw keeps its database local. Archive import needs no X credentials. Live reads and writes use these transports:

- [`xurl`](https://github.com/xdevplatform/xurl) is the recommended setup for new users and uses the official X API with your own developer app.
- Existing private `bird` installations remain supported for cookie-backed workflows and compatibility fallback.
- Native `web` access handles DM requests directly with session cookies, without either external CLI.

Install xurl for a new live-transport setup. Transport selection is workflow-specific: sync commands expose `--mode`, while `auth use` only controls moderation writes such as block, unblock, mute, and unmute.

On a fresh Birdclaw database, import your X archive before the first live sync. Archive import establishes your real account identity; `init --demo` creates only synthetic sample data. The current auth commands verify transports but do not bind a new database to the authenticated X account.

## Set up xurl

Install xurl, register an X developer app, then start OAuth2 authentication. Homebrew is available on macOS; npm and the upstream install script work on macOS and Linux:

```text
# macOS
brew install --cask xdevplatform/tap/xurl

# macOS or Linux
npm install -g @xdevplatform/xurl

xurl auth oauth2 --app my-app
xurl whoami
```

Alternatively, use xurl's [no-sudo install script](https://github.com/xdevplatform/xurl#installation). Register `my-app` first by following the [xurl authentication guide](https://github.com/xdevplatform/xurl#authentication). The redirect URI configured in the X developer portal must match xurl's configured URI. Treat the client secret as a secret; avoid entering it in shared shell history or exposing it in process listings.

## Existing bird installations

Birdclaw preserves compatibility with existing private bird installations, but bird is not a public setup path for new users. If bird is already installed and authenticated, verify the detected account:

```text
bird whoami
```

Existing bird configurations continue to provide cookie-backed fallback for supported reads and writes.

## Run without bird

An authenticated xurl installation is sufficient for archive search, normal feed
and accepted-DM synchronization, profile lookup, research, posting/replies, and
moderation. No browser, browser cookies, or bird executable is needed for these
workflows. Select xurl explicitly to avoid optional transport fallback:

```text
birdclaw auth use xurl
birdclaw sync timeline --mode xurl --refresh --json
birdclaw sync mentions --mode xurl --refresh --json
birdclaw sync mention-threads --mode xurl --json
birdclaw dms sync --mode xurl --refresh --json
```

Home and DM sync default to `auto`; mention-thread sync defaults to `xurl`.
Moderation verifies the `blocking` or `muting` boolean returned by X itself.
Malformed, missing, or contradictory confirmation is a failure, even when xurl
exits successfully; the mutation is never replayed just to obtain confirmation.

X's official DM API does not expose the message-request inbox or its accept/reject
state. Birdclaw's native `web` transport supplies these operations using your own
X session cookies, without a bird executable, browser process, or browser-cookie
database access. Configure `AUTH_TOKEN` and `CT0` through a secret manager or a
protected service environment; never pass cookie values as command arguments.

```text
birdclaw dms sync --mode web --inbox requests --limit 20 --refresh --json
birdclaw dms accept <conversation-id> --json
birdclaw dms reject <conversation-id> --json
birdclaw dms block <conversation-id> --json
```

Request actions default to `web`; `--mode bird` retains explicit legacy support.
The native transport verifies the authenticated account before reading or changing
DMs, rejects redirects, limits response sizes and pagination, and never retries a
mutation automatically. It discovers the current public X web-client bearer and
viewer query from X-owned assets; no bearer is embedded in the package. These are
undocumented web endpoints, so X changes or expired cookies can require attention.
The read-only deployment flag blocks this transport, and the live-write disable
flag blocks request actions.

## Verify xurl in birdclaw

```text
birdclaw auth status --json
```

`auth status` runs a coarse xurl status probe. It does not probe bird, prove that a specific X API request will succeed, or choose a transport for every command.

- `installed` reports whether the xurl executable exists.
- `availableTransport` is `xurl` when `xurl auth status` succeeds without a known unauthenticated message; otherwise it is `local`.
- `statusText` explains the detected state.
- `rawStatus` contains xurl's status output when available.

Use `xurl whoami` as the end-to-end authentication check. Run `xurl auth status` for detailed app/token state. Existing private bird users can run `bird whoami` to verify bird independently.

## Choose moderation transport

Persist the preferred transport for block, unblock, mute, and unmute:

```text
birdclaw auth use auto
birdclaw auth use bird
birdclaw auth use xurl
```

`auto` tries bird first for moderation writes, then xurl. A command-level `--transport` flag overrides the saved value. `BIRDCLAW_ACTIONS_TRANSPORT` overrides the config for one process.

Sync commands do not use this saved moderation setting. Select their source with the command's `--mode` flag:

```text
birdclaw sync timeline --mode auto
birdclaw sync mentions --mode bird
birdclaw sync likes --mode xurl
```

Select an existing Birdclaw account per operation with its username or stored ID:

```text
birdclaw sync timeline --account steipete --mode xurl
birdclaw import hydrate-profiles --account @steipete
birdclaw profiles replies @someone --account steipete
```

With xurl, Birdclaw routes that invocation to the matching named OAuth2 account. With Bird, Birdclaw cannot switch cookie jars itself and instead refuses the operation when `bird whoami` does not match. Put `{"accounts":{"default":"steipete"}}` in `config.json` to omit the repeated flag. This selects an existing row only; it does not change the database default or persist credential identity.

Supported modes differ by command; use `birdclaw sync <command> --help`.

## Security

- xurl stores developer-app credentials and OAuth tokens under `~/.xurl`.
- Native `web` and bird use browser session cookies. Treat `AUTH_TOKEN` (`auth_token`) and `CT0` (`ct0`) as full account credentials.
- Use archive-only mode when live access is unnecessary.
- Set `BIRDCLAW_DISABLE_LIVE_WRITES=1` for development or dry runs.

For multiple Birdclaw accounts, use `--account <username>` or a stored account ID on commands that support it. See [Configuration](configuration.md#multi-account).
