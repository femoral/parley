# Troubleshooting a failed task

When a task fails and the reason isn't obvious from `parley status`, check things
in this order — cheapest and least context-hungry first.

## 1. The task's `error` field

`parley status --json` (or `GET /tasks/:id`, or a `watch` exit-5 envelope) already
carries the failure detail as a single string:

```
vendor child exited (code 0) without submitting a report [PARLEY-DIAG mcp_tool_call server=parley tool=submit_report failed: user cancelled MCP tool call]
```

- The base message (`vendor child exited …`) is always present when the child
  died without a schema-valid report.
- A `: <text>` suffix is the vendor's own fatal error (e.g. codex
  `turn.failed`) when one was reported.
- A trailing `[PARLEY-DIAG …]` is a tagged, adapter-surfaced diagnostic (see
  below) — usually the actual root cause when the vendor itself reported no
  fatal error but no report ever landed either.

This is almost always enough. Don't reach for the raw logs unless this string
doesn't explain it.

## 2. `diag.log`

`logs_dir` (returned alongside `error`) contains a `diag.log` — every
`PARLEY-DIAG`-tagged event for the task, one per line, timestamped. It's a
distilled trail: `grep PARLEY-DIAG` doesn't even apply, the whole file already
is that grep. Read it directly, or across many failed tasks:

```
grep -h PARLEY-DIAG ~/.parley/tasks/*/diag.log
```

Currently tagged: a vendor's own approval/guardian gate silently cancelling an
MCP call to `submit_report`/`ask_orchestrator` (codex: headless `exec` has no
TTY to answer the prompt, so it auto-cancels rather than auto-approving —
`docs/adr/0006-sandbox-workspace-network.md`). If you add a new adapter-level
diagnostic, tag it with `VENDOR_DIAG_PREFIX` (`src/daemon/adapters/types.ts`)
so it lands in this file automatically (`engine.ts` captures any `error` event
whose text starts with the prefix, fatal or not).

## 3. `vendor.jsonl` (last resort)

The untouched raw vendor stream, same `logs_dir`. Only read this when 1 and 2
don't explain the failure — it's the full JSONL event log (`parley logs <id>`
renders it, `--json` for byte-for-byte) and will burn a lot of context on a
long-running task.
