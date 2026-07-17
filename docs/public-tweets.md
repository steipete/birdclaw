---
title: Public Tweet Import
description: "Explicitly import individual public tweets through the fixed, read-only FxTwitter endpoint, with durable source provenance and third-party disclosure guidance."
---

# Public tweet import

Birdclaw can import individual public tweets through FxTwitter without X credentials. This transport is off by default and only runs when `--fxtwitter` is present on that invocation:

```bash
birdclaw import tweet 20 2030857479001960633 --fxtwitter --json
birdclaw import tweet https://x.com/jack/status/20 --fxtwitter --json
```

The input must be a numeric tweet ID or a canonical HTTPS `x.com/<handle>/status/<id>` or `twitter.com/<handle>/status/<id>` URL. Birdclaw extracts the numeric ID and requests only the hardcoded `https://api.fxtwitter.com/2/status/<id>` endpoint. There is no configuration, environment variable, or flag for a custom or self-hosted origin, and redirects are rejected.

## Privacy and disclosure

FxTwitter is a third-party service. Passing `--fxtwitter` sends each requested public tweet ID to `api.fxtwitter.com`. The service and its hosting/network providers can also observe ordinary request metadata such as your IP address, request time, and Birdclaw user agent. Do not use this transport if that disclosure is unacceptable.

Birdclaw does not send Twitter cookies, X API credentials, Birdclaw account data, DMs, local searches, or archive contents to FxTwitter. It does not automatically fall back to FxTwitter from another command. Every invocation requires the explicit flag.

## Read-only boundary

The FxTwitter transport exposes one capability: fetch a named public tweet by ID. It cannot search, enumerate timelines, fetch DMs or private account data, follow links returned by the service, or perform X writes. A single invocation accepts at most 20 tweet IDs and fetches them sequentially.

Imported tweets use the same canonical `tweets`, `profiles`, media metadata, and FTS rows as archive and authenticated live imports. Provenance is stored separately in `tweet_sources` with `source = 'fxtwitter'`, the fixed request URL, and observation time. Git-friendly backups preserve those markers in `data/tweet_sources.jsonl`.

Quoted public tweets included in the response are stored as reference context and receive their own FxTwitter provenance marker. Threads, conversations, profiles, timelines, search, follower lists, and arbitrary URLs are intentionally outside this transport.
