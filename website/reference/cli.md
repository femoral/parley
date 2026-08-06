# CLI commands

The complete `parley` surface. Most of it is driven by the orchestrating
agent, not typed by hand; the [getting started guide](/guide/getting-started)
covers the human path. `--json` is available on nearly everything.

## Setup

### `parley init`

One-shot setup: skills, config, example workflows, harness detection, model
allowlists.

| Flag | Meaning |
| ---- | ------- |
| `--layout claude\|agents\|<path>` | vendor skill layout, or a custom directory (default `agents`) |
| `--scope global\|project` | where to install skills and which config layer (default: project in a git repo, else global) |
| `--skill <name>` | skill to install, repeatable (default: all) |
| `--yes` | accept defaults, disable prompts |

Project scope also seeds `.parley/workflows/{coding-1,coding-2,research}`
without overwriting. `parley skills install` is a deprecated alias for the
skills part; `parley skills list` shows the bundled skills.

### `parley session [-s <id>]`

Register the orchestrating session. Session id provenance:
`PARLEY_SESSION_ID`, then `-s`, then the session-state file, then fresh. A
known id re-anchors after a restart.

## Delegation

### `parley delegate [flags] "<prompt>"`

Returns immediately with pending-task JSON. `-` reads the prompt from stdin.

| Flag | Meaning |
| ---- | ------- |
| `-v, --vendor <id>` | vendor adapter (or `--profile`, or `defaults.*`) |
| `-m, --model <id>` | model, passed through to the vendor |
| `--effort <level>` | reasoning effort, passed through |
| `--profile <name>` | named launch template, replaces vendor/model/effort |
| `-n, --name <label>` | human label, usable wherever a task id is |
| `--sandbox read-only\|workspace\|full` | sandbox posture (see [Vendors](/guide/vendors)) |
| `--no-network` | request network-off posture |
| `--cwd <path>` | run in this directory directly, skipping worktree creation |
| `--base-ref <ref>` | branch the worktree from `<ref>` (default `HEAD`) |
| `--context <file>` | copy a file into `.parley/context/`, repeatable |
| `--report-schema <file>` | validate the child's report against this JSON Schema |
| `--answer-timeout <dur>` | stall the task when a question goes unanswered this long (default 30m) |
| `--runner <name>` | hard-pin execution to a [remote runner](/guide/remote-runners) |
| `--size <id>` / `--difficulty <id>` / `--type <t>` | classification for metrics and eval |
| `--dry-run` | run the task but record nothing |

### `parley answer <task> "<text>"`

Answer a child's question (`-` reads stdin). On a stalled task, resumes it
with the text. Returns immediately; wait with `parley watch`.

### `parley fix [--fresh] <task> "<brief>"`

Create a linked reattempt that inherits the parent's profile and workspace
and resumes its vendor session when resume is enabled (default on).
`--fresh`: blank session, uncapped by retry limits, with daemon-composed
context (original brief, attempt history, fix request). Exit codes: 7
retry limit exceeded, 8 reattempt window expired.

### `parley cancel <task>`

Terminate the task's child; the task ends cancelled.

### `parley eval <task> --answers '<json>' --feedback "<text>"`

Record a structured rubric evaluation (boolean answers per criterion); the
daemon computes score and baseline. A later call overwrites the last. See
[Evaluation](/guide/evaluation).

## Waiting

### `parley watch [task...] [--ack <event-id>] [--follow]`

The only wait primitive. Delivers the next pending attention-inbox event for
the orchestrator session. Level-triggered: an already-pending event returns
immediately. `--ack` records handling of a prior event, then returns the
next. Positional task refs filter the inbox. `--follow` streams every
transition as JSONL without acking.

| Exit | Meaning |
| ---- | ------- |
| 0 | all done, inbox empty |
| 3 | awaiting answer (child question) |
| 4 | stalled |
| 5 | failed |
| 6 | completed |

## Inspection

| Command | What it shows |
| ------- | ------------- |
| `parley` / `parley list` / `parley status` | the task table, session-scoped (`--all` for everything) |
| `parley status <task>` | one task, by id or name |
| `parley logs <task> [--follow]` | the captured vendor stream, coalesced into readable lines (`--json`: raw JSONL) |
| `parley metrics [--group-by vendor\|model\|profile\|size\|difficulty\|type]` | aggregate counts, evals, tokens, duration |
| `parley info` | effective project configuration as orchestrator prose (`--json`: the structured config it renders from) |
| `parley prompt [--vendor <id>] [--profile <name>] [--orchestrator]` | preview the composed prompt a child would get from this cwd |

