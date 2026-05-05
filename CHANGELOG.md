# CHANGELOG

All notable changes to this project will be documented in this file.

## Unreleased

### Added

- Add `--min-likes` and `--quality-reason` controls for tweet search quality filtering. Thanks @mvanhorn.

### Fixed

- Stabilize the presenter timestamp test across local time zones. Thanks @pejmanjohn.
- Replace maintainer-local documentation links with repo-relative links and align the setup docs with the Node version file. Thanks @stainlu.
- Resolve the `bird` transport from `PATH` before falling back to the local development checkout. Thanks @vyctorbrzezowski.
- Use the existing Twitter web cookie fallback as the final `auto` transport for block and unblock actions. Thanks @pejmanjohn.

## 0.2.1 - 2026-04-27

### Changed

- Use Twitter wording in public descriptions, docs, CLI help, and release notes.

## 0.2.0 - 2026-04-27

### Added

- Add live likes and bookmarks sync through `xurl`/`bird`, local search filters, archive import support, and dedicated Likes/Bookmarks web views.
- Add Git-friendly JSONL backup sync, export, import, validation, and stale-aware auto-sync for rebuilding or merging the local SQLite store from text shards across machines.
- Add a scheduled bookmark sync job with launchd installation, JSONL audit logging, overlap locking, and automatic Git backup sync after each refresh.
- Add launchd env-file support so scheduled bookmark sync can source `bird` credentials without storing secrets in the plist.

### Changed

- Update the README tagline and package description for local Twitter memory across archives, DMs, likes, bookmarks, and moderation.
- Refresh dependencies, including `jsdom` 29.1.0.
- Hide reply state and reply actions in saved likes/bookmarks web lanes.
- Shard backup DMs by year and route unknown tweet dates to `data/tweets/unknown.jsonl` so Git backups stay compact and avoid bogus 1970 files.
- Speed up archive imports plus JSONL backup export, import, and validation for large local datasets.

### Fixed

- Fix live bookmark sync to use stored Twitter user ids, force OAuth2 for `xurl` collection reads, and tolerate large/current `bird` bookmark payloads.
- Fix fresh-machine backup sync so demo data is never exported into Git backups, and keep no-op syncs from creating metadata-only commits.

## 0.1.1 - 2026-04-27

### Added

- Add opt-in low-quality timeline filtering for year-scale tweet review, including date windows, originals-only mode, and CLI/API flags for hiding retweets, tiny replies, and link-only noise.

### Fixed

- Fix fresh npm installs so the packaged `birdclaw` binary includes its TypeScript runtime dependency.

## 0.1.0 - 2026-04-27

### Added

- Add Twitter web cookie fallback for block and unblock actions when the Twitter API rejects OAuth2 block writes.
- Add `profiles replies` so moderation triage can inspect a user's recent reply pattern before blocking.
- Add `blocks import <path>` for one-shot blocklist application from a file.
- Add paged `mentions export --mode xurl --all --max-pages <n>` so moderation loops can scan the full retrievable mentions window.
- Add `actions.transport` config plus shared action transport routing for `bird`, `xurl`, and `auto`.
- Add transport-aware mute/unmute support to the API action route.
- Add the first packaged `birdclaw` CLI release.

### Fixed

- Capture `xurl` mutation error bodies so transport fallbacks can key off the real API failure.
- Make `birdclaw` block and unblock flows succeed remotely again on Peter's current auth setup.
- Verify forced `xurl` mute/block writes through `bird status` before mutating local sqlite.
- Cache authenticated `xurl whoami` lookups so repeated moderation writes do less redundant auth work.
- Strip inherited `--localstorage-file` from the Playwright web-server env to avoid noisy cross-repo test warnings.
- Override Node 25 native web storage in jsdom test setup so Vitest runs stop emitting `--localstorage-file` warnings.

### Docs

- Document block transport behavior and fallback path in the CLI/docs.
- Document the reply-pattern inspection flow for borderline AI/slop accounts.
- Document blocklist import file format and usage.
- Document paged xurl mention export for agent moderation runs.
- Document that mention reads and moderation writes use separate config knobs.
