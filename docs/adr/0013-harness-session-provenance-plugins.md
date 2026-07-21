# ADR-0013: Harness plugins inject session provenance; env-only, no flags

**Status**: accepted · **Date**: 2026-07-20 · **Decided**: [#181](https://github.com/femoral/parley/issues/181)

## Context

Eval and traceability key off the orchestrator run's session id, model, and
effort. Today `PARLEY_SESSION_ID` relies on the orchestrating *model*
exporting it (via a hand-written hook or a synthesized uuid), and model/effort
reach parley only through `parley session -m/-e` flags — also model-supplied.
Models cannot reliably introspect their own session id, model name, or effort
level; the resulting eval data looks clean but can be silently wrong.

## Decision

- **Harness plugins, one per vendor**: a plugin installed into the
  orchestrator's harness via that harness's own native hook/plugin mechanism
  (Claude Code hook lifecycle, Codex `hooks.json`, Grok Build `.grok/plugins/`,
  …) exports session provenance deterministically at session start — no model
  involvement. This is harness-side tooling, distinct from daemon-side vendor
  adapters (ADR-0009).
- **Four env vars**: `PARLEY_SESSION_ID`, `PARLEY_HARNESS`, `PARLEY_MODEL`,
  `PARLEY_EFFORT`. `PARLEY_HARNESS` is new and identifies the harness running
  the orchestrator.
- **Env is the only source for harness/model/effort**: the `parley session`
  `-m/--model` and `-e/--effort` flags are **removed** (breaking change).
  Resolution is env > fallback (`null`/unknown). A missing plugin yields
  honest unknowns rather than model guesses.
- **Env-first for session id too**: `PARLEY_SESSION_ID` resolution flips to
  env > `--session` flag > ancestry binding (supersedes the #162 order).
  When the plugin is installed, parley — not the orchestrating model — owns
  the session identity; the flag remains only as a fallback for plugin-less
  environments.
- **`PARLEY_HARNESS` uses parley vendor ids** (the daemon vendor-registry
  vocabulary: `claude`, `codex`, `grok`, `pi`, …) so provenance joins cleanly
  against vendor config and eval grouping.
- **Packaging**: one npm package per vendor plugin
  (`@useparley/plugin-<vendor>`), living in the monorepo under
  `packages/plugins/<vendor>` — same release train, shared helper logic.
  Install docs point at each harness's own plugin-install path; installation
  is on the harness side, not via `parley`.
- **No pre-decided fallback for hook-less harnesses**: each vendor plugin
  starts with a research pass confirming the harness's deterministic
  session-start signal. If a harness truly exposes none, that finding goes
  back to the umbrella issue for a per-case decision (log-scrape vs.
  degraded-for-eval), rather than shipping a scrape hack by default.

## Consequences

- Eval provenance becomes deterministic where a plugin is installed and
  explicitly unknown where it isn't — no silent wrong data either way.
- Sessions with unknown provenance are still judged: eval runs normally and
  groups their results under an explicit *unknown* bucket, so they can never
  contaminate per-harness/model/effort comparisons.
- Removing `-m/-e` breaks existing `parley session` invocations; the
  delegation skill's "synthesize a uuid / write your own hook" guidance is
  superseded by "install the plugin for your harness".
- One umbrella issue (#181) tracks shared design; per-vendor child issues own
  each plugin.

## Addendum (2026-07-20): session-state file as interim delivery channel

The research passes (#191–#194) found that only **pi** can satisfy the
four-var env contract from its live hook surface. claude-code and codex expose
deterministic `SessionStart` hooks but lack a resolved-effort (and sometimes
model) field; grok's hooks cannot influence the session environment at all —
its passive-hook stdout is ignored and tool subprocesses inherit nothing.
Rather than leave those harnesses partial, the maintainer decided:

- **Plugin-written state file**: a plugin may persist provenance to
  `~/.parley/vendors/<vendor>/sessions/<harness-session-id>/state.json` — a
  **parley-owned schema** the plugin writes and parley reads. Each plugin
  translates its harness's internal session records (transcript, `summary.json`,
  rollout files, …) into this one stable shape, so harness-format churn stays
  inside the harness's own plugin and parley core never parses vendor
  internals.
- **Schema**: `{ harness, harness_session_id, model, effort, pid, started_at,
  updated_at }`. `model`/`effort` are nullable (honest unknown); `pid` is the
  harness process id so parley can match the file to a caller. Writes are
  atomic (write-temp + rename); later hook events may re-write the file as the
  harness's own records fill in (lazy completion) or values change
  (model/effort switch mid-session).
- **Resolution gains a middle tier**: env > **session-state file** > unknown
  (for harness/model/effort), and env > flag > state file > ancestry for the
  session id. Matching without env vars uses process ancestry: the caller's
  ancestry chain must contain the `pid` recorded in the state file — the same
  anchor mechanism session binding already uses.
- **Interim status**: this is explicitly a stopgap channel *until a better
  way exists* (e.g. harnesses growing complete hook metadata or env
  injection). The env vars remain the primary contract; the state file is a
  delivery fallback, not a replacement.
- This supersedes the blanket "no log-scrape" stance for the keyed case: a
  lookup keyed by the harness's own session id, translated by that harness's
  plugin, is deterministic in a way blind log scraping is not. Blind scraping
  (no session id, heuristic parsing in parley core) remains rejected.
