---
name: delegating-to-parley
description: Delegate coding tasks to other agent CLIs (codex, grok) with the parley CLI — one task or a parallel fan-out, each in its own git worktree. Use when the user asks to delegate or offload work to codex/grok, run several agent tasks in parallel, or mentions parley.
---

# Delegating to parley

Parley runs a child agent (codex or grok) in an isolated git worktree and hands you back a schema-validated **report envelope**. You are the orchestrator: you write the brief, answer the child's questions, and review/merge the branch. Parley never merges.

## The delegate loop

1. **Write a self-contained brief.** The child sees only its worktree, your prompt, and `--context` files — none of your conversation. State the goal, constraints, and definition of done in the prompt; pass supporting files with `--context <file>` (repeatable, lands in `.parley/context/`). Done when a stranger could execute the brief without asking you what it means.

2. **Delegate and block:**

   ```
   parley delegate -v codex -m <model> -n <short-name> --wait "<brief>"
   ```

   (`-` as the prompt reads stdin — use a heredoc for long briefs.)

3. **Branch on the exit code** — stdout carries the matching JSON:

   | `$?` | state | your move |
   |---|---|---|
   | 0 | completed | review the report envelope (step 4) |
   | 3 | question | `parley answer <task> --wait "<answer>"` — re-enters this same contract |
   | 4 | stalled | question went unanswered past the timeout, or child crashed; `parley answer <task> --wait "…"` resumes it |
   | 1 | failed | troubleshoot — see below |
   | 2 | usage error | fix your invocation; no task was created |
   | 5 | cancelled | cancellation record |

   Keep answering exit-3 questions until you get a terminal code. The loop is done only at 0/1/5 — 3 and 4 always mean re-enter.

4. **Review and integrate.** The envelope carries the worktree path, branch (`parley/<id>-<name>`), and the report body (default schema: `summary`, `outcome: success|partial|blocked`, `files_changed`). Review the diff on the branch, merge if it holds up, then `parley clean <task>` (removes the worktree, keeps the branch). Done when the branch is merged-or-rejected and the worktree cleaned.

## Fan-out: several tasks in parallel

Each task gets its own worktree, so parallel tasks never collide. Delegate all without `--wait`, then attach to each in turn:

```
parley delegate -v codex -n task-a "<brief A>"     # → {task_id, name, state:"pending"}
parley delegate -v grok  -n task-b "<brief B>"
parley status                                       # task table
parley status task-a --json                         # one task; attach via `parley answer <task> --wait` when it asks
```

A detached task that asks a question waits up to `--answer-timeout` (default 30m), then stalls — recoverable, but check `parley status` regularly so children aren't parked. The fan-out is done when every delegated task reached a terminal state and each branch was reviewed per step 4.

## Shaping a task

- **Vendor/model**: `-v codex|grok` required; `-m` passes the model id through opaquely.
- **Report schema**: `--report-schema <file>` (JSON Schema) when you need structured results back — e.g. a findings list from a review task. Validation failures bounce back to the child to retry, so the envelope you receive always conforms.
- **Worktree base**: branches from HEAD; `--base-ref <ref>` overrides. `--cwd <path>` skips worktree creation and runs in that directory — escape hatch only, forfeits isolation.
- **Sandbox**: default is workspace-write + network, approvals off. `--sandbox read-only` for review/analysis tasks, `--no-network` to cut egress, `--sandbox full` only when the task genuinely needs to escape the workspace.

## When a task fails

Check the task's `error` field first (`parley status <task> --json`), then `diag.log` in its `logs_dir`, before touching the raw vendor stream — full order and what each layer means: [docs/agents/troubleshooting.md](../../docs/agents/troubleshooting.md). `parley logs <task>` is the last resort; it burns a lot of context on long tasks.

## Reporting parley bugs

Parley is in early testing — when parley itself misbehaves (wrong state transition, lost report, worktree damage, a `PARLEY-DIAG` you can't act on), file it upstream after the triage above, whether or not you found a workaround: open an issue on [github.com/femoral/parley](https://github.com/femoral/parley) labelled `needs-triage`, body per [bug-report.md](bug-report.md). Done when the issue URL exists and you've told the user.
