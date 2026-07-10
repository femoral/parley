# ADR-0002: CLI + global daemon, HTTP long-poll CLI plane behind a transport adapter

**Status**: accepted · **Date**: 2026-07-09 · **Decided**: [#5](https://github.com/femoral/parley/issues/5), [#9](https://github.com/femoral/parley/issues/9)

## Context
The orchestrator (Claude Code) shells out via its Bash tool — it cannot host a server. Delegated tasks outlive single CLI calls, so state must live in a process that survives them. Original idea was a websocket layer.

## Decision
- One global background daemon per user; auto-spawned on first `delegate`; ephemeral port published in `~/.parley/daemon.json` (pid-checked, lockfile-guarded).
- CLI ↔ daemon: REST + long-poll (`GET /tasks/:id/events?wait=true`) — blocking `--wait` maps directly onto it. Messages are transport-agnostic JSON behind a **transport adapter**; websocket can be added without protocol change.
- Task state in SQLite; raw vendor streams as per-task JSONL logs. Children die with the daemon; interrupted tasks become `stalled` and resume via persisted vendor session ids.

## Consequences
- curl-debuggable, no connection state, fits the Bash-tool model.
- Websocket deferred until a live-streaming consumer (TUI) exists.
- Daemon restart interrupts all repos' tasks — accepted for a personal tool.
