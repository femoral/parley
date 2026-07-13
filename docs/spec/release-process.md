# Release process

Decided on wayfinder map #47 (ticket #55). Companion to
`docs/spec/monorepo-layout.md`.

## Versioning

- **Fixed / lockstep**: all `@useparley/*` packages share one version and bump
  together — users reason about "parley 0.4", not four semvers. `workspace:^`
  internal ranges are always satisfiable at publish time.
- **Pre-1.0 stance**: standard 0.x semantics — breaking changes land in minor
  bumps (`0.MINOR`), patches are safe. The UI-contract stability promise
  (contract spec's "core major" rule) starts at 1.0; until then the contract
  may move in minors, noted in the changelog.

## Release flow

- **Manually triggered GitHub Action** (`workflow_dispatch`): a maintainer runs
  the Release workflow, choosing the bump (patch / minor / explicit version).
- The workflow: bumps every package to the same version, builds
  (`pnpm -r build`), runs the full gate (`test`, `typecheck`, `lint`),
  publishes all public packages (`pnpm -r publish` — pnpm rewrites
  `workspace:^` to real ranges), commits the bump, tags `vX.Y.Z`, and creates
  the GitHub release. `@useparley/ui` stays `private: true` and is skipped
  until the UI lands.
- No release-PR bot, no changesets — release cadence is a deliberate human
  action.

## npm auth

- **Trusted publishing (OIDC) + provenance**: the workflow authenticates to npm
  as a trusted publisher from GitHub Actions — no long-lived `NPM_TOKEN`
  secret — and publishes with provenance attestations.
- One-time setup per package on npmjs.com: configure the repo + workflow as the
  trusted publisher (first-ever publish of each name may need a manual local
  `npm publish` to create the package before trusted publishing can be
  attached — verify current npm behavior at execution time).

## Out of scope here

- CI test matrix on PRs (exists independently of releasing).
- Changelog automation — start with hand-written GitHub release notes.
