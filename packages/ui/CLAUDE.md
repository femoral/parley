# @useparley/ui — Parley Cove

This package is **Parley Cove** (fun register). It must never import from
`packages/dashboard` (@useparley/dashboard / Parley Console) and Console must
never import from here.

The two-register wall is mechanical: ESLint `no-restricted-imports` bans both
directions.

## Design context (this package only)

Read these when doing Cove UI work:

- `PRODUCT.md` — register, users, positioning ("agent work you want to watch"),
  personality, anti-references, principles
- `DESIGN.md` — visual system (tokens, typography, components, chart-room)

Design ADRs for this package, if any, live under `docs/adr/` inside this package
(not root `docs/adr/`).

## Isolation

**Do not read** `packages/dashboard` design docs (`docs/design/PRODUCT.md`,
`docs/design/DESIGN.md`, the Console design export, or any Console design
context). Contamination of tone, vocabulary, or visual system across registers
is a defect.

Do not:

- Import code, CSS, tokens, or assets from `@useparley/dashboard` / `packages/dashboard`
- Copy Console instrument-panel chrome, density patterns, or UI-neutral telemetry
  vocabulary into this package as a substitute for Cove's own system

Exception (shared product identity only): the pirate-skull brand mark file may
be the same asset as Console's; code/CSS sharing is still forbidden.
