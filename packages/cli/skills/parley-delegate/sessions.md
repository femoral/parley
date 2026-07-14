# Wiring `PARLEY_SESSION_ID` to your harness

Read this when setting up a new orchestrating environment, or when tasks are landing without an `orchestrator_session_id`.

Each orchestrating harness maps its own session concept onto `PARLEY_SESSION_ID`:

- **Claude Code**: the harness identifies each run with a session id — the `session_id` field it hands every hook (the same id that appears in the `claude.ai/code/session_…` links). Wire it once per run so every `parley delegate` you make inherits it: a `SessionStart` hook that exports `PARLEY_SESSION_ID` from that `session_id` (or, when you shell out delegate calls yourself, pass `--session "$CLAUDE_SESSION_ID"`). Then all the tasks a single Claude Code run spawns share one `orchestrator_session_id`.

Any harness without a native session concept can synthesize one (a uuid per run) and export it as `PARLEY_SESSION_ID` before its first delegate.

The recorded `orchestrator_session_id` (visible in `status --json`) is distinct from the vendor's own resume `session_id` in the same envelope.
