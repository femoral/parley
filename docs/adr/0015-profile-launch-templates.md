# ADR-0015: Profile launch templates — custom argv, declared provenance

**Status**: accepted · **Date**: 2026-07-20 · **Decided**: [#195](https://github.com/femoral/parley/issues/195)

## Context

Profiles pin vendor/model/effort defaults and splice extra `args`/`env` into
the adapter-composed argv (#113). Users wanting granular control over how a
harness is launched — or wanting to run a tool parley has no adapter for —
had no path: the adapter owns argv composition (ADR-0004), and profile args
are only spliced extras.

## Decision

- **Opt-in template field**: a profile may set a launch template (a full argv
  array) that **replaces** adapter argv composition entirely for that
  profile. The existing spliced `args` behavior is untouched; a profile
  without a template behaves exactly as today.
- **Env-style expansion**: any `$VAR` in the template expands from the spawn
  plan's environment (which includes parley's own vars), shell-like, with the
  task prompt available as `$PROMPT`. No special closed vocabulary.
- **Parley keeps wrapping**: the template controls argv only. Parley still
  owns the workspace/worktree, sandbox and network posture, env merge,
  `.parley/` context materialization, and child-channel teaching (the HTTP
  child channel works regardless of harness, ADR-0011). Session resume is
  not composed for template profiles — reattempts use fresh composition.
- **Free-form vendor**: a template profile may declare a vendor id outside
  the adapter registry — any tool can be run as an agent. No adapter is
  involved; generic wrapping applies.
- **Declared, not verified**: everything a template profile states about
  itself (vendor, model, effort) is stored as *declared* provenance, kept for
  tracking but flagged unverified — distinct from plugin-verified provenance
  (ADR-0013) and exempt from the vendor model allowlist (ADR-0014), which
  gates only adapter-composed paths.
- **Hint**: profiles gain the same optional orchestrator-facing hint the
  allowlist entries carry, so orchestrators can decide when to use each
  profile.

## Consequences

- Users can launch harnesses however they please without forking an adapter;
  the adapter plugin interface (ADR-0009) remains the path for full
  integrations (resume, model catalogs, allowlists).
- Eval must treat declared provenance as its own class — never merged with
  plugin-verified values.
- A misauthored template fails at spawn, not at config load; validation can
  only check shape, not that the command actually runs an agent.
