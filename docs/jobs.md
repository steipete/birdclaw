---
title: Jobs
description: "Scheduler-friendly bookmark sync with launchd integration, audit logs, and lock files."
---

# Jobs

`birdclaw jobs` is the scheduler-friendly subset of sync: short defaults, JSONL audit logs, lock files to prevent overlap, and launchd installers for macOS.

## `jobs sync-account`

```bash
birdclaw accounts set-bird-profile --account acct_openclaw --profile-name work
birdclaw --json jobs sync-account --account acct_openclaw --limit 100 --max-pages 3 --refresh
```

What it does:

- refreshes home timeline, mentions, mention threads, likes, bookmarks, and DMs for one account
- uses `bird` for home, mentions, and mention threads; DMs need explicit `xurl` mode for accepted-message imports while the current `bird` CLI lacks DM support
- uses `bird` for likes and bookmarks when the account has a bird relay profile name
- stops bird home/collection paging once it reaches already-local rows, so steady-state runs avoid walking old pages repeatedly
- appends one JSONL audit entry per run to `~/.birdclaw/audit/account-sync.jsonl`
- records each step independently so one rate-limited surface does not hide the others
- runs backup auto-sync after the scheduled refresh when enabled

Install the LaunchAgent:

```bash
birdclaw --json jobs install-account-launchd --account acct_openclaw --program /opt/homebrew/bin/birdclaw --env-path ~/.config/bird/openclaw.env
```

The default interval is 1,800 seconds (30 minutes). Use `--steps timeline,mentions,dms` for a narrower job. `--env-path ~/.config/bird/openclaw.env` still works for process environment variables, but bird account selection comes from the account's stored relay profile name. Accounts without `bird_profile_name` cannot use bird-backed steps. `--allow-bird-account` is deprecated and no longer authorizes bird use by itself. DM steps require explicit xurl mode while bird lacks DM support.

## `jobs sync-bookmarks`

```bash
birdclaw --json jobs sync-bookmarks --mode auto --limit 100 --max-pages 5 --refresh
```

What it does:

- runs a live bookmark refresh with scheduler-friendly defaults
- appends one JSONL audit entry per run
- exits non-zero when the sync failed, so a scheduler can detect and retry
- uses `~/.birdclaw/locks/bookmarks-sync.lock` to skip overlapping runs (records `already-running` instead of crashing)

Audit entries include:

- host
- start / end timestamps and duration
- before / after bookmark counts
- transport source (`xurl` / `bird`)
- fetched count
- backup-sync result (when `backup.autoSync` is enabled)
- error message on failure

The default audit log path:

```text
~/.birdclaw/audit/bookmarks-sync.jsonl
```

Inspect recent runs:

```bash
tail -n 5 ~/.birdclaw/audit/bookmarks-sync.jsonl | jq .
```

After a successful refresh, the job runs the normal backup auto-sync path. If `~/.birdclaw/config.json` has `backup.autoSync` enabled, the changed local data is merged into the configured Git backup repo, committed, and pushed. The audit entry records that backup result so scheduled runs are inspectable later.

## `jobs install-bookmarks-launchd`

macOS only. Writes a LaunchAgent plist that runs `jobs sync-bookmarks` every 3 hours.

```bash
birdclaw --json jobs install-bookmarks-launchd --program /opt/homebrew/bin/birdclaw
```

What it writes:

- `~/Library/LaunchAgents/com.steipete.birdclaw.bookmarks-sync.plist`
- runs at load, then every 10,800 seconds (3 hours)
- writes audit log to `~/.birdclaw/audit/bookmarks-sync.jsonl`
- writes stdout/stderr to `~/.birdclaw/logs/bookmarks-sync.*.log`
- uses `launchctl load -w` unless `--no-load` is passed

Flags:

- `--program <path>` — absolute path to the `birdclaw` executable on this machine (Homebrew, npm global, or source build)
- `--env-path <path>` — source an export-only shell env file inside the scheduled process
- `--no-load` — write the plist but do not load it; useful when you want to inspect first
- `--all` — pass `--all` to the underlying sync, fetching every retrievable page each run (default caps at 5 pages)

### Env files for launchd

When a scheduled job needs environment variables, `launchd` does not see your interactive shell environment, so the process will fail unless you provide them. Bird itself is selected via the account's relay profile name; use the env file only for process-level variables the job still needs.

The recommended pattern:

```bash
mkdir -p ~/.config/bird
chmod 700 ~/.config/bird
cat > ~/.config/bird/env.sh <<'SH'
export TWITTER_RELAY_BASE_URL="https://relay.internal"
SH
chmod 600 ~/.config/bird/env.sh

birdclaw --json jobs install-bookmarks-launchd \
  --program /opt/homebrew/bin/birdclaw \
  --env-path ~/.config/bird/env.sh
```

The plist sources that file inside the scheduled process. Keep the file in your home directory with mode `0600`. It is never written into the plist itself.

## Useful checks

After install:

```bash
launchctl print gui/$(id -u)/com.steipete.birdclaw.bookmarks-sync
launchctl kickstart -k gui/$(id -u)/com.steipete.birdclaw.bookmarks-sync
tail -n 1 ~/.birdclaw/audit/bookmarks-sync.jsonl | jq .
```

`kickstart -k` re-runs the job immediately, which is the fastest way to confirm config work end-to-end.

## Uninstall

```bash
launchctl bootout gui/$(id -u)/com.steipete.birdclaw.bookmarks-sync
rm ~/Library/LaunchAgents/com.steipete.birdclaw.bookmarks-sync.plist
```

The audit log and lock file are kept by design — remove them by hand if you really want them gone.

## Linux scheduling

Linux is not yet a first-class target for `jobs install-*`. For now, run `jobs sync-bookmarks` from `cron` or a `systemd` user timer. The audit/lock semantics are platform-agnostic.

Example crontab:

```text
0 */3 * * * /usr/local/bin/birdclaw --json jobs sync-bookmarks --mode auto --max-pages 5 --refresh >> ~/.birdclaw/logs/cron.log 2>&1
```

## See also

- [Sync](sync.md) — manual sync flow with the same flags
- [Backup](backup.md) — the backup auto-sync path that runs after each scheduled bookmark refresh
- [Configuration](configuration.md) — `backup.autoSync` and `BIRDCLAW_BACKUP_AUTO_SYNC`
