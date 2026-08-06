# ADR-0034: Per-package design context for UI registers

**Status**: accepted · **Date**: 2026-08-06 · **Decided**: [#339](https://github.com/femoral/parley/issues/339) (implementation [#351](https://github.com/femoral/parley/issues/351), map [#337](https://github.com/femoral/parley/issues/337))

## Context

Parley ships two optional first-party UIs with distinct product registers:

- **Parley Console** (`@useparley/dashboard`) — instrument panel; density and
  precision.
- **Parley Cove** (`@useparley/ui`) — chart-room cockpit; atmosphere and watchability.

Code isolation between them is already mechanical (`no-restricted-imports` both
directions). Design and tone isolation was not: Console design material lived
under root `docs/design/parley-console/`, Cove's `PRODUCT.md` / `DESIGN.md` sat
in `packages/ui/`, and root `CLAUDE.md` / `CONTEXT.md` pointed agents at one
register's docs. Agents working in one package could absorb the other's
vocabulary and visual system.

Root `docs/adr/` is the system-wide decision log (daemon, runs, protocol). The
repo already describes a multi-context pattern in `docs/agents/domain.md` —
package-scoped design decisions should not live there.

## Decision

### Per-package design ownership

Each UI package fully owns its design context:

| Artifact | Location |
| --- | --- |
| Strategic product doc | Package-local (`PRODUCT.md` at package root for Cove; `docs/design/PRODUCT.md` for Console) |
| Visual system | Package-local (`DESIGN.md` likewise) |
| Design export / mock | `packages/<pkg>/docs/design/` |
| Design-only ADRs | `packages/<pkg>/docs/adr/` when needed |

Root `docs/adr/` stays **system-wide only** (daemon, wire, runs, auth, this
structural scheme). Existing root ADRs that mention a UI product by name are
immutable history; they record product behavior, not a design register.

### Steering via nested CLAUDE.md

- `packages/dashboard/CLAUDE.md` and `packages/ui/CLAUDE.md` each name that
  package's design docs and state: **do not read** the sibling UI package's
  design docs.
- Nested CLAUDE files load automatically when work is under the package.
- Root `CLAUDE.md` Design Context is a **neutral dispatch table** only —
  references to both nested files, no tone words, no design-doc content.

### Shared living docs

Living shared docs (`CONTEXT.md`, etc.) use UI-neutral phrasing for domain
rules. They do not deep-link into either package's design register. Agents
follow the package `CLAUDE.md` for register-specific flavour and visual rules.

### Console export placement

`docs/design/parley-console/` moves to `packages/dashboard/docs/design/`. Root
`docs/design/` is removed. The frozen mock export (`*.dc.html`, `support.js`)
is a design artifact, not linted product code.

## Consequences

- Agents scoped to one UI package see only that package's design context by
  default; cross-register contamination is a process defect, not a surprise.
- Root agents (daemon/core/cli) are not handed either UI's design register.
- Package design ADRs can evolve without cluttering the system ADR series.
- This ADR itself lives at root because the scheme spans both UIs and repo
  layout.
