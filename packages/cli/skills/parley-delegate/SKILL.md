---
name: parley-delegate
description: Delegate coding tasks to other agent CLIs (codex, grok) with the parley CLI — one task or a parallel fan-out, each in its own git worktree. Use when the user asks to delegate or offload work to codex/grok, run several agent tasks in parallel, or mentions parley.
---

# Delegating to parley

Parley runs a child agent (codex or grok) in an isolated git worktree and hands you back a schema-validated **report envelope**. You are the orchestrator: you write the brief, answer the child's questions, and review/merge the branch. Parley never merges.

**Orchestrate directly — don't wrap parley in subagents.** Unless the user explicitly asks for subagents, the session reading this skill is the orchestrator: it calls `delegate`, blocks on `watch`, answers questions, and reviews branches itself. Per-task babysitter subagents add a token layer, lose the question-answering context you already have, and tend to idle-stop waiting for notifications that never come.

## The delegate loop

1. **Write a self-contained brief.** The child sees only its worktree, your prompt, and `--context` files — none of your conversation. State the goal, constraints, and definition of done (including the project's real typecheck/test commands) in the prompt; pass supporting files with `--context <file>` (repeatable). Done when a stranger could execute the brief without asking you what it means.

2. **Delegate and block:**

   ```
   parley delegate -v codex -m <model> -n <short-name> --session <id> --wait "<brief>"
   ```

   (`-` as the prompt reads stdin — use a heredoc for long briefs.) `-v` and a session id (`--session <id>`, or `PARLEY_SESSION_ID` in the environment) are both required — missing either is a usage error (exit 2).

3. **Branch on the exit code** — stdout carries the matching JSON:

   | `$?` | state | your move |
   |---|---|---|
   | 0 | `completed` | review the report envelope (step 4) |
   | 3 | `awaiting_answer` | `parley answer <task> --wait "<answer>"` — re-enters this same contract |
   | 4 | `stalled` | question went unanswered past the timeout, or child crashed; `parley answer <task> --wait "…"` resumes it |
   | 1 | `failed` | troubleshoot — see "When a task fails" |
   | 2 | usage error | fix your invocation; no task was created |
   | 5 | `cancelled` | cancellation record |

   Keep answering exit-3 questions until you get a terminal code. The loop is done only at 0/1/5 — 3 and 4 always mean re-enter.

4. **Review and integrate.** The envelope carries the worktree path, branch (`parley/<id>-<name>`), and the report body. Review the diff on the branch, merge if it holds up, then `parley clean <task>` (removes the worktree, keeps the branch). Done when the branch is merged-or-rejected and the worktree cleaned.

   **A green report isn't proof the project typechecks.** `outcome: success` only means the child's own verification passed. Re-run the project's typecheck (plus targeted tests) yourself after every merge — per merge, not once at the end of a fan-out, since a later branch can reintroduce what an earlier one had cleared.

## Fan-out: several tasks in parallel

Each task gets its own worktree, so parallel tasks never collide. Delegate all without `--wait`:

```
parley delegate -v codex -n task-a --session <id> "<brief A>"   # → {task_id, name, state:"pending"}
parley delegate -v grok  -n task-b --session <id> "<brief B>"
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

### Integrating fan-out branches

When several branches share a fork point, only the first merge fast-forwards. Review each branch on its own, then cherry-pick its commits onto the target **in dependency order**, resolving conflicts at pick time and amending integration fixes into the picked commit — linear history, each commit typecheck-clean on its own. When tasks share files or one builds on another, prefer **dependency waves** over blind parallelism: merge task A first, then delegate task B with `--base-ref` on the freshly-merged target so it forks from its actual prerequisite.

## Beyond the golden path

One-liner pointers — read the linked file only when its condition fires:

- **Non-default task shapes** — structured `--report-schema` results, `--base-ref`/`--cwd`, sandbox postures, `--context` naming rules, the literal task-state vocabulary: read [task-shaping.md](task-shaping.md).
- **Setting up a new orchestrating environment** (wiring `PARLEY_SESSION_ID` from your harness, e.g. a Claude Code hook): read [sessions.md](sessions.md).
- **Vendor-specific child failures** (e.g. codex `git commit` failing in its worktree on older builds): read [vendor-notes.md](vendor-notes.md).

## When a task fails

Check the task's `error` field first (`parley status <task> --json | jq '.error'`), then `diag.log` in its `logs_dir`, before touching the raw vendor stream — full order and what each layer means: [docs/agents/troubleshooting.md](../../docs/agents/troubleshooting.md). `parley logs <task>` is the last resort; it burns a lot of context on long tasks.

## Reporting parley bugs

Parley is in early testing — when parley itself misbehaves (wrong state transition, lost report, worktree damage, a `PARLEY-DIAG` you can't act on), file it upstream after the triage above, whether or not you found a workaround: open an issue on [github.com/femoral/parley](https://github.com/femoral/parley) labelled `needs-triage`, body per [bug-report.md](bug-report.md). Done when the issue URL exists and you've told the user.
