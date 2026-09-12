---
title: Media
description: "Local cache of pbs.twimg.com images and video.twimg.com mp4 variants; archive byte reuse before CDN."
---

# Media

`birdclaw media fetch` fills the local originals cache with image, video, and animated-GIF files for tweets that already live in the local SQLite store.

## Posture

This is a respectful client-rendering cache, not a scraper. The command:

- only fetches URLs that birdclaw already has from an archive or live sync record
- never enumerates, crawls, or derives `pbs.twimg.com` / `video.twimg.com` URLs
- skips files already present on disk
- streams response bodies to a `.tmp` file with `Range: bytes=<size>-` resume
- paces image requests sequentially by default, caps optional image parallelism at five, runs video downloads serially with their own pacing knob
- caps each file at `--max-bytes` (100MB default)
- backs off on `429 Too Many Requests`
- sends a `birdclaw/<version>` user agent

Thumbnail generation and automatic invocation from sync commands are intentionally out of scope. Run `media fetch` separately, for example on a cron loop every few hours.

## What gets fetched

For every tweet row whose `media_json` carries a media item:

- **images** from `pbs.twimg.com` under `/media/`, `/ext_tw_video_thumb/`, `/amplify_video_thumb/`, `/tweet_video_thumb/`, and `/profile_images/`
- **videos** from `video.twimg.com`, picking the highest-bitrate mp4 variant; HLS-only media is skipped
- **animated GIFs** from `video.twimg.com` (same path, separate counter)

`media_json` carries `variants[]` ride-along metadata for every video and animated GIF. [Live syncers](sync.md) — `sync likes`, `sync bookmarks`, `sync timeline`, and `sync mention-threads` — persist that variants array as part of normal sync so `media fetch` always has a URL to download from.

## Archive byte reuse

Before reaching for the CDN, `media fetch` looks for bytes already extracted by a previous archive import under `~/.birdclaw/media/originals/archive/tweets/<tweetId>/<tweetId>-<mediaKey><ext>`. When a match is found, the file is copied into the canonical originals path, counted as `reused_from_archive`, and CDN bandwidth is never spent.

This means a freshly imported archive (when bundled-media extraction is available) instantly populates the originals cache for every video and GIF in the archive — `media fetch` then only has to round-trip to the CDN for live-only tweets and anything missing from the archive.

## On-disk layout

```text
~/.birdclaw/media/originals/<media_key>.<ext>
```

`<media_key>` is the Twitter media key as it appears in `media_json`; `<ext>` is the canonical extension derived from the URL (`.jpg` for JPEG fallbacks, `.png`/`.webp`/`.gif` when the URL explicitly carries that format, `.mp4` for video and animated GIFs).

Archive-sourced files keep their original archive layout at `~/.birdclaw/media/originals/archive/<kind>/<id>/<filename>` until `media fetch` reuses them; the canonical originals path is the deduplicated, addressable view.

## CLI

```bash
birdclaw media fetch --json
birdclaw media fetch --dry-run --limit 20
birdclaw media fetch --include-video --video-pacing-ms 1500 --max-bytes 209715200 --json
birdclaw media fetch --no-include-video --parallel 3 --pacing-ms 250 --json
```

Flags:

- `--account <account-id>` — pick the account when multiple are configured
- `--limit <n>` — stop after N tweets processed
- `--kind <kind>` — restrict to one collection kind (e.g. `home`, `like`, `bookmark`, `mention`)
- `--since <isoDate>` — only consider tweets created at or after this date
- `--parallel <n>` — concurrent image workers, capped at 5 (default `1`)
- `--pacing-ms <n>` — delay between image request starts (default `250`)
- `--video-pacing-ms <n>` — separate delay between video request starts
- `--retry-max <n>` — retries per file after rate limiting (default `3`)
- `--include-video` / `--no-include-video` — videos and GIFs are on by default; pass `--no-include-video` for images only
- `--max-bytes <n>` — per-file size cap in bytes (default `104857600`, i.e. 100MB)
- `--dry-run` — list what would be fetched without downloading
- `--json` — stable machine-readable output

## JSON output

```json
{
  "ok": true,
  "fetched": 0,
  "images_fetched": 0,
  "videos_fetched": 0,
  "gifs_fetched": 0,
  "reused_from_archive": 0,
  "skipped_cached": 0,
  "failed": 0,
  "rate_limited": 0,
  "bytes": 0,
  "image_bytes": 0,
  "video_bytes": 0,
  "gif_bytes": 0,
  "duration_ms": 0,
  "failures": []
}
```

In `--dry-run` mode the envelope also carries `dry_run: true` and a `would_fetch[]` array of `{ media_key, tweet_id, kind, url, path }` rows.

`reused_from_archive` is the count of files copied from the archive originals cache rather than fetched from the CDN — track this on cron runs to confirm archive byte reuse is doing its job.

## Scheduling

`media fetch` is safe to run on its own schedule, independent of [sync](sync.md). The originals cache is the source of truth for "do I already have this file?", so repeated runs after saturation are cheap:

```bash
# every 6 hours, top up the originals cache without hammering CDNs
birdclaw media fetch --parallel 3 --pacing-ms 500 --video-pacing-ms 1500 --max-bytes 209715200 --json
```

## See also

- [Sync](sync.md) — live syncers that populate `media_json` with the variants payload `media fetch` consumes
- [Archive Import](archive.md) — where archive byte reuse comes from
- [CLI reference](cli.md#media-fetch) — canonical flag listing

## Avatars

All profile avatars, including the network map, first use the local `/api/avatar` cache. If that request fails,
the browser makes one fallback attempt to the stored HTTPS `pbs.twimg.com/profile_images/`
URL without a referrer. Both failures retain initials; arbitrary hosts, credential-bearing
URLs, and non-profile paths are never used for the fallback. This also lets a read-only
archive display a known avatar when its local image bytes were not copied.

Xurl tweet reads include referenced tweets and their authors, preserving repost and
quote author avatars in the normal sync response without separate profile lookups.

## Link preview thumbnails

External link-card images are served through `/api/link-preview?imageUrl=...`,
with public-address and redirect validation, an 8 MiB decoded-size limit, and
raster signature checks. The cache accepts JPEG, PNG, GIF, WebP, and AVIF;
HTML and SVG responses are rejected. Failed requests retain the card's placeholder.

Images are cached by URL (without fragments) under `media/thumbs/previews/`.
The cache evicts its oldest images before exceeding 256 MiB or 2,048 files. A read-only deployment
only serves existing files, so copy this directory alongside `media/thumbs/avatars/`
when preparing an archive. Normal interactive browsing fills missing files.
Hosting adapters that own separate durable media storage can implement the same
image endpoint without making the archive database writable.
