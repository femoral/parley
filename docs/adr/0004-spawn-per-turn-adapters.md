# ADR-0004: Spawn-per-turn vendor adapters (code interface, thin event normalization)

**Status**: accepted · **Date**: 2026-07-09 · **Decided**: [#11](https://github.com/femoral/parley/issues/11)

## Context
Research surfaced a fork: spawn a child process per run (codex exec, grok -p -s) vs holding persistent protocol processes (grok ACP, codex app-server — experimental/undocumented). Q&A already rides MCP blocking; resume already rides vendor session resume.

## Decision
- Spawn-per-turn. Resume from `stalled` = respawn with the persisted vendor session id.
- Adapters are TypeScript modules implementing `VendorAdapter` (`prepare`/`resume` → `SpawnPlan`, `parseEvent`, `sessionId`). `SpawnPlan.files` absorbs the codex-flags vs grok-files asymmetry. Declarative manifests rejected — the asymmetry strains templating.
- Raw vendor JSONL is the stored record; normalization is a thin display/extraction layer (`message|command|file_change|error|session_meta`), unknown lines opaque.

## Consequences
- No long-lived protocol clients to babysit; uniform lifecycle across vendors.
- Mid-turn steering and mechanical approval-routing are off the table until a persistent-protocol adapter exists (future work).
- New vendors are additive: one module + research doc.
