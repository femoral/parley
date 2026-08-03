# ADR-0027: Cursor vendor — opaque model ids, no effort axis

**Status**: accepted · **Date**: 2026-08-03 · **Decided**: [#300](https://github.com/femoral/parley/issues/300)

## Context

Parley gains a `cursor` vendor for the Cursor CLI (binary `cursor-agent`; the
installer also ships the collision-prone alias `agent`). The CLI is headless-
capable (`-p` / `--output-format stream-json` / `--resume <chatId>`), speaks
MCP with project-scoped config, and is genuinely multi-model — but its model
listing bakes *every* generation parameter into the id itself:
`gpt-5.3-codex-low`, `claude-opus-5-thinking-high`, `-fast` suffixes, `1M`
context variants, and irregular effort spellings (`gpt-5.5-extra-high` where
siblings use `xhigh`, plus `none`/`minimal`/`max` tiers). A quoted
parameterized override (`--model 'id[effort=high,fast=false]'`) exists but is
documented only for "parameterized models", with no way to enumerate which ids
accept it.

Parley's catalog and allowlist model a *model + effort* split (`ModelEntry.
efforts`, ADR-0014 combos, effort-bucketed eval). Mapping cursor onto that
split means either parsing an irregular, multi-dimensional suffix grammar
(effort × thinking × fast × context) that every new cursor model can break, or
trusting the parameterized syntax blind.

## Decision

- **Cursor model ids are opaque.** Each id from the probe is one `ModelEntry`
  with `efforts: []` and `default_effort: null`. `TaskSpec.model` passes to
  `--model` unchanged; a set `TaskSpec.effort` is ignored with a `PARLEY-DIAG`
  line, never rewritten into the id or the parameterized syntax. Allowlist
  combos for `vendors.cursor.models` are model-only.
- **Discovery is probe-only**: `listModels()` shells out to `--list-models`
  and parses the text listing (`<id> - <label>`), keeping `auto` and carrying
  annotations into label/notes. No `readModels`, no shipped-catalog entry, no
  `readSelectedModel`.
- The rest of the vendor shape follows existing precedent rather than new
  decisions: child channel `mcp` (project-scoped `.cursor/mcp.json` +
  `--approve-mcps`), flags-only spawn against the operator's `~/.cursor`
  (ADR-0025), and a permission-list posture map (`.cursor/cli.json` allow/deny
  + `--force`) declared `approximate` everywhere except `full` (ADR-0023).
  Details and build-time verification live in #300.

## Consequences

- Cursor tasks carry no effort provenance: eval buckets them by full model id
  only, and the effort column stays empty — like grok before hand-patching.
  Operators who want effort tiers pick them by choosing the suffixed id.
- The allowlist grows one entry per suffixed id the operator actually uses,
  rather than one model with an efforts list. Verbose, but every entry names
  something the vendor verifiably accepts.
- New cursor models appear on the next `parley models --refresh` with zero
  parsing risk; nothing breaks when Cursor invents another suffix dimension.
- Reversal is possible later (a family-parsing `listModels` could split ids
  into efforts), but existing allowlists and recorded task provenance written
  under opaque ids would need migration — decide once, here.
