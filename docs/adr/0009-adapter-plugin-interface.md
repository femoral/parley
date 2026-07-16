# ADR-0009: Public adapter plugin interface

**Status**: accepted · **Date**: 2026-07-16 · **Decided**: [#108](https://github.com/femoral/parley/issues/108)

## Context

Vendor adapters lived only inside `@useparley/daemon` (`adapters/types.ts`).
Third parties could not add a vendor without forking the daemon, and the
adapter contract was not a versioned public surface. ADR-0004 already chose
TypeScript modules over declarative manifests; the missing piece was packaging
and loading those modules from outside the monorepo.

## Decision

- **Public contract in `@useparley/core`**: `VendorAdapter`, `TaskSpec`,
  `SpawnPlan`, sandbox types, and related shapes move to
  `packages/core/src/adapter.ts` and export from the core package. The daemon
  path `adapters/types.ts` remains a re-export shim for deep-import
  compatibility (`@useparley/daemon/adapters/types.js`).
- **Plugin loading**: `vendors.<id>.plugin` in `~/.parley/parley.json` names a
  module (absolute path, `file:` URL, or bare package resolved from the parley
  home). The daemon loads it at **startup** via dynamic `import()`. The module
  must export `createAdapter(env): VendorAdapter` (named preferred; default
  accepted). The returned adapter's `id` must equal the config key.
- **Built-ins first, plugins may shadow**: registry wires fake/codex/grok, then
  plugins. Shadowing a built-in logs a warning. A failed plugin load is logged
  and skipped — the daemon stays up; delegating to that id fails as unknown
  vendor.
- **No hot-reload of plugin code**: changing a plugin module requires a daemon
  restart. Vendor args/env and profiles re-read per task (ADR-0010).

## Consequences

- Adapter authors depend on `@useparley/core` only for types and can ship
  plugins as packages installable under `~/.parley`.
- Adding a plugin is a config + install + restart step; misconfigured plugins
  cannot brick the daemon.
- Deep imports of daemon adapter types keep working; new code should import
  from `@useparley/core`.
