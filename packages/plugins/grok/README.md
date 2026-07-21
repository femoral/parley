# `@useparley/plugin-grok`

A [Grok Build](https://docs.x.ai/build/overview) plugin that records
deterministic Parley session provenance without model involvement.

Grok's passive hooks (including `SessionStart`) **cannot inject environment
variables into the session** — hook stdout is ignored. This plugin therefore
writes the interim **session-state file** channel (ADR-0013 addendum):

```
~/.parley/vendors/grok/sessions/<harness-session-id>/state.json
```

| Field | Source |
|-------|--------|
| `harness` | constant `grok` |
| `harness_session_id` | `GROK_SESSION_ID` (or stdin `sessionId`) |
| `pid` | Grok harness process (hook parent / PPID) |
| `model` | `null` at session start; lazy-filled from the session's `summary.json` `current_model_id` |
| `effort` | `null` at session start; lazy-filled from `summary.json` `reasoning_effort` |
| `started_at` / `updated_at` | ISO-8601 timestamps; `updated_at` bumps on later hook rewrites |

Later passive events (`UserPromptSubmit`, `Stop`) re-run the same hook so
model/effort fill in once Grok's own session artifacts have them. Missing or
malformed artifacts leave nulls — the hook never guesses and never crashes the
session (fail-open, 5s timeout).

Parley itself is the only reader of this file (see core session-state helpers
from #196). The plugin does **not** wrap the `grok` binary, edit shell rc, or
manipulate PATH.

## Install (user-scoped)

Prefer a **user-scoped, trusted** plugin install. Project `.grok/hooks/` need
folder trust and are the wrong scope for always-on provenance (verified Grok
Build 0.2.106 — see `docs/research/grok-build-cli-automation.md` §10.2).

From a clone of this monorepo (after building the package):

```sh
pnpm --filter @useparley/plugin-grok build
grok plugin install ./packages/plugins/grok --trust
grok plugin enable parley-provenance   # if not already active
```

Or from a git source once published on a ref:

```sh
grok plugin install femoral/parley#packages/plugins/grok --trust
grok plugin enable parley-provenance
```

`--trust` is required for hooks/MCP to run. Enabling loads the plugin;
trusting gates whether its hooks execute. Confirm with:

```sh
grok plugin list
grok plugin details parley-provenance
# or: grok inspect   # Hooks section should list SessionStart / UserPromptSubmit / Stop
```

> **Note:** install from a path that already contains `dist/hook.js` (run
> `pnpm --filter @useparley/plugin-grok build` first). The hook script is
> dependency-free at runtime: only Node and the bundled `dist/hook.js` are
> required — no `node_modules` resolution inside the hook process.

## Verify

Start a fresh Grok session (interactive or headless), let at least one turn
complete so `summary.json` can fill in model/effort, then inspect the state
file. Example smoke check:

```sh
# Headless one-shot (adjust cwd as needed)
grok -p "Reply with the single word ok." --always-approve --no-auto-update

# Find the newest state file for this user
ls -lt ~/.parley/vendors/grok/sessions/*/state.json | head
# Or, if you know the session id from GROK_SESSION_ID / -s:
# cat ~/.parley/vendors/grok/sessions/<session-id>/state.json
```

Expected shape (model/effort may still be `null` if the turn has not written
`summary.json` yet; re-check after a prompt or tool turn):

```json
{
  "harness": "grok",
  "harness_session_id": "<uuid>",
  "model": "grok-4.5",
  "effort": "high",
  "pid": 12345,
  "started_at": "2026-07-20T12:00:00.000Z",
  "updated_at": "2026-07-20T12:00:05.000Z"
}
```

`pid` must be the **Grok harness** process id (not the hook child). Without
this plugin installed, nothing under `~/.parley/vendors/grok/` is written.

## Uninstall

```sh
grok plugin uninstall parley-provenance
# aliases: grok plugin rm / remove
# optional: --keep-data  (preserves GROK_PLUGIN_DATA only; not the parley state files)
```

To stop hooks without removing files:

```sh
grok plugin disable parley-provenance
```

Parley session-state files already written under `~/.parley/vendors/grok/` are
left in place; remove them manually or via parley GC if desired.

## Development

```sh
pnpm --filter @useparley/plugin-grok build
pnpm --filter @useparley/plugin-grok typecheck
# from repo root:
pnpm test -- packages/plugins/grok
```

Hook layout:

```text
packages/plugins/grok/
  plugin.json           # name: parley-provenance
  hooks/
    hooks.json          # SessionStart, UserPromptSubmit, Stop → run.sh
    run.sh              # exec node $GROK_PLUGIN_ROOT/dist/hook.js
  dist/
    hook.js             # bundled entry (includes @useparley/core helpers)
  src/
    index.ts            # pure logic (tests import this)
    hook-cli.ts         # stdin/env CLI wrapper
```
