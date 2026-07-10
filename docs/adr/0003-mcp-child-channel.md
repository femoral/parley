# ADR-0003: Child↔orchestrator channel is a daemon-served HTTP MCP server

**Status**: accepted · **Date**: 2026-07-09 · **Decided**: [#4](https://github.com/femoral/parley/issues/4), tool surface refined in [#5](https://github.com/femoral/parley/issues/5)

## Context
Spawned agents (codex exec, grok -p) must report back and ask questions mid-task. Neither CLI supports injecting messages into a running headless session; both are MCP clients supporting streamable HTTP, configurable per-invocation (codex `-c` overrides; grok project `.grok/config.toml`).

## Decision
- The daemon serves a streamable-HTTP MCP endpoint; children connect to localhost. No per-child MCP processes. Task correlation via injected headers.
- Exactly two tools: `ask_orchestrator` (blocks until answered; timeout → question durably recorded, task `stalled`) and `submit_report` (schema-validated canonical outcome). `report_progress` rejected for v1: narration burns child tokens and anything pushed at the parent costs parent context; visibility comes from captured vendor logs.
- Codex's 60s MCP `tool_timeout_sec` raised past the answer timeout in the injected config.

## Consequences
- Vendor-neutral Q&A without persistent protocol clients.
- Blocking Q&A holds one-question-at-a-time by construction.
- Stdio-relay fallback kept as escape hatch; protocol must stay transport-agnostic.
