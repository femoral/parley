# ADR-0026: Antigravity replaces the gemini vendor id

**Status**: accepted · **Date**: 2026-08-02 · **Decided**: [#286](https://github.com/femoral/parley/issues/286) (amended by [#298](https://github.com/femoral/parley/issues/298))

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
- **Child channel is `http`, not MCP** ([#298](https://github.com/femoral/parley/issues/298)).
  Research §3/§9 verified a per-task `HOME` + stdio MCP bridge (agy reads MCP
  config only from `$HOME/.gemini/config/mcp_config.json`). That recipe is
  **rejected for parley**: injecting a task-private MCP server under a private
  home requires copying the operator's OAuth token (and `installation_id`) into
  the task tree, and the alternative — writing the operator's global
  `mcp_config.json` — mutates operator config. Neither is acceptable. The
  daemon child REST surface (`POST /child/report`, `POST /child/ask`, ADR-0011)
  is taught by the engine preamble when the adapter declares `childChannel:
  "http"`; the engine already injects `PARLEY_HUB_URL` / `PARLEY_TASK_ID`. No
  MaterializedFiles, no `HOME` override, never write the operator's MCP config.
- **Spawn against the operator's real `~/.gemini`.** Auth and
  `--conversation` resume work natively. Concurrent tasks share the operator's
  conversation store — same posture as kimi/codex (ADR-0025). Success-detection
  triple, stream-json parsing, effort/model semantics, and posture refusals
  follow the research doc; only the home/MCP injection path is deliberately
  different.

## Consequences

- Existing allowlists and profiles that still say `gemini` stop working until
  rewritten; the error text is the migration guide.
- Historical research `docs/research/gemini-cli-cli-automation.md` remains as
  a record of the retired surface; it is not a live adapter contract.
- UI faction coats, wizard skill defaults, and the README enforcement matrix
  track `antigravity` only.
- Children report via curl/HTTP as taught in the protocol preamble; `sandbox=
  read-only` remains approximate (RO cannot reliably run curl, and without a
  private home we cannot inject `permissions.allow`).
- Engine materialization hardening (`MaterializedFile.mode`,
  `writeFileSync({mode})` + chmod, `.git/info/exclude` via commonGitDir)
  stays for other adapters that still materialize plumbing files; antigravity
  no longer uses it for credentials.
- Exclude entries appended for `--cwd` tasks are permanent and accumulate
  (deduped on respawn); a future real file at one of those repo paths would be
  silently ignored in that repo.
