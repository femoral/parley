# Parley CLI surface (v1 draft)

Prototype asset for the wayfinder ticket [Prototype: parley CLI surface](https://github.com/femoral/parley/issues/6). Reviewed and accepted 2026-07-09. Binds the wire protocol ([ticket](https://github.com/femoral/parley/issues/5)) to concrete commands, flags, and exit codes.

Updated by [ADR-0008](../adr/0008-single-flow-watch-only.md) / [#93](https://github.com/femoral/parley/issues/93): `delegate`/`answer` are always async; `watch` is the only wait.

## Commands

```
parley delegate [flags] "<prompt>"     # prompt arg, or '-' for stdin; returns immediately
  -v, --vendor codex|grok      (required)
  -m, --model <id>             (passed through to vendor opaquely)
      --effort <level>         (reasoning effort, passed through opaquely; codex: -c
                                model_reasoning_effort, grok: --reasoning-effort)
  -n, --name <label>           (human label; default derived from prompt)
  -w, --worktree <name>        (parley creates worktree+branch; default: auto-name)
      --cwd <path>             (escape hatch: pre-made dir, skips worktree creation)
      --context <file>         (repeatable; semantics owned by the context-passing ticket)
      --report-schema <file>   (JSON Schema validating the child's submit_report)
      --answer-timeout <dur>   (default 30m; on expiry task → stalled, question recorded)
      --sandbox <mode>         (defaults owned by the sandbox-posture ticket)
      --allow-network          (idem)

parley answer <task> "<text>"      # <task> = id or name; '-' reads stdin; returns immediately
parley watch [task…] [--ack <event-id>] [--session <id>] [--follow] [--json]
                                   # the only blocking primitive (ADR-0007 / ADR-0008)
parley status [task] [--json]      # all tasks, or one
parley logs <task> [--follow]      # captured vendor event stream (diagnostics)
parley cancel <task>
parley list                        # alias for bare `parley status`
parley daemon start|stop|status    # explicit control; `delegate` auto-spawns if absent
```

## One flow: always-async delegate, watch is the only wait

`parley delegate` prints `{task_id, name, state:"pending", seq}` and returns immediately (exit 0). `parley answer` posts the answer and returns immediately (exit 0). State-typed exit codes live only on `parley watch` (ADR-0007):

| exit | meaning | stdout |
|------|---------|--------|
| 0 | all-done | empty — every watched task terminal **and** every event acked |
| 2 | usage/config error | error message |
| 3 | awaiting_answer | inbox event JSON (`task.question` + envelope) |
| 4 | stalled | inbox event JSON + resume hint on stderr |
| 5 | failed | inbox event JSON |
| 6 | completed | inbox event JSON (report envelope under `.task`) |

Passing the removed `--wait` flag on `delegate` or `answer` is exit 2, with a message pointing at `parley watch`.

## Task identity

- Daemon assigns short ids (`t7`); `--name` adds a human label. All task-taking commands accept either.
- Worktree/branch derive from both: `parley/t7-fix-auth`.

## Orchestration loop

```
$ parley delegate -v codex -m gpt-5.6 --name fix-auth --session orch "…"
{"task_id":"t7","name":"fix-auth","state":"pending","seq":0}
$ parley watch --json ; echo $?
{"event":"task.question","seq":2,"task":{…,"question":"JWT or session cookies?"}}
3
$ parley answer fix-auth "JWT"
{"task_id":"t7","name":"fix-auth","state":"running",…}
$ parley watch --json ; echo $?
{"event":"task.completed","seq":4,"task":{…report envelope…}}
6
$ # review branch, then ack
$ parley watch --json --ack 4 ; echo $?
0
```

Exit code branches the orchestrator's Bash logic without JSON parsing; stdout carries the detail when it wants it. One loop for n=1 and n=N.

## Deferred to other tickets

- `--context` semantics → context-passing ticket.
- `--sandbox`/`--allow-network` defaults and modes → sandbox-posture ticket.
- Auto-spawn mechanics, state persistence → daemon-lifecycle ticket.
- Task↔issue-tracker linkage flag (e.g. `--ticket <url>`) → still fog on the map.
