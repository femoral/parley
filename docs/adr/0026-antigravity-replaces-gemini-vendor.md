# ADR-0026: Antigravity replaces the gemini vendor id

**Status**: accepted · **Date**: 2026-08-02 · **Decided**: [#286](https://github.com/femoral/parley/issues/286)

## Context

Parley integrated Google's Gemini CLI as vendor id `gemini` (binary `gemini`,
#99). Product and research moved on: the headless surface is now the
**Antigravity CLI** (`agy`), documented in
`docs/research/antigravity-cli-automation.md` (#287). That surface includes a
real `agy models` listing with effort suffixes, structured `stream-json`
events, and OAuth-only auth under `~/.gemini` — none of which matched the
hand-maintained, effort-less gemini catalog.

Keeping the `gemini` id as an alias would freeze a wrong binary name, wrong
event shapes, and a false expectation that old configs still work. Operators
who still have `vendors.gemini` or `defaults.vendor: "gemini"` need a loud
break, not a silent remap.

## Decision

- **Vendor id is `antigravity`**; binary default is `agy`; override env is
  `PARLEY_ANTIGRAVITY_BIN`. The `gemini` adapter module, shipped-catalog key,
  and UI harness entry are **removed entirely**.
- **No alias, no auto-migration.** A config that names `gemini` fails fast
  with an error that names `antigravity` as the replacement
  (`retiredVendorMessage` on the delegate / fix / spawn paths). Operators
  update `vendors.gemini` → `vendors.antigravity` themselves.
- **Discovery upgrades from hand-maintained ids to a real probe.** The old
  gemini adapter omitted `listModels` (no enumeration command). Antigravity
  implements `listModels` via `agy models`, stripping only `-high`/`-medium`/
  `-low` into efforts and never synthesizing unlisted combos. On-disk
  `readModels` is omitted — settings store a display label, not a catalog.
- Implementation follows the research doc's §9 recommendation (stdio MCP
  bridge under a per-task `HOME`, success triple, posture refusals).

## Consequences

- Existing allowlists and profiles that still say `gemini` stop working until
  rewritten; the error text is the migration guide.
- Historical research `docs/research/gemini-cli-cli-automation.md` remains as
  a record of the retired surface; it is not a live adapter contract.
- UI faction coats, wizard skill defaults, and the README enforcement matrix
  track `antigravity` only.
- Credential materialisation under a private `HOME` requires careful file
  modes and git-excludes on `--cwd` tasks so OAuth tokens are never committed.
- Exclude entries appended for `--cwd` tasks are permanent and accumulate
  (deduped on respawn); a future real file at one of those repo paths would be
  silently ignored in that repo.
