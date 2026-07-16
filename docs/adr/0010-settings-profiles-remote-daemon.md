# ADR-0010: Settings schema, agent profiles, and remote daemon

**Status**: accepted · **Date**: 2026-07-16 · **Decided**: [#112](https://github.com/femoral/parley/issues/112), [#113](https://github.com/femoral/parley/issues/113)

## Context

`~/.parley/parley.json` only carried UI bundle discovery. Operators needed
per-vendor binary/args/env overrides, named agent profiles (vendor + model +
posture defaults), and a way for the CLI to talk to a non-local daemon without
auto-spawn. Spawn customization also needed a contract so adapters splice
extra flags safely (flags region, never after an ambiguous positional prompt).

## Decision

- **Config sections** (validated with named errors, unknown keys
  ignored-but-preserved):
  - `daemon.url` — non-local daemon base URL.
  - `vendors.<id>.{bin,args,env,plugin}` — spawn overrides + plugin path.
  - `profiles.<name>.{vendor,model,effort,sandbox,network,args,env}` — named
    defaults; `vendor` required.
- **Profiles end-to-end**: `parley delegate --profile <name>` (vendor optional
  when profile is set). Daemon resolves: **explicit request > profile > ADR
  defaults**. Profile name persisted on the task row (`profile` column) and
  surfaced on `TaskRow` / `TaskEnvelope` / `parley list|status`.
- **Spawn customization**: `TaskSpec.extraArgs` (never undefined; default `[]`)
  carries `vendors.<id>.args` then `profiles.<name>.args`. Adapters MUST splice
  into the flags region. After `prepare`/`resume`, the engine applies
  `vendors.<id>.bin` → argv[0] and merges env as
  `plan.env < vendors.<id>.env < profile.env`.
- **Hot config for settings, cold for plugins**: re-read `parley.json` per
  task creation (and at spawn for args/env). Corrupt config fails the
  delegate request, not the daemon process. Plugin *modules* load only at
  daemon startup (ADR-0009).
- **Remote daemon**: when `daemon.url` is set, CLI `ensureDaemon` skips local
  discovery/spawn, probes `GET /health` on that URL, and routes all HTTP
  through it. Unreachable URL errors name the URL clearly.

## Consequences

- Operators customize vendors and name agent postures without code changes.
- Profiles compose with flags without surprising "defaults always win" from
  the CLI (sandbox/network are omitted unless the user set them).
- Remote/CI setups can point many CLIs at one daemon; local auto-spawn remains
  the default when `daemon.url` is unset.
