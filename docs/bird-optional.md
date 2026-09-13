---
title: Bird optionality audit
description: "Transport coverage, regression checks, and deployment boundaries for running without Bird."
---

# Running without Bird: audit

Audited on 2026-09-13, starting from `368f569` (#209), with the follow-up fixes described below. Bird is optional across the CLI and web application. Ordinary live workflows require authenticated xurl; native `web` access supplies DM request operations using `AUTH_TOKEN` and `CT0`. Local archive workflows need neither transport.

## Findings corrected

Scheduled account sync could convert `auto` to explicit `bird` for home timelines when an account was supplied and Bird was allowed. That also affected an explicitly selected default account. It now preserves `auto` and its xurl fallback; `--allow-bird-account` permits Bird but does not select it.

The web DM sync button still disabled secondary accounts and omitted the account from its request. Manual and automatic DM sync now send the selected account to the existing account-verifying backend. The control waits for account data before enabling sync.

Native DM reads accepted truthy non-object inbox/page containers as empty successful responses. They now reject null, boolean, string, and array containers, allowing normal error reporting or eligible `auto` fallback. Documentation and the data-source panel also no longer claim DM requests require Bird.

## Surface inventory

The audit traced every production Bird import and subprocess caller through CLI registrars, web routes, jobs, provider selection, and local persistence. Legacy type names such as `BirdDmsResponse` and `syncDirectMessagesViaCachedBird` do not themselves execute Bird.

| Surface | Path without Bird | Boundary |
| --- | --- | --- |
| Init, archive import, backup import/export/sync, SQLite maintenance | Local files, SQLite, Git for Git backups | No X transport required |
| Search, show, inbox, lists, follow graph views, cached web pages | Local read models | No live refresh implied |
| Home, mentions, likes, bookmarks | xurl | `auto` retains optional fallback |
| Authored tweets | xurl | Official account-scoped API |
| Mention threads and research ancestors | xurl/shared tweet lookup | Local context is reused; explicit Bird remains available |
| Owned Lists and followers/following | xurl | `auto` may try Bird first; its absence falls through |
| Mention export | Local by default, or explicit xurl/auto | Saved `mentions.dataSource` can intentionally select Bird |
| Profile hydration, whois enrichment, affiliation lookup, profile replies | xurl and local/cache lookup | `--no-xurl-fallback` intentionally opts out of xurl enrichment |
| Discussion, profile analysis, Today/digest | Local/xurl context plus configured AI provider | AI access is a separate dependency |
| Accepted DM reads | xurl or native web | X's official API has history/access limits and no request-state contract |
| DM requests, accept/reject/block | Native web | Session cookies and matching account required |
| Compose post/reply/DM | xurl | Uses xurl independently of the moderation preference |
| Block/unblock/mute/unmute | xurl | Mutation response must confirm the expected boolean; no Bird verification required |
| Scheduled jobs | xurl for all account-sync steps; native DMs through eligible auto reads | Explicit non-default jobs without the Bird assertion use xurl; native request jobs can invoke `dms sync --mode web` directly |
| Web refresh | Same providers as CLI | DM jobs preserve account and inbox options |
| Server startup, data-source status, MCP | Local server and account-scoped archive reads | Missing optional CLIs must not prevent startup or local access |

## Configuration and proof

Explicit `--mode bird`, `--transport bird`, and saved Bird preferences remain intentional compatibility contracts. Check `mentions.dataSource`, `actions.transport`, `BIRDCLAW_MENTIONS_DATA_SOURCE`, `BIRDCLAW_ACTIONS_TRANSPORT`, and `BIRDCLAW_DIGEST_LIVE_MODE` when moving an existing installation. Use xurl overrides or remove obsolete Bird selections. `auth use xurl` changes moderation preference only.

The installed-package checks isolate HOME, configuration, and PATH. The ordinary live fixture supplies only a synthetic xurl executable; the native DM fixture supplies only synthetic fetch responses and cookies. Neither can reach a real account. The broader package smoke runs local commands, the production server, data-source status, and the official MCP client without either live CLI. Tests also cover explicit legacy behavior, identity mismatches, disabled writes, read-only deployments, mutation confirmation, malformed responses, cursor loops, and cache invalidation.

The regression cases were observed failing before their fixes. The browser regression uses a synthetic secondary account and an intercepted sync endpoint, checking the posted account ID as well as the enabled control. This is automated browser proof; it does not establish authenticated production X behavior.

## Deployment boundary

Removing Bird does not turn the application into a pure Cloudflare Worker. Birdclaw still uses a Node/Bun runtime, local SQLite/filesystem storage, xurl subprocesses, and Git for Git-backed backup. Native DM access itself needs no browser, cookie database, or Keychain reader. A container or VM can host the existing architecture; a Workers-only deployment needs a separate storage and transport port.

The native X endpoints are undocumented and may change. This audit verifies provider independence and synthetic success/failure behavior, not every live X entitlement or mutation. No real posts, DMs, or moderation actions are part of the audit, and it does not deploy or publish a release.
