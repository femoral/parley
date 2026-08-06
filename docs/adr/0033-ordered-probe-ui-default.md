# ADR-0033: Ordered-probe UI default (console, then Cove)

**Status**: accepted · **Date**: 2026-08-06 · **Decided**: [#340](https://github.com/femoral/parley/issues/340) (implementation [#348](https://github.com/femoral/parley/issues/348), map [#337](https://github.com/femoral/parley/issues/337))

## Context

The daemon discovers an optional static UI bundle via the `parley.ui` package
marker and serves it at `/` (`packages/daemon/src/ui.ts`). Discovery was a
three-tier chain: explicit `config.ui.path` → `config.ui.package` → a single
default package name (`DEFAULT_UI_PACKAGE = "@useparley/ui"`, Parley Cove).

Parley Console (`@useparley/dashboard`) is a second first-party UI. Both UIs
remain optional installs — neither is a dependency of the daemon. Operators
need Console to become the config-less default when it is installed, without
breaking existing Cove-only installs that set no `config.ui`.

## Decision

**Mechanism: ordered config-less probe** (default-order flip from #340).

Replace the single default package with an ordered list. Full discovery order
(first hit wins):

1. Explicit `config.ui.path` (absolute or relative to `$PARLEY_HOME`)
2. Explicit `config.ui.package` (one package name)
3. `@useparley/dashboard` (Console)
4. `@useparley/ui` (Cove)

First package with a usable non-empty `parley.ui` marker wins. Package
resolution still prefers the parley home dir, then the daemon package's own
location (sibling install).

### Stop rule (per name)

If a probed package **resolves** but is not a usable UI install — no usable
marker, a usable marker whose bundle dir has no `index.html` (unbuilt), or an
unparseable `package.json` — that is a configuration mistake for **that
package name**: stop. Do not try other bases for the same name, and do not
fall through to the next default. Only **not found** advances the default
probe to the next name. The daemon logs one startup line naming the package,
the reason, and the path it inspected (#361).

### Choosing Cove deliberately

Already supported: `config.ui.package = "@useparley/ui"`. No new config
surface. Explicit path / package always beat the defaults.

### Install and publish posture

- Both packages stay optional; fresh installs still need one extra
  `npm install -g` for a UI.
- Onboarding leads with `@useparley/dashboard` as *the* UI install and lists
  Cove as the alternate register (docs/README follow in sibling work).
- `packages/dashboard` mirrors `packages/ui`'s shape: `parley.ui` marker,
  `files` shipping only the built bundle, public `publishConfig`. Versions
  stay independent of the daemon.

## Consequences

- Cove-only installs with no `config.ui` keep serving Cove (no regression).
- When both packages are present and config is unset, Console wins — that is
  what "default" means here.
- A broken (marker-less) Console install does **not** silently fall back to
  Cove; operators fix or remove the broken package, or pin Cove explicitly.
- Root `docs/adr/` records this as a system-wide decision (context-isolation:
  root ADRs are not package-scoped).
