---
title: Moderation
description: "Account-scoped blocks, mutes, bans, and bulk blocklist imports with bird relay/profile write fallback."
---

# Moderation

birdclaw maintains account-scoped block and mute lists locally. Every action records the local intent first, then attempts the live transport. If the live transport fails, the local row stays and a future re-sync reconciles.

All commands accept `--account <id>` to pick an account when more than one is configured.

## Blocks

```bash
birdclaw blocks list --account acct_primary --json
birdclaw blocks add @amelia --account acct_primary --json
birdclaw blocks remove @amelia --account acct_primary --json
birdclaw blocks record @amelia --account acct_primary --json
birdclaw blocks sync --account acct_primary --json
birdclaw blocks import ~/triage/blocklist.txt --account acct_primary --json
```

### `blocks add`

Add a local block entry and attempt a live block write.

Accepts a handle (`amelia`), `@handle`, Twitter URL, local profile id, or numeric Twitter user id.

Live transport order for `auto`:

1. `bird` — relay/profile-backed, verified with `bird whoami`.
2. `xurl` — used when `bird` fails and the selected account matches the authenticated xurl account.

When both live transports fail, the local block is not recorded. Use `blocks record` for a local-only row.

### `blocks remove`

Mirror of `blocks add`. Removes the local block and attempts a live unblock through the same transport ladder.

### `blocks record`

```bash
birdclaw blocks record @amelia --account acct_primary --json
```

Records a known-good remote block locally **without** issuing another live write. Useful when:

- a block was made on twitter.com directly and you want birdclaw to know about it
- a previous `blocks add` succeeded remotely but failed to update the local row

### `blocks sync`

Slow / manual remote reconciliation. Walks the live block list (when transport allows) and reconciles missing local rows. Not for hot cron loops.

### `blocks import`

Bulk import a blocklist file. Reads newline-delimited handles, IDs, or Twitter URLs.

```bash
birdclaw blocks import ~/triage/blocklist.txt --account acct_primary --json
```

Tolerates:

- blank lines
- `#` comments
- markdown bullets like `- @handle`
- Twitter URLs and numeric IDs

Example file:

```text
# crypto / AI slop
@jpctan
@SystemDaddyAi
- @Pepe202579 memecoin bait
https://x.com/someone/status/2030857479001960633?s=20
```

Per-entry success/failure shows up in the `--json` output so you can grep failures and retry.

## ban / unban (shorthand)

```bash
birdclaw ban @amelia --account acct_primary --transport auto --json
birdclaw unban @amelia --account acct_primary --transport bird --json
```

`ban` / `unban` are aliases for `blocks add` / `blocks remove` with one extra knob: `--transport`.

- `--transport auto` — try `bird` first, then verified `xurl`
- `--transport bird` — force `bird`
- `--transport xurl` — force `xurl`; verifies through `bird status` before mutating SQLite

## Mutes

```bash
birdclaw mutes list --account acct_primary --json
birdclaw mute @amelia --account acct_primary --transport xurl --json
birdclaw unmute @amelia --account acct_primary --transport auto --json
birdclaw mutes record @amelia --account acct_primary --json
```

Same model as blocks, with one resolution detail: `mute` and `unmute` prefer `bird user --json` for target resolution before falling back to `xurl /2/users`. This is faster and avoids burning an `xurl` user lookup for accounts you can already see in `bird`.

`mutes record` stores a known-good remote mute locally without issuing another live write.

## Auto-fallback in the wild

OAuth2 block writes are the most common failure case. Twitter intermittently rejects them with no recoverable error code. For that reason:

- `auto` is the default everywhere
- `auto` stops after the verified `xurl` fallback
- forced `xurl` writes still verify through `bird status` before sqlite changes
- failed live writes never leave the local DB in an inconsistent state — either the local row reflects the live state or it is rolled back

If your account chronically rejects OAuth2 blocks, just set:

```json
{
	"actions": {
		"transport": "auto"
	}
}
```

and stop thinking about it.

## Web UI

The `Blocks` lane shows the local list, lets you bulk-import from a file, and exposes per-account scoping. Mutes are surfaced inline on profile rows in the `Mentions` and `DMs` lanes — adding a mute from there feeds the same `mutes` table the CLI uses.

## See also

- [Configuration](configuration.md) — `actions.transport` precedence
- [Mentions](mentions.md#profile-reply-scan) — borderline-AI triage before blocking
- [Inbox](inbox.md) — low-signal heuristic scoring
