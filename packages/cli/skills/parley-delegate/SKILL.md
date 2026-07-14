---
name: parley-delegate
description: Delegate coding tasks to other agent CLIs (codex, grok) with the parley CLI — one task or a parallel fan-out, each in its own git worktree. Use when the user asks to delegate or offload work to codex/grok, run several agent tasks in parallel, or mentions parley.
---

# Delegating to parley

Parley runs a child agent (codex or grok) in an isolated git worktree and hands you back a schema-validated **report envelope**. You are the orchestrator: you write the brief, answer the child's questions, and review/merge the branch. Parley never merges.

**Orchestrate directly — don't wrap parley in subagents.** Unless the user explicitly asks for subagents, the session reading this skill is the orchestrator: it calls `delegate`, blocks on `watch`, answers questions, and reviews branches itself. Spawning a per-task subagent whose only job is to babysit one `delegate --wait` call is wasteful — the delegate loop is a thin CLI contract, and intermediary agents tend to idle-stop waiting for notifications that never come, adding a token layer and losing the question-answering context you already have. For a fan-out, delegate all tasks without `--wait` and drive the whole set with one `watch` loop (below).

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

Each task gets its own worktree, so parallel tasks never collide. Delegate all without `--wait`:

```
parley delegate -v codex -n task-a "<brief A>"     # → {task_id, name, state:"pending"}
parley delegate -v grok  -n task-b "<brief B>"
parley status                                       # one-off table; NOT a wait mechanism
parley status task-a --json | jq '.report'          # one task is an object; inspect its completed report
```

Then drive the **entire** fan-out with one mechanism: the `watch` loop below. Do not poll `status` on an interval, do not sleep-and-check, do not attach `--wait` to tasks one at a time.

### The watch loop — the one intended way to wait

`watch` is an **acked attention inbox** for the orchestrator session (`--session`, else `PARLEY_SESSION_ID`, else the latest session). Each call blocks until something needs you, then returns exactly **one** event — the highest-priority pending one (`awaiting_answer` > `stalled` > `failed` > `completed`) — and exits with a code that tells you what it is. You handle that one event, then call `watch` again, acking the event you just handled. Repeat until exit 0.

```
ev=$(parley watch --json); code=$?
while [ "$code" -ne 0 ]; do
  seq=$(printf '%s' "$ev" | jq -r .seq)        # the event id you will ack
  # …handle per the table below…
  ev=$(parley watch --json --ack "$seq"); code=$?
done
# exit 0 = all-done: every watched task terminal AND every event acked. The fan-out is drained.
```

What each exit code means and what you must do before acking:

| `$?` | event | your move | how it gets acked |
|---|---|---|---|
| 3 | `task.question` | `parley answer <task> --wait "<answer>"` | **automatic** — answering moves the task out of `awaiting_answer`, which resolves the event. Do not pass `--ack` for it. |
| 4 | `task.stalled` | `parley answer <task> --wait "…"` resumes it | **automatic** on resume, same as 3 |
| 5 | `task.failed` | triage (see "When a task fails") | **explicit**: next `watch --ack <seq>` — only after you've triaged |
| 6 | `task.completed` | review the branch, merge-or-reject, typecheck, `parley clean` (delegate-loop step 4) | **explicit**: next `watch --ack <seq>` — only after the review is done |
| 0 | — (all-done) | stop looping; nothing is pending and nothing is running | — |
| 2 | usage error | fix your invocation | — |

Rules that leave no room for interpretation:

- **Ack means "I handled this", never "I saw this".** Ack a `completed` event only after its branch is reviewed and merged-or-rejected; ack a `failed` event only after triage. Acking early deletes your only reminder — the task drops out of the inbox and nothing will resurface it.
- **Un-acked events redeliver.** If you crash or forget between delivery and ack, the next `watch` hands you the same event again. That is the safety net — lean on it; never ack defensively "to clear the queue".
- **Exit 6 is not "done".** A completed task is *work for you* (review, merge, verify, clean). The fan-out is finished only at exit 0.
- **Level-triggered, race-free.** An event already pending when `watch` starts returns immediately. There is no startup race and no sequence bookkeeping on your side; the only seq you ever touch is the one you pass back to `--ack`.
- **`--until` and `--since` no longer exist** (removed in [#91](https://github.com/femoral/parley/issues/91); passing them is exit 2). Any doc, memory, or habit that mentions them predates ADR-0007 — the loop above replaces every use they had.
- **Watch exit codes are not `delegate --wait` exit codes.** In `watch`, 0 is reserved for all-done, so `completed` is 6 and `failed` is 5. In `delegate --wait`/`answer --wait`, `completed` is 0 and `failed` is 1. Codes 3/4 mean the same thing everywhere.
- **`--follow` is not the loop.** It streams every transition as JSONL with no acks and no priority — a firehose for UIs and debugging. Orchestrators use the default acked mode.
- Positional task refs (`parley watch t1 t2`) narrow the inbox to those tasks; the default is every task in the session.

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

Check the task's `error` field first (`parley status <task> --json | jq '.error'`), then `diag.log` in its `logs_dir`, before touching the raw vendor stream — full order and what each layer means: [docs/agents/troubleshooting.md](../../docs/agents/troubleshooting.md). `parley logs <task>` is the last resort; it burns a lot of context on long tasks.

## Reporting parley bugs

Parley is in early testing — when parley itself misbehaves (wrong state transition, lost report, worktree damage, a `PARLEY-DIAG` you can't act on), file it upstream after the triage above, whether or not you found a workaround: open an issue on [github.com/femoral/parley](https://github.com/femoral/parley) labelled `needs-triage`, body per [bug-report.md](bug-report.md). Done when the issue URL exists and you've told the user.
