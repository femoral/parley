# ADR-0014: Vendor model+effort allowlist, deny-by-default

**Status**: accepted · **Date**: 2026-07-20 · **Decided**: [#185](https://github.com/femoral/parley/issues/185)

## Context

Vendor config had no way to restrict which models/efforts a vendor may run;
`delegate -m/-e` passed through opaquely and the model catalog was advisory
only. Top-tier efforts (max/ultra-class) are token sinks that should never be
selectable unless the user deliberately enabled them. Profiles pin single
combos but restrict nothing.

## Decision

- **Allowlist on `VendorConfig`**: a map keyed by model id; each entry names
  its allowed efforts **explicitly** (nothing implied), may carry a *default*
  flag (the combo used when a delegate omits model/effort), and an optional
  free-text *hint* surfaced to orchestrators to guide model choice.
- **Deny until configured**: a vendor with no allowlist cannot be delegated
  to. Deliberate breaking change; the error points at the wizard/config
  remedy. The wizard's vendor stage writes the allowlist (pick combos, mark
  default, add hints).
- **Reject + suggest nearest**: an out-of-list combo fails fast — nothing
  spawns — listing allowed combos and suggesting the closest allowed one.
- **One choke point, all paths**: ad-hoc delegate flags, `fix` reattempts,
  and profile-supplied combos all validate against the allowlist. The model
  catalog stays advisory for discovery (wizard choices, nearest-combo
  suggestions); the allowlist is the authority.

## Consequences

- Existing setups break until an allowlist is written; wizard vendor setup
  becomes effectively mandatory per vendor.
- `parley info` should surface allowed combos, defaults, and hints so
  orchestrators choose without guessing.
- Profiles are being redesigned separately (#195: launch templating,
  tracking-only model/effort); until that lands they validate like any other
  path.

## Amendment — selected-model setup pre-fill (#284)

Some vendors (goose, openhands) ship an **empty** model catalog: they persist
only a current selection on disk, never an enumerable list. Under the
deny-by-default rule above those vendors were permanently undelegatable until
the operator typed a model id by hand.

`parley init` may now seed a **one-entry** allowlist from the operator CLI's
selected model when:

1. the vendor's advisory catalog is empty, and
2. `readSelectedModel()` returns a readable selection whose model (and
   optional effort) pass charset + length validation (`isSafeAllowlistToken`).

This is a deliberate posture change: for those empty-catalog vendors a
readable, validated vendor file becomes a sufficient source for the first
allowlist entry. It does **not** change the gate — the allowlist remains the
sole authority at spawn, and discovery still never feeds `models.json`.

**Default effort for injected entries.** When the inject path writes an entry
with an effort, that effort is both the sole allowed effort and the entry's
`default` marker. There is no catalog `default_effort` to consult; the vendor
file is the only source. Effort strings that fail token validation are
dropped (effort-less entry) rather than written.

**Rejection advisory.** When a spawn (or run-start preflight) is rejected for
`not_allowed` or `no_allowlist` and the CLI selection is readable and outside
the allowlist, the error message gains one advisory line naming that
selection. Semantics are unchanged: still fails fast, nothing spawns, same
exit code and allowed-combos / nearest-suggestion output.
