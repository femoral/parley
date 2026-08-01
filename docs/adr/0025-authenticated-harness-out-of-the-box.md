# ADR-0025: Authenticated harnesses work out of the box; home isolation is flags-only

**Status**: accepted · **Date**: 2026-08-01 · **Decided**: [#290](https://github.com/femoral/parley/issues/290)

## Context

The kimi adapter isolated a per-task `KIMI_CODE_HOME` and materialized a
minimal `config.toml` so the operator's `~/.kimi-code` "never bleeds in".
Live verification (#290) showed that config is unusable: kimi validates
`default_model` against `[models.*]` tables the generated file never contains,
and — because kimi's auth lives in provider tables of the operator's own
config, not in env — the isolation severed subscription auth entirely. A
logged-in operator could not delegate to kimi at all without hand-plumbing the
full `KIMI_MODEL_*` env family. codex and claude never had this problem: they
spawn against the operator's own home and isolate via flags, per-task files,
and env ("isolation is flags-only").

## Decision

- **A logged-in vendor CLI must be delegatable out of the box.** Per-task home
  isolation that severs the CLI from its auth material is not an acceptable
  trade — subscription auth is in scope for every adapter.
- **kimi follows the codex precedent**: no `KIMI_CODE_HOME` override on spawn,
  no generated per-task `config.toml`. Isolation is flags-only — model via
  `-m <namespaced-id>` (omitted when the task names none, so the operator's own
  default applies), MCP via the project-scoped `mcp.json`, effort via
  `KIMI_MODEL_THINKING_EFFORT`. The `KIMI_MODEL_*` family remains an optional
  operator-supplied override channel for API-key use, not the auth mechanism.
- The alternative — copying the operator's credentialed `[providers.*]` tables
  into throwaway per-task homes on every spawn — was rejected as a worse
  security posture than the bleed it avoids.

## Consequences

- Delegated kimi runs see the operator's own config (their `default_model`,
  settings) and write sessions into the operator's session store — the same
  bleed codex and claude already accept.
- Adapters may still keep per-task *state* directories (e.g. openclaw's) when
  they don't sever auth; the rule is about auth reachability, not a ban on
  per-task files.
- Discovery's operator-home rule (ADR-0014 posture, `resolveOperatorVendorHome`,
  #281) is unaffected: readers already target the operator home.
