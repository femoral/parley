# `@useparley/plugin-pi`

A [Pi](https://pi.dev/) extension that puts deterministic Parley session
provenance in Pi's process environment before any model request. Pi's tools and
other subprocesses inherit:

- `PARLEY_SESSION_ID` — Pi's current session ID
- `PARLEY_HARNESS=pi`
- `PARLEY_MODEL` — the active `provider/id`, when Pi has resolved a model
- `PARLEY_EFFORT` — Pi's effective thinking level

Model and thinking-level changes are reflected in processes spawned later in
the session. If Pi has no active model, `PARLEY_MODEL` remains unset.

## Install

Install for your user:

```sh
pi install npm:@useparley/plugin-pi
```

Or install only in the current project:

```sh
pi install -l npm:@useparley/plugin-pi
```

During plugin development, build it and load the extension directly:

```sh
pnpm --filter @useparley/plugin-pi build
pi -e packages/plugins/pi/dist/index.js
```

## Verify

Start a fresh Pi session with the extension loaded, then ask Pi:

```text
Run `env | grep '^PARLEY_' | sort` and show me the output.
```

The output should contain the session ID, `PARLEY_HARNESS=pi`, effective
thinking level, and (when a model is active) its `provider/id`.

## Uninstall

Remove a user installation:

```sh
pi remove npm:@useparley/plugin-pi
```

For a project-local installation, use the matching local flag:

```sh
pi remove -l npm:@useparley/plugin-pi
```
