---
name: parley-delegate
description: Delegate coding tasks to other agent CLIs (codex, grok) with the parley CLI — one task or a parallel fan-out, each in its own git worktree. Use when the user asks to delegate or offload work to codex/grok, run several agent tasks in parallel, or mentions parley.
---

# Delegating to parley

Parley runs a child agent (codex or grok) in an isolated git worktree and hands you back a schema-validated **report envelope**. You are the orchestrator: you write the brief, answer the child's questions, and review/merge the branch. Parley never merges.

## The delegate loop

1. **Write a self-contained brief.** The child sees only its worktree, your prompt, and `--context` files — none of your conversation. State the goal, constraints, and definition of done in the prompt; pass supporting files with `--context <file>` (repeatable, lands in `.parley/context/`). Done when a stranger could execute the brief without asking you what it means.

   `--context` files are materialized by **basename** under `.parley/context/`, so two files with the same name from different source directories collide — `delegate` rejects a duplicate `--context` basename as a usage error (exit 2) before the task is created. Give same-named context files distinct names before passing them.

2. **Delegate and block:**

   ```
   parley delegate -v codex -m <model> -n <short-name> --wait "<brief>"
   ```

   (`-` as the prompt reads stdin — use a heredoc for long briefs.)

   Every `delegate` needs an **orchestrator session id** so the tasks one run spawns can be grouped later: pass `--session <id>`, or set `PARLEY_SESSION_ID` in the environment (`--session` wins when both are set). Neither is a usage error (exit 2), same as a missing `-v/--vendor` — no silent ungrouped task. The id is recorded as `orchestrator_session_id` (visible in `status --json`), distinct from the vendor's own resume `session_id`.

3. **Branch on the exit code** — stdout carries the matching JSON:

   | `$?` | state | your move |
   |---|---|---|
   | 0 | `completed` | review the report envelope (step 4) |
   | 3 | `awaiting_answer` | `parley answer <task> --wait "<answer>"` — re-enters this same contract |
   | 4 | `stalled` | question went unanswered past the timeout, or child crashed; `parley answer <task> --wait "…"` resumes it |
   | 1 | `failed` | troubleshoot — see below |
   | 2 | usage error | fix your invocation; no task was created |
   | 5 | `cancelled` | cancellation record |

   Keep answering exit-3 questions until you get a terminal code. The loop is done only at 0/1/5 — 3 and 4 always mean re-enter.

   **Literal task states.** These are the exact strings `parley status --json` reports in a task's `state` field — the full vocabulary is `pending`, `running`, `awaiting_answer`, `stalled`, `completed`, `failed`, `cancelled`. If you're polling or grepping `status --json` output by hand, match on `awaiting_answer`, not "question" — the word "question" never appears in the field, and a filter for it silently misses a parked child. Prefer `parley watch` (below) over hand-rolled polling — it's keyed off this same state vocabulary and blocks instead of sampling.

4. **Review and integrate.** The envelope carries the worktree path, branch (`parley/<id>-<name>`), and the report body (default schema: `summary`, `outcome: success|partial|blocked`, `files_changed`). Review the diff on the branch, merge if it holds up, then `parley clean <task>` (removes the worktree, keeps the branch). Done when the branch is merged-or-rejected and the worktree cleaned.

   **A green report isn't proof the project typechecks.** `outcome: success` only means the child's own verification passed, and some verification setups (a test runner that strips types, for instance) can be green while a typecheck-only failure — an exhaustive union going non-exhaustive, say — crosses the report undetected. Put the project's actual typecheck command in the brief's definition of done, and re-run it yourself (plus any targeted tests) after every merge, regardless of what the child claimed. Do this per merge, not once at the end of a fan-out — a later branch can reintroduce a type error a merged one had already cleared.

## Fan-out: several tasks in parallel

Each task gets its own worktree, so parallel tasks never collide. Delegate all without `--wait`, then attach to each in turn:

```
parley delegate -v codex -n task-a "<brief A>"     # → {task_id, name, state:"pending"}
parley delegate -v grok  -n task-b "<brief B>"
parley status                                       # task table
parley status task-a --json                         # one task; attach via `parley answer <task> --wait` when it asks
```

A detached task that asks a question waits up to `--answer-timeout` (default 30m), then stalls — recoverable, but watch for it rather than sampling on an interval:

```
parley watch                          # blocks until any non-terminal task changes; prints the transition
parley watch --until attention        # returns only on awaiting_answer/stalled
parley watch --until terminal         # returns once every watched task is terminal
parley watch --follow                 # streams every transition as JSONL; good for a hook driver
```

