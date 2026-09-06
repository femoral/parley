# Troubleshooting

Watch startup reads lightweight scope metadata, not the task history's reports and schemas. A large retained history should not require a longer watch timeout. Direct HTTP `GET /tasks` defaults to at most 100 newest rows (`has_more` indicates truncation); `limit=1..100` narrows it. The explicit `all=true` compatibility/admin form is unbounded and can be expensive. Existing CLI task listings and the SDK complete-snapshot method opt into that form; prefer bounded queries for interactive clients. Listing settings are resolved once per repository per request, and edits take effect on the next request.

Each watch long-poll has one 25-second deadline, including wakes from unrelated tasks or runs. An empty poll is retried normally by the CLI; it is not completion. The 60-second client request timeout remains longer than the daemon window. Busy neighboring sessions must not extend that window.

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

## 3. `vendor.jsonl` (last resort)

The untouched raw vendor stream, same `logs_dir`. Only read this when 1 and 2
don't explain the failure — it's the full JSONL event log (`parley logs <id>`
renders it, `--json` for byte-for-byte) and will burn a lot of context on a
long-running task.

## When `watch` keeps erroring

`watch` exits 1 on a transport problem. Two failures look alike; the wording
separates them:

- **`could not reach the advertised parley daemon …`** — nothing is listening.
  Run `parley daemon status`; the next command respawns it.
- **`… did not respond in time`** — the daemon is alive but slow. Retries and
  restarts both leave it slow; shrink the load instead.

The slow case is a large task store under concurrent load — the daemon builds
its task list single-threaded, so concurrent `parley` processes queue behind
each other:

- `parley gc --dry-run`, then `parley gc`. If it reclaims little, your retention
  window outruns your task history — lower `retention.days` in
  `~/.parley/parley.json` first.
- Run fewer `parley` commands at once. One `watch` loop for a whole fan-out
  costs one poll; a loop per task multiplies it.

Retry only exit 1. Exit 2 is a usage error — a bad flag, or no session — and
never succeeds on retry.
# Report corrections

While a task is live, each valid report replaces the previous report. Once settled, further submissions are rejected. Invalid submissions never replace a valid report. The task's `diag.log` records timestamped `report superseded` and `report rejected` lines with the discarded summary; check these when the report differs from the work on the branch. Replacements do not extend the post-report completion fallback.
