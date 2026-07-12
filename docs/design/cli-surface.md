# Parley CLI surface (v1 draft)

Prototype asset for the wayfinder ticket [Prototype: parley CLI surface](https://github.com/femoral/parley/issues/6). Reviewed and accepted 2026-07-09. Binds the wire protocol ([ticket](https://github.com/femoral/parley/issues/5)) to concrete commands, flags, and exit codes.

## Commands

```
parley delegate [flags] "<prompt>"     # prompt arg, or '-' for stdin
  -v, --vendor codex|grok      (required)
  -m, --model <id>             (passed through to vendor opaquely)
      --effort <level>         (reasoning effort, passed through opaquely; codex: -c
                                model_reasoning_effort, grok: --reasoning-effort)
  -n, --name <label>           (human label; default derived from prompt)
  -w, --worktree <name>        (parley creates worktree+branch; default: auto-name)
      --cwd <path>             (escape hatch: pre-made dir, skips worktree creation)
      --context <file>         (repeatable; semantics owned by the context-passing ticket)
      --report-schema <file>   (JSON Schema validating the child's submit_report)
      --wait                   (block until first question or terminal state)
      --answer-timeout <dur>   (default 30m; on expiry task → stalled, question recorded)
      --sandbox <mode>         (defaults owned by the sandbox-posture ticket)
      --allow-network          (idem)

parley answer <task> "<text>"      # <task> = id or name; '-' reads stdin; --wait re-blocks
parley status [task] [--json]      # all tasks, or one
parley logs <task> [--follow]      # captured vendor event stream (diagnostics)
parley cancel <task>
parley list                        # alias for bare `parley status`
parley daemon start|stop|status    # explicit control; `delegate` auto-spawns if absent
```

## The blocking contract (`--wait`)

`parley delegate --wait` and `parley answer --wait` share one contract: block until the task asks a question or reaches a terminal state, print a JSON document on stdout, exit with a semantic code.

| exit | state | stdout |
|------|-------|--------|
| 0 | completed | report envelope JSON (validated report body + daemon envelope: task id, worktree, branch, vendor, model, session id, usage, duration) |
| 1 | failed | error + diagnostics reference (vendor output captured as logs) |
| 2 | usage/config error | error message (no task created / task unchanged) |
| 3 | question | `{task_id, name, question_id, question}` — answer via `parley answer <task> --wait "..."`, which re-enters this same contract |
| 4 | stalled | recorded question + resume hint (`parley answer` later resumes via vendor session resume) |
| 5 | cancelled | cancellation record |

Without `--wait`, `delegate` prints `{task_id, name, state:"pending"}` and returns immediately; the orchestrator polls `parley status` / re-attaches with `parley answer --wait` or `parley status <task> --json`.

## Task identity

- Daemon assigns short ids (`t7`); `--name` adds a human label. All task-taking commands accept either.
- Worktree/branch derive from both: `parley/t7-fix-auth`.

## Orchestration loop (Claude Code side)

```
$ parley delegate -v codex -m gpt-5.6 --name fix-auth --wait "…" ; echo $?
{"task_id":"t7","name":"fix-auth","question_id":"q1","question":"JWT or session cookies?"}
3
$ parley answer fix-auth --wait "JWT" ; echo $?
{"task_id":"t7", …report envelope…}
0
```

Exit code branches the orchestrator's Bash logic without JSON parsing; stdout carries the detail when it wants it.

## Deferred to other tickets

- `--context` semantics → context-passing ticket.
- `--sandbox`/`--allow-network` defaults and modes → sandbox-posture ticket.
- Auto-spawn mechanics, state persistence → daemon-lifecycle ticket.
- Task↔issue-tracker linkage flag (e.g. `--ticket <url>`) → still fog on the map.
