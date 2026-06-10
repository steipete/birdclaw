# CHANGELOG

## 0.7.1 - Unreleased

### Added

- Add localized Today/digest reports through `--language <locale-id>`, `BIRDCLAW_DIGEST_LANGUAGE`, and the period-digest API, with canonical locale validation and separate caches. (#47 - thanks @yujiawei)

## 0.7.0 - 2026-06-01

### Added

- Stream live `birdclaw import archive` progress to stderr: per-slice parsing ticks (tweets, DMs, likes, bookmarks, follows, media) and chunked write-phase progress every 1,000 rows for profiles, tweets, likes+bookmarks, and DM messages. `--json` still keeps stdout clean for scripting.
- Add `birdclaw discuss <query>` and a Discuss web view for live keyword search via `bird`/`xurl`, persisted search-result tweets, and streaming OpenAI summaries with optional private DM context.
- Add `birdclaw profile-analyze <handle>` plus a Profile Analyse web view that backfills profile timelines and conversation context through `xurl`, caches the fetched context and AI result in SQLite, and exposes Analyse actions on tweet cards.
- Add canonical `/profiles/:handle` pages with profile headers and cached Profile Analyse output.
- Add a Rate Limits web view for observed `xurl` profile-analysis calls, 429s, local throttle settings, and documented X API recent-search windows.
- Add a Network Map web view for current followers/following, with SQLite geocode caching, OpenCage refreshes, Mapbox rendering, and a local fallback map.
- Render Network Map clusters as avatar stacks with relationship-weighted rings and avatar-rich profile/cluster overlays.
- Make the Network Map people list follow the current viewport with an in-view search panel.
- Add a Data Sources web view showing Birdclaw, bird, and xurl health, authenticated accounts, and automatic fallback order.
- Prefetch cached avatars for Discuss hover citations so source previews avoid fallback initials once profile metadata includes an avatar URL.
- Refresh Today digests from live `xurl` home timelines, mentions, and mention conversations before AI analysis so reports see more current context and reply parents.

### Changed

- Let Today and Discuss fetch much deeper live `xurl` data for the selected time window while keeping the AI prompt constrained to a large model-context budget.

### Fixed

- Add accurate archive-first Sign in and archive-request onboarding, including account-binding requirements, current xurl/bird setup, scoped transport selection, and clean autolink rendering. (#46 - thanks @peetzweg)
- Implement `birdclaw auth use <auto|bird|xurl>` so the documented command persists the preferred moderation action transport. (#45 - thanks @peetzweg)
- Keep `birdclaw init` alive when the macOS Downloads scan is blocked, falling back to the other archive discovery paths. (#44 - thanks @peetzweg)
- Show live Today fetch progress while Birdclaw pulls X home timeline, mentions, and reply context before the first AI tokens arrive.
- Include live fetch counts and page/thread progress in Today status messages before AI summary streaming begins.
- Recover live `xurl` sync when the valid OAuth token is stored under a different local xurl username label than the Birdclaw account handle.
- Keep Profile Analyse citation hover cards linked to real tweet/avatar sources, throttle `xurl` conversation searches, and retry 429s before continuing AI summaries with partial context.
- Open `/profiles/:handle` analysis streams immediately, use same-origin profile fetches, and let `BIRDCLAW_PROFILE_ANALYSIS_ACCOUNT` select the xurl account used for profile backfills.
- Keep Profile Analyse headers from slicing through loaded avatars/names and turn unresolved numeric tweet citations into safe X source links without leaking raw IDs.
- Group adjacent Profile Analyse tweet citations so cached AI reports show numbered source links instead of repeated generic `source` labels.
- Highlight hydrated Profile Analyse `@handle` mentions with profile previews and link multi-source citations to readable clauses when possible.
- Hydrate Profile Analyse header bio `@handle` mentions as soon as the profile context loads, so affiliation-style bios show profile hover previews.
- Flip tweet and profile hover previews above their trigger when there is not enough room below.
- Show expanded URLs instead of `t.co` shortlinks in tweet citation hover previews whenever tweet URL entities are available.
- Show expanded URLs instead of `t.co` shortlinks in Profile Analyse account bios when X description URL entities are available.
- Keep emoji-bearing profile bios and media tweets aligned with X entity ranges, and route `@handle` profile-preview links to internal `/profiles/:handle` analysis pages.
- Make Discuss search source/mode controls look like dropdowns in one row, raise live tweet search depth to 20,000 results / 200 pages, combine bird plus xurl in auto mode, and include matching local timeline/saved tweets in Live search discussions.
- Default Discuss live mode to xurl now that OAuth2 search is authorized.
- Use the default authorized xurl OAuth2 user for Discuss/Profile Analyse recent-search reads instead of the selected Birdclaw account handle.
- Keep Discuss/Profile Analyse recent-search reads from inheriting `BIRDCLAW_XURL_OAUTH2_*` overrides, so account-scoped xurl settings do not force stale app/user auth into global search calls.
- Let normal Discuss web searches reuse cached AI discussions while keeping the Refresh button as the explicit forced-refresh path.
- Keep Discuss Live search scoped to live/search-result tweets instead of sweeping every local timeline bucket before AI streaming starts.
- Link unresolved model-emitted `tweet_<id>` citations in AI reports to X source URLs instead of showing raw citation tokens.
- Tighten AI report line height and first-block spacing in Today and Discuss.
- Keep Network Map profile positions anchored to exact geocoded locations and render dense areas through smarter avatar clusters instead of random scatter.
- Ignore stale configured OAuth2 xurl account overrides for Profile Analyse user lookup and profile timeline reads.

## 0.6.0 - 2026-05-22

### Added

- Add `birdclaw dms sync/list --mode xurl|auto` for recent OAuth2 DM event imports through `xurl`, with bird fallback in auto mode.
- Add an explicit Messages sort toggle for newest conversations or sender follower count.
- Add web DM inbox controls for switching between all, accepted, and message-request conversations.
- Render the `What happened` AI digest as a structured day overview with summary cards, signal topics, highlight tweets, links, people, and hover previews for cited tweet ids and `@handle` mentions.
- Add a streaming `What happened` AI digest in the web UI and CLI (`birdclaw today`, `birdclaw digest`) backed by OpenAI Responses API, GPT-5.5 by default, medium reasoning, priority service tier, local context hashing, and cached final structured results.
- Add a global web account switcher plus `jobs sync-account`/`install-account-launchd` so multi-account Birdclaw installs can refresh home, mentions, likes, bookmarks, and DMs from launchd.

### Changed

- Stream the Today report as one longer Markdown brief with inline hoverable tweet citations instead of adding separate overview and action cards after the model finishes.
- Increase the default Today digest tweet context and accept larger web digest requests so 24-hour reports can see deeper into the local archive.
- Start the Effect rewrite by making `effect` a first-class runtime dependency and moving web API fetches, web sync orchestration, live command helpers, action transport, `bird`/`xurl` JSON/action transports and public adapters, backup export/import/validation and Git orchestration, moderation target resolution, blocks/mutes write helpers, remote block sync, batch blocklist imports, x-web mutations, authored/mentions/mention-thread sync including xurl recent-search and parent-walk fallback internals, conversation loading, home timeline, saved collection, DM live sync, profile hydration/resolution/affiliation/reply inspection, shared tweet lookup, research and whois report generation, follow graph live sync, link preview/index fetches, archive discovery/import subprocesses, avatar/URL caches, OpenAI/inbox scoring, scheduled bookmark sync locking/audit/launchd install, and media-fetch archive reuse/download concurrency onto Effect programs with Promise-compatible public wrappers.

### Fixed

- Deduplicate unscoped timeline rows across accounts so Home does not show the same tweet twice when multiple accounts saw it.
- Render model-emitted Markdown links even when the model inserts a space or line break between the link label and URL.
- Close Today tweet hover previews when opening their source links so command-clicked citations cannot leave stale preview cards stacked on later hovers.
- Keep the Messages shell aligned with the rest of the app while collapsing the sidebar labels, and label optional follower/score DM filters instead of showing default `0` fields.
- Link grouped AI digest tweet citations to nearby readable text instead of showing raw `tweet_...` IDs.
- Expand the Messages web layout into an icon-rail workspace so the DM list and thread panes no longer squeeze into the standard feed width.
- Show DM message requests across accounts instead of filtering them by the active sidebar account.
- Verify the live `bird` account before DM sync, preserve stable account IDs for sparse DM payloads, and pace request-page imports.
- Align DM profile stat labels and values consistently in the web detail panel.
- Keep outbound DM bubble text readable by separating inbound and outbound bubble color classes in the web UI.
- Link AI digest tweet citations on readable text instead of leaking raw `tweet_...` ids when the model cites a local tweet by prefixed id.
- Hydrate profile metadata for Today highlight tweets so real avatar images replace fallback initials after cached digest results render.
- Allow trusted private-proxy web deployments to stream the AI digest remotely without a token, while keeping app-level token enforcement when configured and surfacing API error details in the Today view.
- Harden web write/quota endpoints, URL/avatar fetching, backup imports, archive replacement imports, block sync pruning, and GitHub workflows based on a deepsec security pass.
- Validate compose, tweet-reply, and DM-reply writes before live transport, reject failed xurl sends without leaving local ghost entries, and keep failed web reply drafts visible with the transport error.
- Keep account-scoped manual sync buttons disabled until account metadata loads so saved timelines do not submit accountless collection syncs.
- Cancel failed link preview response bodies promptly so repeated broken preview fetches do not leave sockets open until timeout.
- Harden link preview metadata fetching against private-network redirects, DNS rebinding, oversized or compressed responses, and slow/broken multi-address hosts.
- Link raw `@handle` mentions in archived timeline text and render retweets as embedded original tweets with compact repost attribution.
- Remove the duplicate inline sync account picker now that the global web account switcher controls manual sync account state, and move the theme toggle out of the sidebar footer so the account switcher stays anchored at the bottom.
- Move the one-button theme toggle above the sidebar account picker so the bottom controls align with the active-account avatar.
- Hide unresolved `t.co` placeholders and duplicate preview cards on media tweets, and let single-image media render in a natural image-sized frame.
- Render reposts as native timeline rows with the original author avatar and a single compact repost attribution.
- Hide empty bookmark, media, and account metadata from timeline action rows so the footer only shows useful state.
- Move the theme toggle into the sidebar account footer row so it sits with the active-account controls.

## 0.5.1 - 2026-05-15

### Fixed

- Harden the published CLI wrapper and release checks so the packaged `birdclaw` binary avoids `tsx` CLI IPC startup and stays covered by lint, format, and smoke tests.
- Forward shutdown signals through the published CLI and bundled web server, and include referenced script helpers in npm packages.
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
