# Troubleshooting

## First moves

```bash
parley daemon status    # is the daemon up, which home, which version
parley status --all     # every task, not just this session's
parley info             # what configuration is actually in effect
```

Common setup failures:

| Symptom | Likely cause |
| ------- | ------------ |
| `delegate` fails with unknown vendor | vendor CLI not on PATH, or a plugin adapter failed to load (check daemon stderr) |
| `delegate` rejected with an allowlist error | `vendors.<id>.models` is empty; run `/parley-wizard` or `parley models set` |
| `parley ui` prints a URL but no cockpit | `@useparley/dashboard` not installed, or `config.ui.*` points somewhere stale |
| plugin changes not picked up | daemon still running the old module; `parley daemon start --replace` |
| child cannot report (task fails at the end) | vendor approval gate silently cancelled the MCP call; see the diagnostics trail below |

## When a task fails: three stops, in order

Cheapest and least context-hungry first. This is the same order the
orchestrator skills follow.

### 1. The task's `error` field

`parley status <task> --json` (or the `watch` exit-5 envelope) already
carries the failure detail as a single string:

```text
vendor child exited (code 0) without submitting a report
  [PARLEY-DIAG mcp_tool_call server=parley tool=submit_report failed: user cancelled MCP tool call]
```

- The base message is always present when the child died without a
  schema-valid report.
- A `: <text>` suffix is the vendor's own fatal error, when one was reported.
- A trailing `[PARLEY-DIAG ...]` is an adapter-surfaced diagnostic, and is
  usually the actual root cause when the vendor reported no fatal error but
  no report ever landed either.

This is almost always enough.

### 2. `diag.log`

The task's logs directory (returned alongside `error`) contains `diag.log`:
every tagged diagnostic for the task, one per line, timestamped. Sandbox
posture gaps land here too (a requested posture the vendor only
approximates). Across many failed tasks:

```bash
grep -h PARLEY-DIAG ~/.parley/tasks/*/diag.log
```

### 3. The raw vendor stream (last resort)

`parley logs <task>` renders the untouched vendor JSONL (`--json` for
byte-for-byte). Only go here when the first two stops do not explain the
failure; a long-running task's stream is large.

## Stalls and unanswered questions

A child question that goes unanswered past the answer timeout (default 30
minutes) stalls the task rather than hanging it. `parley watch` surfaces the
stall (exit 4) and `parley answer <task> "..."` resumes it. If the
orchestrating session died, a new session with the same id re-anchors and
inherits the inbox.

## Remote-runner failures

- **Claim-time git failures** (auth, permissions) fail the task before any
  vendor spawns and mark that runner-repo pairing unreachable until the
  runner re-registers (restart or periodic re-fingerprint).
- **Lost runner**: a missed heartbeat fails the in-flight task with the
  runner name, phase, branch, and last-event age. Not auto-retried.
- A failed remote task that had preflight-pushed may leave a zero-diff
  branch on origin; the runner best-effort deletes it, but a residue can
  need manual removal.

See [Remote runners](/guide/remote-runners) for the full flow.

## Still stuck?

Open an issue at
[github.com/femoral/parley/issues](https://github.com/femoral/parley/issues)
with the `error` string, the relevant `diag.log` lines, and your
`parley daemon status` output.
