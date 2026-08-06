# @useparley/dashboard — isolation guard

This package is **Parley Console** (product register). It must never import from
`packages/ui` (@useparley/ui / Parley Cove) and Cove must never import from here.

The two-register wall is mechanical: ESLint `no-restricted-imports` bans both
directions. Full design-context text (PRODUCT.md, DESIGN.md, agent notes) lands
with the design-context move ticket; until then design source of truth is
`docs/design/parley-console/`.

Do not:

- Import code, CSS, tokens, or assets from `@useparley/ui` / `packages/ui`
- Copy Cove vocabulary, nautical chrome, or weathered materials into this package
- Add runtime CDN font loads — fonts are self-hosted under `public/fonts/`

Exception (shared product identity only): the pirate-skull brand mark file may
be the same asset as Cove's; code/CSS sharing is still forbidden.
