# `@useparley/plugin-codex`

A Codex `SessionStart` plugin that records deterministic session provenance in
Parley's session-state file. It writes the Codex session ID, active model, and
Codex process PID to:

```text
~/.parley/vendors/codex/sessions/<session-id>/state.json
```

The hook does not wrap Codex, change `PATH`, edit shell configuration, or emit
model-visible context. Without the plugin installed and trusted, it does
nothing.

## Install

Add the Parley Codex marketplace, then install its `parley` entry:

```sh
codex plugin marketplace add useparley/parley
codex plugin add parley@useparley
```

Review and trust the plugin hooks when Codex prompts. Codex skips plugin hooks
until they have been explicitly trusted. Start a fresh Codex session after
installation.

During development, build the npm package and expose this directory through a
local Codex marketplace entry before running the same `codex plugin add`
command:

```sh
pnpm --filter @useparley/plugin-codex build
```

## Verify

In a fresh Codex session, run:

```sh
parley session
```

Then inspect the state file named by the current Codex session ID:

```sh
find "${PARLEY_HOME:-$HOME/.parley}/vendors/codex/sessions" -name state.json -type f -print
```

The file contains `harness: "codex"`, the Codex session ID and model from the
hook event, and the Codex process PID (the hook's parent process).

Codex's `SessionStart` input has no effort field, so effort is honestly `null`
for a fresh session. Codex rollout artifacts do record effective effort in
`turn_context` entries. On a later resume hook, the plugin uses the event's
session-keyed `transcript_path` to fill that value when available. It never
uses `config.toml` as a substitute for effective runtime state.

## Uninstall

```sh
codex plugin remove parley@useparley
```

Existing state files are harmless historical records and may be removed
separately if desired.
