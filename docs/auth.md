---
title: Sign in
description: "Connect birdclaw to X through xurl or bird, verify each tool, and choose the moderation write transport."
---

# Sign in

birdclaw keeps its database local. Archive import needs no X credentials. Live reads and writes are delegated to external CLIs:

- [`xurl`](https://github.com/xdevplatform/xurl) uses the official X API and your own developer app.
- [`bird`](https://github.com/steipete/bird) uses a selected relay profile through X's web API.

Install either tool or both. Transport selection is workflow-specific: sync commands expose `--mode`, while `auth use` only controls moderation writes such as block, unblock, mute, and unmute.

For bird, Birdclaw now stores a relay `profileName` per account and passes it to the CLI as `--profile-name` for account-scoped reads and writes. That keeps account identity in Birdclaw and transport identity in bird.

On a fresh Birdclaw database, import your X archive before the first live sync. Archive import replaces the bundled demo identity with your account identity. The current auth commands verify transports but do not bind a new database to the authenticated X account.

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

## Set up bird

Install bird, configure its relay profile, then verify the selected account:

```text
npm install -g @steipete/bird
bird whoami
```

bird uses the selected relay profile for auth. If you need to adjust how the relay profile is selected, see the bird CLI docs for `--profile-name` and related profile configuration.

Attach that relay profile to the Birdclaw account that should use it:

```text
birdclaw accounts set-bird-profile --account acct_primary --profile-name work
birdclaw accounts clear-bird-profile --account acct_primary
```

When `bird_profile_name` is set, account-scoped bird reads and writes pass it to `bird` as `--profile-name`. When it is unset, bird keeps using its own default profile/config.

## Verify xurl in birdclaw

```text
birdclaw auth status --json
```

`auth status` runs a coarse xurl status probe. It does not probe bird, prove that a specific X API request will succeed, or choose a transport for every command.

- `installed` reports whether the xurl executable exists.
- `availableTransport` is `xurl` when `xurl auth status` succeeds without a known unauthenticated message; otherwise it is `local`.
- `statusText` explains the detected state.
- `rawStatus` contains xurl's status output when available.

Use `xurl whoami` as the end-to-end authentication check. Run `xurl auth status` for detailed app/token state and `bird whoami` to verify bird independently.

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

Supported modes differ by command; use `birdclaw sync <command> --help`.

## Security

- xurl stores developer-app credentials and OAuth tokens under `~/.xurl`.
- bird relay profiles are transport config. Treat the configured profile name as account-scoped transport data, not as Birdclaw identity.
- Use archive-only mode when live access is unnecessary.
- Set `BIRDCLAW_DISABLE_LIVE_WRITES=1` for development or dry runs.

For multiple Birdclaw accounts, use `--account <id>` on commands that support it. See [Configuration](configuration.md#multi-account).
