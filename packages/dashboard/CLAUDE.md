# @useparley/dashboard — Parley Console

This package is **Parley Console** (product register). It must never import from
`packages/ui` (@useparley/ui / Parley Cove) and Cove must never import from here.

The two-register wall is mechanical: ESLint `no-restricted-imports` bans both
directions.

## Design context (this package only)

Read these when doing Console UI work:

- `docs/design/PRODUCT.md` — register, users, positioning, principles, quality bar
- `docs/design/DESIGN.md` — visual system (tokens, type, layout, chrome)
- `docs/design/coverage-audit.md` — mock vs daemon surface matrix
- `docs/design/wire-verification.md` — invented mock elements vs wire
- `docs/design/Parley Console.dc.html` (+ `support.js`, `uploads/`) — frozen design export

Design ADRs for this package, if any, live under `docs/adr/` inside this package
(not root `docs/adr/`).

## Isolation

**Do not read** `packages/ui` design docs (`PRODUCT.md`, `DESIGN.md`, or any
Cove design context). Contamination of tone, vocabulary, or visual system across
registers is a defect.

Do not:

- Import code, CSS, tokens, or assets from `@useparley/ui` / `packages/ui`
- Copy Cove vocabulary, nautical chrome, or weathered materials into this package
- Add runtime CDN font loads — fonts are self-hosted under `public/fonts/`

Exception (shared product identity only): the pirate-skull brand mark file may
be the same asset as Cove's; code/CSS sharing is still forbidden.
