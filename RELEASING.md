# Releasing birdclaw

`.github/workflows/release.yml` owns publication to npm, GitHub Releases, and
`steipete/homebrew-tap`. Local publication is retired. Prepare the version in
`package.json` and a matching dated section in `CHANGELOG.md`, merge to protected
`main`, and wait for green push CI on that exact commit. With explicit release
authorization, push an annotated SSH-signed `vX.Y.Z` tag allowed by
`.github/release-allowed-signers`. Never move tags or republish versions.

Rehearse from Actions on `main` with `dry_run=true` (the default). The workflow
builds, packs, installs, smokes, and retains the exact tarball and checksums
without creating tags or publishing. Omit `version` to use the latest dated
section; it must match `package.json`. Dispatch cannot publish.

The npm job publishes those retained bytes using GitHub OIDC; no npm token is
used. The trusted publisher for `birdclaw` must name `steipete/birdclaw` and
`release.yml`. The GitHub Release contains the exact changelog section, tarball,
SHA-1/SHA-256 sidecars and SHA256SUMS. The explicit Homebrew handoff runs only
after npm and GitHub publication, using `HOMEBREW_TAP_TOKEN`.

The release uses the repository-pinned Bun canary and verifies the installed package under both Bun and Node before packing the final artifact.
