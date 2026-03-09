# CHANGELOG

All notable changes to this project will be documented in this file.

## Unreleased

### Added

- Start a project changelog.
- Add X web cookie fallback for block and unblock actions when the X API rejects OAuth2 block writes.

### Fixed

- Capture `xurl` mutation error bodies so transport fallbacks can key off the real API failure.
- Make `birdclaw` block and unblock flows succeed remotely again on Peter's current auth setup.

### Docs

- Document block transport behavior and fallback path in the CLI/docs.
