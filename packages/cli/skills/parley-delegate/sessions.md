# Wiring session provenance from your harness

Read this when setting up a new orchestrating environment, or when tasks land without an `orchestrator_session_id` / clean provenance.

## Install a harness plugin (preferred)

Session provenance is **plugin-driven**, not model-reported (ADR-0013). Install the parley harness plugin for your orchestrator:

- Packages live as `@useparley/plugin-<vendor>` (e.g. Claude Code, Codex, Grok Build, Pi).
- Install via that harness's own plugin/hook path — not via `parley`.
- At session start the plugin supplies provenance via one of two channels:

  1. **Env vars (primary):**
     - `PARLEY_SESSION_ID`
     - `PARLEY_HARNESS` (parley vendor id: `claude`, `codex`, `grok`, `pi`, …)
     - `PARLEY_MODEL`
     - `PARLEY_EFFORT`
  2. **Session-state file (INTERIM fallback):** see below when the harness cannot inject env or lacks full metadata.

Then register once (and re-anchor after crash/restart):

```
parley session
# re-anchor a known id (or rely on PARLEY_SESSION_ID from the plugin):
parley session -s <id>
```

No flags for harness/model/effort — those come from the plugin (env or interim state file). Missing values register as honest **unknown** (null), never guessed. The printed session id is what later `delegate` / `watch` / `answer` / `fix` calls bind to when `PARLEY_SESSION_ID` is not already in the environment.

## Identity for the orchestrator session

Every `delegate` / `watch` / `answer` / `fix` call needs a session id. Resolution is **env-first**:

`PARLEY_SESSION_ID` > `--session <id>` > session-state file > process-ancestry binding to a registered session

Harness / model / effort resolution:

`PARLEY_HARNESS` / `PARLEY_MODEL` / `PARLEY_EFFORT` > session-state file > unknown (null)

- **When evaluation is on** (see `parley info`): register with `parley session` first so spawn/eval can snapshot harness+model+effort. Unknown provenance still evaluates; metrics group it under an explicit `unknown` bucket so it cannot contaminate per-harness/model/effort comparisons.
- **When evaluation is off**: you can still register for clean provenance, or pass any stable free-form id via `PARLEY_SESSION_ID` / `--session`.

## INTERIM: session-state file channel

Some harnesses expose a deterministic session-start hook but cannot set process env for tool subprocesses, or lack resolved model/effort on the hook envelope. Until those surfaces improve, a plugin may **write** a parley-owned state file that `parley` **reads** as a middle tier (ADR-0013 addendum).

**Path** (under `PARLEY_HOME` when set, else `~/.parley`):

```
~/.parley/vendors/<vendor>/sessions/<harness-session-id>/state.json
```

**Schema** (parley-owned; plugins translate harness records into this shape):

```json
{
  "harness": "claude",
  "harness_session_id": "<harness session id>",
  "model": "sonnet",
  "effort": "high",
  "pid": 12345,
  "started_at": "2026-07-20T12:00:00.000Z",
  "updated_at": "2026-07-20T12:05:00.000Z"
}
```

- `model` / `effort` may be `null` (honest unknown).
- `pid` is the harness process id; parley matches the file to a caller when that pid appears in the caller's process-ancestry chain (same anchor idea as session binding). Dead pids are ignored.
- Writes should be atomic (write-temp + rename). Shared helpers: `@useparley/core` (`writeSessionState` / `readSessionState` / `sessionStatePath`).

This channel is explicitly **interim** until harnesses can fully inject the four env vars. Env remains the primary contract; the state file is a delivery fallback, not a replacement.

## Without a plugin

If your harness has no parley plugin yet:

1. Prefer installing one when available (separate per-vendor issues under the #181 umbrella).
2. Until then, you may export `PARLEY_SESSION_ID` yourself (any stable id for the run) and run `parley session` so the daemon has an anchor. Leave `PARLEY_HARNESS` / `PARLEY_MODEL` / `PARLEY_EFFORT` unset — do **not** self-report model or effort; nulls are correct.

The recorded `orchestrator_session_id` (visible in `status --json`) is distinct from the vendor child's own resume `session_id` in the same envelope.
