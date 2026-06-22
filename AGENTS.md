# AGENTS.md — Birdclaw

## Stack

- TypeScript 6 + React 19 + TanStack Start (file-based router) + Vite 8
- Tailwind CSS 4 + `@tailwindcss/vite` plugin (not PostCSS)
- SQLite as canonical local truth (via `better-sqlite3` equivalent)
- Effect.ts as the primary programming model — pervasive across `src/lib`; plain `Promise` wrappers **only** at CLI/route/component boundaries
- pnpm workspace, Node >=25.8.1, no monorepo (single package)
- Testing: vitest 4 + jsdom + jest-dom matchers; Playwright for e2e

## Commands

| Task                                   | Command                                                  |
| -------------------------------------- | -------------------------------------------------------- |
| Full check (format + lint + typecheck) | `pnpm check`                                             |
| Format (write)                         | `pnpm format`                                            |
| Format (check only)                    | `pnpm format:check`                                      |
| Lint                                   | `pnpm lint` (uses **oxlint**, not eslint)                |
| Typecheck                              | `pnpm typecheck` (uses **tsgo --noEmit**, not tsc)       |
| Unit tests                             | `pnpm test`                                              |
| Coverage                               | `pnpm coverage`                                          |
| E2E tests                              | `pnpm e2e`                                               |
| Build                                  | `pnpm build`                                             |
| Run single test                        | `npx vitest run src/path/to/file.test.ts`                |
| Target individual test                 | `npx vitest run src/path/to/file.test.ts -t "test name"` |

Always run `pnpm check` after any TS/TSX changes. Run it **once** after all edits, not between files.

## Path aliases

Both `#/*` and `@/*` map to `src/*`. Use `#/*` in imports (preferred).

```
import { db } from "#/lib/db";
```

## Code style

- **Formatter**: oxfmt — tabs (width 2), printWidth 80, double quotes, trailing commas, semicolons
- Generated files excluded from formatting: `src/routeTree.gen.ts`, `src/styles.css`
- `verbatimModuleSyntax: true` — use `import type` for type-only imports
- `noUnusedLocals: true`, `noUnusedParameters: true` — unused imports/vars are errors
- `noUncheckedSideEffectImports: true` — side-effect imports must be explicit

## Architecture conventions

- SQLite is canonical; archive import and live transport converge on the same model
- **All new `src/lib` code must use Effect programs** with typed errors. Promise wrappers go only at CLI/route/component boundaries. Use `runEffectPromise` from `src/lib/effect-runtime.ts` for the Effect → Promise bridge.
- Route files under `src/routes/` follow TanStack Start file-based conventions; `__root.tsx` is the root layout
- API routes under `src/routes/api/` are TanStack Start API handlers (no separate server framework)
- `src/lib/` holds shared core logic (db, config, sync engines, backup, etc.)
- Generated file `src/routeTree.gen.ts` — never edit manually
- CLI entry: `src/cli.ts` (dev via `pnpm cli`) → built to `bin/birdclaw.mjs` → `dist/cli/`
- Effect pattern: export both `runThingEffect(): Effect.Effect<A, E>` and `runThing(): Promise<A>` (thin wrapper using `runEffectPromise`)

## Testing

- Test files: `src/**/*.test.{ts,tsx}`. Excluded from route tree by Vite config.
- Test setup at `src/test/setup.ts` sets `BIRDCLAW_DISABLE_LIVE_WRITES=1` and polyfills localStorage/sessionStorage in jsdom
- Coverage thresholds: lines 85%, functions 85%, branches 80%, statements 85%
- E2E tests in `playwright/` dir, serial workers only, separate `BIRDCLAW_HOME=.playwright-home`
- E2E test server started by `scripts/start-test-server.mjs` (sanitizes `NODE_OPTIONS`, sets `BIRDCLAW_E2E=1`)
- CI workflow: `.github/workflows/ci.yml` runs `pnpm check`, `pnpm coverage`, `pnpm build`, `pnpm e2e`

## Environment variables

| Variable                               | Purpose                                       |
| -------------------------------------- | --------------------------------------------- |
| `BIRDCLAW_HOME`                        | Override default `~/.birdclaw` root           |
| `BIRDCLAW_DISABLE_LIVE_WRITES`         | Prevents live X writes (set in tests/CI)      |
| `BIRDCLAW_DISABLE_LIVE_PROFILE_LOOKUP` | Prevents live profile fetches                 |
| `BIRDCLAW_LOCAL_WEB`                   | Enables local loopback web APIs without token |
| `BIRDCLAW_ALLOW_REMOTE_WEB`            | Allows remote web access                      |
| `BIRDCLAW_WEB_TOKEN`                   | App-level auth token for remote access        |
| `BIRDCLAW_ALLOWED_HOSTS`               | Additional Vite dev server allowed hosts      |

## Key quirks

- No auth layer — this is a local-only tool. Auth comes from `xurl`/`bird` CLI transport.
- `NODE_OPTIONS` is sanitized in all scripts to strip any inherited `--localstorage-file` flag
- `pnpm run dev` runs with `BIRDCLAW_LOCAL_WEB=1`; production uses `birdclaw serve`
- **Never explain how to run the app locally.** The mCode environment handles this.
- Route files that end in `.test.ts` or `.test.tsx` are ignored by the TanStack Start router
- Dependencies on `@typescript/native-preview` (tsgo) — typecheck uses native TypeScript compiler
- **Always place `<script>` tags in `<body>`, never in `<head>`.** Failing rules: (1) no `<script>` after `<HeadContent />` — TanStack Start manages `<head>` during SSR causing hydration mismatches. (2) `<script>` elements belong in `<body>` to avoid SSR serialization conflicts. Place blocking scripts (theme, preload) as the first child of `<body>`.
