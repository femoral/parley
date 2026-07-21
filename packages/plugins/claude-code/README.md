# `@useparley/plugin-claude-code`

A Claude Code plugin that records deterministic session provenance for Parley.
At session start it writes the Claude session ID, harness identity, Claude
process PID, and the model when Claude supplies it. Unknown model and effort
values remain `null`; a later prompt hook fills the model from Claude's own
transcript when it becomes available.

The plugin also uses Claude Code's supported `CLAUDE_ENV_FILE` channel so
subsequent Bash-tool commands receive `PARLEY_SESSION_ID`,
`PARLEY_HARNESS=claude`, and `PARLEY_MODEL` when known.

## Install

For local development, build and load this directory for one session:

```sh
pnpm --filter @useparley/plugin-claude-code build
claude --plugin-dir packages/plugins/claude-code
```

For a published marketplace installation:

```sh
claude plugin marketplace add useparley/parley
claude plugin install parley@useparley
```

## Verify

Start a fresh Claude Code session with the plugin enabled, then ask Claude:

```text
Run `env | grep '^PARLEY_' | sort` and show me the output.
```

The output should include `PARLEY_SESSION_ID` and
`PARLEY_HARNESS=claude`. `PARLEY_MODEL` appears only when Claude Code exposes
the resolved model. The state file can be smoke-checked with:

```sh
find "${PARLEY_HOME:-$HOME/.parley}/vendors/claude/sessions" -name state.json -print
```

## Uninstall

Remove the marketplace plugin from user scope:

```sh
claude plugin uninstall parley@useparley
```

For `--plugin-dir`, simply stop passing that flag on future sessions.
