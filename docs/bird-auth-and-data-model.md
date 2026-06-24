---
title: Bird Auth and Data Model
description: "How birdclaw splits account identity, transport identity, sync data, and web actions."
---

# Bird Auth and Data Model

This note exists to keep the current bird-first work readable.

The short version:

- `accountId` is the Birdclaw identity.
- `bird profileName` is the relay identity used by `bird`.
- `external_user_id` links a Birdclaw account to an X user when the archive or live lookup can provide it.
- Cookies are not a Birdclaw data model. They are an implementation detail of older bird setups or external relay storage.

## The Two Identities

### Birdclaw account

Birdclaw keeps one local database with multiple accounts inside it. Every user-facing action that needs to choose *which account* it belongs to should start with `accounts.id`.

Use `accountId` for:

- timeline sync scopes
- mentions sync scopes
- moderation writes
- replies created from the web app
- per-account cursors, audit records, and local writes

### Bird relay profile

The current `bird` CLI works through a relay and accepts `--profile-name` or `BIRD_PROFILE_NAME`.

Use `profileName` for:

- selecting which relay-auth profile `bird` should use
- telling the relay which credential bucket to apply

Do not treat `profileName` as Birdclaw identity. It is transport configuration attached to an account.

## Dependency Chain

The clean flow is:

1. UI or job picks a Birdclaw account.
2. Birdclaw resolves that account to transport settings.
3. The bird adapter reads `profileName` for that account.
4. `bird` sends the request to the relay with `x-profile-name`.
5. The relay applies the right upstream auth state.

The code should not do this instead:

- infer the Birdclaw account from the bird profile
- persist cookies as account identity
- let web actions guess the account from global transport state

## Where Data Lives

### Local database

`birdclaw.sqlite` stores:

- accounts
- profiles
- timelines, mentions, DMs, likes, bookmarks
- per-account cursors and sync cache
- local action history

This database is the source of truth for what Birdclaw knows about your accounts.

### Transport configuration

Transport-specific settings belong outside the data tables unless they need to be shared across the app.

For bird, the relevant pieces are:

- relay base URL
- profile name

For xurl, the relevant pieces are:

- OAuth2 app / username selection
- authenticated user identity

## Web App Rules

The web app should keep using `accountId` as the selection mechanism.

Current behavior:

- timeline and mentions views resolve a selected account from local UI state
- inbox replies use the conversation's account
- action routes default to the selected or default account when the caller omits one

Important rule:

- the web app should not know how bird auth works
- it should only pass `accountId` into action and sync endpoints

## Sync Rules

Sync jobs should follow the same boundary:

- the job chooses an account
- the sync engine chooses a transport
- the bird adapter chooses `profileName`

This keeps account selection separate from transport selection.

For account-aware syncs:

- `accountId` decides which local data gets refreshed
- `profileName` decides which bird relay profile reads or writes that data

For unsupported surfaces:

- xurl remains the fallback when bird does not cover the surface
- DM send/read remains xurl-only for the current codebase

## What To Remember

If you only remember three rules, make them these:

1. `accountId` is the app boundary.
2. `profileName` is the bird boundary.
3. Cookies are not a Birdclaw boundary.

When those get mixed up, the code starts to look like it depends on auth state in places where it should only depend on account selection.