`watch` takes explicit task ids/names too; with none, it snapshots whatever's non-terminal at the moment it starts. Chain `--since <seq>` off a `delegate` response's `seq` field to close the race where a task finishes between `delegate` returning and the first `watch` call — otherwise that transition would be invisible to a fresh watcher. Exit codes match the blocking contract above (0 completed/any-change, 3 awaiting_answer, 4 stalled). The fan-out is done when every delegated task reached a terminal state and each branch was reviewed per step 4.

**Merging multiple branches from the same fork point.** When several fan-out branches share a parent commit, only the first merge fast-forwards — the rest need real integration, not just `git merge`. The discipline that held up on a real 12-task fan-out: review each branch on its own, then cherry-pick its commit(s) onto the target branch **in dependency order** (prerequisites before dependents), resolving any conflicts at cherry-pick time and amending integration fixes straight into the picked commit rather than leaving a separate fixup commit. This keeps history linear and keeps each merged commit typecheck-clean on its own (see the typecheck note in step 4).

**Prefer dependency waves over blind parallel fan-out.** If tasks share files or have an ordering dependency (task B builds on what task A produces), don't delegate both from the same HEAD and hope the merge sorts itself out. Delegate task A, merge it once it's reviewed, then delegate task B with `--base-ref` pointed at the freshly-merged target branch so it forks from B's actual prerequisite instead of a stale shared HEAD. This produced far fewer merge conflicts than delegating everything up front. Reserve true blind parallel fan-out for tasks that are genuinely independent (disjoint files, no ordering requirement).

**Codex vendor history: worktree commits.** Codex tasks running in a parley worktree used to be unable to `git commit` their own changes — the sandbox's writable roots covered only the per-worktree gitdir, not the shared `.git` object database, so `git add`/`git commit` failed and the child had to escalate. Fixed in [#31](https://github.com/femoral/parley/issues/31): the sandbox now grants both roots under `workspace` posture. If you hit a commit failure on an older parley build, the workaround was to instruct codex children to leave changes uncommitted and report a suggested commit message instead, with the orchestrator committing from the host.

## Shaping a task

- **Vendor/model**: `-v codex|grok` required; `-m` passes the model id through opaquely.
- **Report schema**: `--report-schema <file>` (JSON Schema) when you need structured results back — e.g. a findings list from a review task. Validation failures bounce back to the child to retry, so the envelope you receive always conforms.
- **Worktree base**: branches from HEAD; `--base-ref <ref>` overrides. `--cwd <path>` skips worktree creation and runs in that directory — escape hatch only, forfeits isolation.
- **Sandbox**: default is workspace-write + network, approvals off. `--sandbox read-only` for review/analysis tasks, `--no-network` to cut egress, `--sandbox full` only when the task genuinely needs to escape the workspace.

## Mapping your harness session onto `PARLEY_SESSION_ID`

`PARLEY_SESSION_ID` is deliberately generic — parley core stays harness-agnostic and never reads a harness-specific variable. Each orchestrating harness maps its own session concept onto it:

- **Claude Code**: the harness identifies each run with a session id — the `session_id` field it hands every hook (the same id that appears in the `claude.ai/code/session_…` links). Wire it once per run so every `parley delegate` you make inherits it: a `SessionStart` hook that exports `PARLEY_SESSION_ID` from that `session_id` (or, when you shell out delegate calls yourself, pass `--session "$CLAUDE_SESSION_ID"`). Then all the tasks a single Claude Code run spawns share one `orchestrator_session_id`.

Any harness without a native session concept can synthesize one (a uuid per run) and export it as `PARLEY_SESSION_ID` before its first delegate.

## When a task fails

Check the task's `error` field first (`parley status <task> --json`), then `diag.log` in its `logs_dir`, before touching the raw vendor stream — full order and what each layer means: [docs/agents/troubleshooting.md](../../docs/agents/troubleshooting.md). `parley logs <task>` is the last resort; it burns a lot of context on long tasks.

## Reporting parley bugs

Parley is in early testing — when parley itself misbehaves (wrong state transition, lost report, worktree damage, a `PARLEY-DIAG` you can't act on), file it upstream after the triage above, whether or not you found a workaround: open an issue on [github.com/femoral/parley](https://github.com/femoral/parley) labelled `needs-triage`, body per [bug-report.md](bug-report.md). Done when the issue URL exists and you've told the user.
