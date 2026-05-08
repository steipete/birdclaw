# Follow Graph

Birdclaw keeps followers/following in local SQLite and makes graph queries cache-only by default. Agents should use the `graph` commands for analysis and the `sync followers` / `sync following` commands only when a human intentionally refreshes data.

## Safety Contract

- `birdclaw graph *` commands never call X.
- `birdclaw sync followers` and `birdclaw sync following` default to dry-run.
- Live sync requires `--yes`.
- Fresh sync cache is reused unless `--refresh` is passed.
- The default follow-graph cache TTL is 24 hours.
- Capped syncs are recorded as incomplete snapshots and are not used for churn events.
- Complete snapshots are diffed into append-only `started` and `ended` events.

## Setup

```bash
birdclaw init
birdclaw auth status --json
```

The default account comes from the local Birdclaw account table. Pass `--account <accountId>` when working with a non-default account.

## Preflight Before Spending X Reads

Always run dry-run first:

```bash
birdclaw sync followers --json
birdclaw sync following --json
```

Dry-run output reports the cache key, whether a fresh cache exists, the page size, caps, and whether a live X request would be needed.

## Refresh Followers And Following

Full refresh:

```bash
birdclaw sync followers --yes --json
birdclaw sync following --yes --json
```

Capped refresh for cheaper inspection:

```bash
birdclaw sync followers --yes --max-pages 1 --allow-partial --json
birdclaw sync following --yes --max-pages 1 --allow-partial --json
```

Capped syncs are recorded as incomplete snapshots for audit, but they are not used to create churn events or update current edges. `--allow-partial` acknowledges that expected warning; it is not a persistence gate.

Repeat runs with the same account, page size, and caps reuse fresh cache:

```bash
birdclaw sync followers --yes --json
```

Force a new live fetch only when needed:

```bash
birdclaw sync followers --yes --refresh --json
```

## Agent Query Commands

After at least one complete follower and following snapshot, agents can query locally:

```bash
birdclaw graph summary --json
birdclaw graph events --since 2026-05-01 --json
birdclaw graph top-followers --limit 20 --json
birdclaw graph non-mutual-following --sort followers --limit 100 --json
birdclaw graph mutuals --json
birdclaw graph unfollowed --date 2026-05-01 --json
```

Recommended agent order:

1. Run `birdclaw graph summary --json`.
2. If counts are zero or snapshots are stale, ask for a human-approved `sync followers --yes` and `sync following --yes`.
3. Run only `graph` commands for analysis.
4. Do not pass `--refresh` unless the user explicitly asks to spend live reads.

## Stored Data

The follow graph uses:

- `follow_snapshots` for each sync attempt.
- `follow_snapshot_members` for users seen in each snapshot.
- `follow_edges` for current complete follower/following edges.
- `follow_events` for append-only `started` and `ended` edge changes.
- `profiles.public_metrics_json` and `profiles.followers_count` for local sorting.

Incomplete snapshots preserve what was fetched but do not update current edges or churn events. This prevents capped reads from being mistaken for unfollows.