## Workflow runs

See [Workflow runs](/guide/workflows) for the concepts.

| Command | Role |
| ------- | ---- |
| `parley run start <workflow> [--input k=v]... [--inputs <file>] [--base-ref <ref>]` | create and enter a run |
| `parley run status [--all] [--workflow <id>] [--state <s>] [--blocked]` | list runs, session-scoped |
| `parley run status <run>` | one run's node table, one line per node and iteration |
| `parley run status <run> --node <id> [--iteration <n>] [--slot <name>]` | zoom to one node's tasks and deliverables |
| `parley run get <id\|address>` | fetch one deliverable or a collected fan-out (exit 9: purged by retention) |
| `parley run approve <run>` | action a blocked run past its gate |
| `parley run reject <run>` | follow the gate's declared on-reject path |
| `parley run redirect <run> --to <node> [--note <text>]` | move a live blocked run to another node |
| `parley run finish <run>` | complete a blocked run at its current node |
| `parley run cancel <run>` | abandon a live run (terminal; enables fork) |
| `parley run fork <run> [--to <node>] [--note <text>]` | new run from a terminal parent |

## Housekeeping

| Command | Role |
| ------- | ---- |
| `parley clean <task>` | remove a finished task's worktree, keep the branch |
| `parley clean --all-terminal` | sweep worktrees of all terminal-state tasks |
| `parley gc [--dry-run]` | purge expired terminal tasks (rows, logs, worktrees; never branches) |

## Models

| Command | Role |
| ------- | ---- |
| `parley models [--vendor <id>]` | show the daemon-wide model and effort allowlist |
| `parley models set\|unset <key> [value]` | edit the allowlist (scoped to `vendors.<id>.models`) |
| `parley models refresh [--vendor <id>]` | re-fingerprint host catalogs across the fleet |

## Configuration

| Command | Role |
| ------- | ---- |
| `parley config show` | the daemon's effective config |
| `parley config get\|set\|unset <key>` | read or write a dotted key |
| `parley config push <file>` | validate, then replace the config wholesale |
| `parley config pull [file]` | write the current config to a file or stdout |
| `parley lint [dir]` | validate project `.parley` surfaces (config, classification, rubrics, workflows); exit 1 on error |

## Daemon and UI

| Command | Role |
| ------- | ---- |
| `parley daemon start [--replace]` | start the background daemon |
| `parley daemon stop` | stop it |
| `parley daemon status` | identity: pid, port, id, home, version, provenance |
| `parley ui [--no-open]` | print the cockpit URL and open it |

## Remote fleet

| Command | Role |
| ------- | ---- |
| `parley runners list` | fleet table: name, status, vendors, last-seen |
| `parley runners show <name>` | full advertisement: models, mirrors, reachability, recent tasks |
| `parley runners remove <name>` | delete registration and config (loopback only) |
| `parley clones list` | managed mirrors on the daemon host |
| `parley clones prune` | remove mirrors no live task references |

## Child commands

Used by child agents, not orchestrators. See
[How children talk back](/explainer/children).

| Command | Role |
| ------- | ---- |
| `parley child report --summary <text> --outcome <success\|partial\|blocked> [--file <path>]...` | submit the final report (default schema) |
| `parley child report --json-file <path>\|-` | submit an arbitrary JSON report (custom schemas) |
| `parley child ask "<question>"` | ask the orchestrator, blocking (exit 4: stalled) |
| `parley child task` | print this task's envelope as JSON |

## Global flags and exit codes

`--json` for machine-readable output, `-h/--help`, `-V/--version`.

| Command | Exit codes |
| ------- | ---------- |
| `delegate`, `answer` | 0 accepted · 2 usage |
| `fix` | 0 accepted · 2 usage · 7 retry limit · 8 window expired |
| `watch` | 0 all-done · 2 usage · 3 awaiting answer · 4 stalled · 5 failed · 6 completed |
| `run get` | 0 printed · 2 usage · 9 purged |
| `child report` | 0 accepted · 5 rejected · 2 usage |
| `child ask` | 0 answered · 4 stalled · 2 usage |
