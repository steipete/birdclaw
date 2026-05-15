# CHANGELOG

## Unreleased

### Fixed

- Keep the selected DM conversation visible while its thread refreshes so the reply composer no longer flashes away mid-action.
- Send the selected web account through manual sync controls so multi-account timelines sync the intended profile.
- Run web sync requests as background jobs with status polling so the UI no longer holds one blocking sync request open.
- Add typed web API fetch handling and explicit DMs loading/error/empty states so failed local reads surface cleanly.
- Add explicit web app sync controls for home timeline, mentions, likes, bookmarks, and DMs so fresh live data can be pulled without leaving the UI.
- Refine the web app sidebar tagline and theme selector so the brand chrome reads more clearly in compact layouts.
- Add shared web feed loading/error/empty states with timeline-shaped skeleton rows and move conversation expansion into a cached single-thread surface with hover prefetch.
- Use the Birdclaw crab-bird mark in the web app chrome, loading states, and empty states; soften dark-mode contrast and replace text-only reply warnings with conversation/replied indicators.
- Allow the local web app to respond when Tailscale Serve forwards requests through the `clawmac.sheep-coho.ts.net` hostname.
- Speed up the default home timeline load on large local databases and keep malformed archived media URL entities from crashing the web timeline.
- Preserve tweet media aspect ratios, open timeline media in an inline viewer, and suppress duplicate media URL cards.

## 0.5.0 - 2026-05-15

### Added

- Add `birdclaw import archive --select` for importing targeted archive slices while preserving unselected local data.
- Add `birdclaw sync authored` for filling own-tweet gaps from `xurl` after the archive cutoff. Thanks @cavit99.
- Add live `sync mentions` and `sync mention-threads --mode xurl` ingestion for current mention data and conversation context. Thanks @cavit99.
- Add `birdclaw media fetch` plus archive bundled-media extraction and live media variant persistence for local originals caching. Thanks @cavit99.
- Add a `/links` web lane for Hacker News-style top URL and video-provider insights with today, week, month, year, and all-time ranges.
- Import archive `follower.js`/`following.js` files into the local follow graph and add archive-authored tweet edges so fresh archive imports are immediately queryable without live sync. Thanks @cavit99.
- Add cache-first followers/following sync, local follow graph queries, and backup/export support for graph snapshots and churn events. Thanks @ma08.
- Hydrate missing link-discussion profile avatars through `bird`/`xurl` so hover sheets can upgrade archive placeholders into real profile cards.
- Add inline tweet conversation expansion in the web timeline, preserving the selected reply's parent chain before broad thread context.

### Changed

- Update npm dependencies, including React, Vite, Vitest, Playwright, Tailwind, Kysely, TanStack packages, oxlint, and oxfmt.

### Fixed

- Seed demo link insight data before direct `/links` route loads, so the lane is populated even when it is the first web route opened.
- Isolate the default `bird` command config test from the maintainer's local `~/.birdclaw/config.json`.
- Skip non-numeric archive placeholder IDs such as self-DM conversation IDs when hydrating profiles through X, so one malformed local ID no longer aborts the batch. Thanks @nfarina.
- Include expanded short URLs and link occurrences in Git-friendly backups so linked-tweet search survives backup restore.
- Prefer `bird` for follow graph sync in `auto` mode, keeping `xurl` as an explicit fallback for accounts where OAuth2 follow reads work.
- Update the docs site and app icons to use the Birdclaw crab-bird mark instead of the generic bird logo.

## 0.4.1 - 2026-05-11

### Added

- Add a first-class short-link index for `t.co` URLs, including `links backfill` and `search links` so DM shares can be found through expanded tweet text, authors, dates, and media filters.

## 0.4.0 - 2026-05-09

### Added

- Preserve richer X profile metadata during `bird`/`xurl` profile hydration, including profile URLs, profile URL entities, locations, verification type, raw profile JSON, and X affiliation/highlighted-label metadata.
- Add first-class `profile_affiliations` storage, backup/export/import support, and `whois --json` `profileEvidence` so identity lookups can explain whether a match came from bio text, profile URLs, affiliation badges, DM context, or expanded links.
- Add profile-change snapshots for hydrated profiles, preserving prior bio/profile URL/location/verification/affiliation states so identity searches can surface current and previous affiliation evidence.
- Add first-class bio entity extraction for profile bios and profile URLs, including `@handle`, domain, and company-phrase evidence used by fuzzy identity searches such as `whois "blacksmith guy"`.
- Add a derived `identity_search_index` and `whois` filters for affiliation-oriented identity lookups: `--affiliation`, `--current-affiliation`, and `--exclude-domain-only`.

### Changed

- Use Node's native `node:sqlite` runtime instead of `better-sqlite3`, removing the native npm dependency while preserving the existing synchronous SQLite API surface.
- Allow Node 26.x in the package engine range and update install docs for the native SQLite runtime.
- Improve DM `whois` ranking with Sweetistics-style profile evidence scoring: profile URLs and affiliation badges now boost relevant candidates, while cached profile and URL lookups still avoid repeated API/network work.
- Resolve synthetic X highlighted-label organization badges into real local organization profile ids when `bird` can hydrate the org handle.
- Rank current affiliation and bio identity evidence above plain profile domains in `whois`, group human output into ambiguity buckets, and explain "why this person?" with the strongest typed evidence first.
- Use `bird profiles --json` for batch profile hydration when available, falling back to single-profile `bird user --profile-only --json`.

## 0.3.0 - 2026-05-05

### Added

- Add research mode for turning bookmarked Twitter threads into Markdown briefs, with shared `xurl`/`bird` tweet lookup fallback for thread expansion. Thanks @anupamchugh.
- Add live home timeline and mention-thread sync commands so local triage can pull current `bird` context into the SQLite store.
- Add search snippets for tweet and DM results, including deterministic DM snippets when multiple messages in a conversation match. Thanks @mvanhorn.
- Add `--min-likes` and `--quality-reason` controls for tweet search quality filtering. Thanks @mvanhorn.
- Store Twitter following counts on profiles and include them in JSONL backups.

### Changed

- Use the native TypeScript preview compiler for the `typecheck` script.
- Refresh TypeScript and related development dependencies.

### Fixed

- Use the existing Twitter web cookie fallback as the final `auto` transport for block and unblock actions. Thanks @pejmanjohn.
- Resolve the `bird` transport from `PATH` before falling back to the local development checkout. Thanks @vyctorbrzezowski.
- Stabilize the presenter timestamp test across local time zones. Thanks @pejmanjohn.
- Clean up the DMs route render test so CI does not leave React work running after jsdom teardown.
- Allow Playwright e2e runs to use an alternate local port when `3000` is already occupied.
- Replace maintainer-local documentation links with repo-relative links and align the setup docs with the Node version file. Thanks @stainlu.

## Unreleased

### Fixed

- Fix live `xurl` status detection when the CLI is installed but not authenticated; thanks @kyupark.
- Default local `bird` integration to `bird` on PATH and report stale configured command paths with setup guidance.

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
