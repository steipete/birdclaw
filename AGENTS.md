# AGENTS.md — Birdclaw

## Key quirk

- **Always place `<script>` tags in `<body>`, never in `<head>`.** Failing rules: (1) no `<script>` after `<HeadContent />` — TanStack Start manages `<head>` during SSR causing hydration mismatches. (2) `<script>` elements belong in `<body>` to avoid SSR serialization conflicts. Place blocking scripts (theme, preload) as the first child of `<body>`.
