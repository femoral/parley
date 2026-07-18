# Wiring session id from your harness

Read this when setting up a new orchestrating environment, or when tasks land without an `orchestrator_session_id`.

## Identity for the orchestrator session

Every `delegate` / `watch` / `answer` / `fix` call needs a session id (`--session <id>` or `PARLEY_SESSION_ID`). That id groups the tasks you own in one orchestration run.

- **When evaluation is on** (see `parley info`): register first with `parley session -v <harness> -m <model> -e <effort>` (optional `-s <id>` to re-anchor). Use the printed id as `--session` / `PARLEY_SESSION_ID`. Self-report the harness, model, and effort you are actually running as.
- **When evaluation is off**: you can still register with `parley session` for clean provenance, or pass any stable id your harness already has.

## Mapping harness concepts

Each orchestrating harness maps its own session concept onto `PARLEY_SESSION_ID`:

- **Claude Code**: the harness identifies each run with a session id — the `session_id` field it hands every hook. Wire it once per run so every `parley` call inherits it: a `SessionStart` hook that exports `PARLEY_SESSION_ID` from that id (or pass `--session` when you shell out). When eval is on, also call `parley session … -s <that-id>` so provenance is registered.
- **Any harness without a native session concept**: synthesize a uuid per run and export it as `PARLEY_SESSION_ID` before the first delegate (and register with `parley session` when eval is on).

The recorded `orchestrator_session_id` (visible in `status --json`) is distinct from the vendor child's own resume `session_id` in the same envelope.
