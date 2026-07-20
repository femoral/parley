# Wiring session provenance from your harness

Read this when setting up a new orchestrating environment, or when tasks land without an `orchestrator_session_id` / clean provenance.

## Install a harness plugin (preferred)

Session provenance is **env-driven**, not model-reported (ADR-0013). Install the parley harness plugin for your orchestrator:

- Packages live as `@useparley/plugin-<vendor>` (e.g. Claude Code, Codex, Grok Build).
- Install via that harness's own plugin/hook path — not via `parley`.
- At session start the plugin exports:

  - `PARLEY_SESSION_ID`
  - `PARLEY_HARNESS` (parley vendor id: `claude`, `codex`, `grok`, `pi`, …)
  - `PARLEY_MODEL`
  - `PARLEY_EFFORT`

Then register once (and re-anchor after crash/restart):

```
parley session
# re-anchor a known id (or rely on PARLEY_SESSION_ID from the plugin):
parley session -s <id>
```

No flags for harness/model/effort — those come only from the env vars above. Missing values register as honest **unknown** (null), never guessed. The printed session id is what later `delegate` / `watch` / `answer` / `fix` calls bind to when `PARLEY_SESSION_ID` is not already in the environment.

## Identity for the orchestrator session

Every `delegate` / `watch` / `answer` / `fix` call needs a session id. Resolution is **env-first**:

`PARLEY_SESSION_ID` > `--session <id>` > process-ancestry binding to a registered session

- **When evaluation is on** (see `parley info`): register with `parley session` first so spawn/eval can snapshot harness+model+effort. Unknown provenance still evaluates; metrics group it under an explicit `unknown` bucket so it cannot contaminate per-harness/model/effort comparisons.
- **When evaluation is off**: you can still register for clean provenance, or pass any stable free-form id via `PARLEY_SESSION_ID` / `--session`.

## Without a plugin

If your harness has no parley plugin yet:

1. Prefer installing one when available (separate per-vendor issues under the #181 umbrella).
2. Until then, you may export `PARLEY_SESSION_ID` yourself (any stable id for the run) and run `parley session` so the daemon has an anchor. Leave `PARLEY_HARNESS` / `PARLEY_MODEL` / `PARLEY_EFFORT` unset — do **not** self-report model or effort; nulls are correct.

The recorded `orchestrator_session_id` (visible in `status --json`) is distinct from the vendor child's own resume `session_id` in the same envelope.
