---
name: parley-delegate
description: Delegate tasks to other agent CLIs (e.g codex, grok, opencode, pi, etc) with the parley CLI. Use when the user asks to delegate to other agents, or mentions parley.
disable-model-invocation: true
---

# Delegating to parley

Parley runs a child agent CLI in an isolated git worktree and hands you back a schema-validated **report envelope**. You are the orchestrator: you write the brief, answer the child's questions, and review/merge the branch. Parley never merges.

**Orchestrate directly — don't wrap parley in subagents.** Unless the user explicitly asks for subagents, the session reading this skill is the orchestrator: it calls `delegate`, blocks on `watch`, answers questions, and reviews branches itself. Per-task babysitter subagents add a token layer, lose the question-answering context you already have, and tend to idle-stop waiting for notifications that never come.

## Step 0 — load live config

At session start, before the first `delegate`:

```
parley info
```

Treat that output as **authoritative** for this project: vendors and profiles, valid `--type` ids, size/difficulty classification, whether evaluation is on (and how to record evals), and fix/retry policy with error codes. Do not invent those values; re-run `parley info` if the project may have changed.

**When evaluation is on**, install the harness plugin for your orchestrator (exports `PARLEY_SESSION_ID` / `PARLEY_HARNESS` / `PARLEY_MODEL` / `PARLEY_EFFORT`), then register (or re-anchor after crash/restart):

```
parley session
# re-anchor a known id (or rely on PARLEY_SESSION_ID from the plugin):
parley session -s <id>
```

Provenance is env-only — models must not invent model/effort values. Missing env vars register as unknown. Prefer `PARLEY_SESSION_ID` from the plugin for later commands; `--session` is a fallback. See [sessions.md](sessions.md).

**Setup problems** (missing vendors, unconfigured project, eval misconfig): stop and run `/parley-wizard` with the user. Do not invent config mid-orchestration.

## The delegate loop

There is **one** flow for one task or many: `delegate` always returns immediately; `watch` is the only wait. The single-task case is the fan-out loop with n=1.

1. **Write a self-contained brief.** The child sees only its worktree, your prompt, and `--context` files — none of your conversation. State the goal, constraints, and definition of done (including the project's real typecheck/test commands) in the prompt; pass supporting files with `--context <file>` (repeatable). Done when a stranger could execute the brief without asking you what it means.

2. **Delegate** (returns immediately with pending-task JSON):

   ```
   parley delegate -v <vendor> -m <model> -n <short-name> --session <id> \
     [--type <id>] [--size <id>] [--difficulty <id>] "<brief>"
   ```

   (`-` as the prompt reads stdin — use a heredoc for long briefs.) A vendor (`-v`, or a `--profile` that names one) and a session id (`--session <id>`, or `PARLEY_SESSION_ID` in the environment) are both required — missing either is a usage error (exit 2). `delegate` and `answer` exit only `0` (accepted) or `2` (usage).

   Choose vendor, profile, model, and classification from what `parley info` listed:

   - **`--type <id>`** — work-domain type; valid ids come from info (omit ⇒ the automatic fallback listed there).
   - **`--size <id>` / `--difficulty <id>`** — optional classification for metrics; ids and guidance from info.
   - **`--profile <name>`** — prefer a named profile when the user has them (tracked per task; makes `parley metrics` comparisons meaningful). Explicit flags win over profile defaults.
   - **`--runner <name>`** — targets a configured remote runner; the task's commits come back as a pushed branch (no local worktree to review — fetch it).

3. **Run the watch ack-loop** until exit 0 — even for a single task. This is a workflow you step through, not a script: each `watch` call returns one event, you do the real work it demands (answer, review, merge), then call `watch` again.

   ```
   run `parley watch --json`
   repeat:
     if exit 0            → all-done: every task terminal, every event acked. Stop.
     otherwise            → one event arrived; note its `.seq` (the event id)
       handle it per the table below (answer / triage / review-and-merge)
       questions (3/4)    → run `parley watch --json`            (answering acked it)
       failed/completed (5/6) → run `parley watch --json --ack <seq>`  (you ack it, now that it's handled)
   ```

What each exit code means and what you must do before acking:

| `$?` | event | your move | how it gets acked |
|---|---|---|---|
| 3 | `task.question` | `parley answer <task> "<answer>"` | **automatic** — answering moves the task out of `awaiting_answer`, which resolves the event. Do not pass `--ack` for it. |
| 4 | `task.stalled` | `parley answer <task> "…"` resumes it | **automatic** on resume, same as 3 |
| 5 | `task.failed` | triage (see "When a task fails") | **explicit**: next `watch --ack <seq>` — only after you've triaged |
| 6 | `task.completed` | review the branch, merge-or-reject, typecheck, `parley clean` (step 4) | **explicit**: next `watch --ack <seq>` — only after the review is done |
| 0 | — (all-done) | stop looping; nothing is pending and nothing is running | — |
| 2 | usage error | fix your invocation | — |

Rules that leave no room for interpretation:

- **Ack means "I handled this", never "I saw this".** Ack a `completed` event only after its branch is reviewed and merged-or-rejected; ack a `failed` event only after triage. Acking early deletes your only reminder — the task drops out of the inbox and nothing will resurface it.
- **Un-acked events redeliver.** If you crash or forget between delivery and ack, the next `watch` hands you the same event again. That is the safety net — lean on it; never ack defensively "to clear the queue".
- **Exit 6 is not "done".** A completed task is *work for you* (review, merge, verify, clean). The loop is finished only at exit 0.
- **Level-triggered, race-free.** An event already pending when `watch` starts returns immediately. There is no startup race and no sequence bookkeeping on your side; the only seq you ever touch is the one you pass back to `--ack`.
- Positional task refs (`parley watch t1 t2`) narrow the inbox to those tasks; the default is every task in the session.

4. **Review and integrate.** On exit 6 the envelope carries the worktree path, branch (`parley/<id>-<name>`), and the report body. Review the diff on the branch, merge if it holds up, then `parley clean <task>` (removes the worktree, keeps the branch). Ack only after that review. Done when the branch is merged-or-rejected and the worktree cleaned.

   **A green report isn't proof correctness.** `outcome: success` only means the child's own verification passed. Verify yourself after every merge, not once at the end of a fan-out unless instructed. A later branch can reintroduce what an earlier one had cleared.

   **Eval when expected.** When step 0 showed evaluation on, record an eval on every reviewed task:

   ```
   parley eval <task> --answers '<json>' --feedback "<one line per criterion>"
   ```

   Map every rubric criterion id (from `parley info`) to a boolean. The daemon computes score and baseline — do not pass a free-form score. Answer honestly, including failures. A later call overwrites the previous result for that task.

5. **Fix loop.** When a completed task needs more work (review found gaps, or you have a concrete fix brief):

   ```
   parley fix <task> "<what to fix>"
   ```

   That creates a linked reattempt (inherits profile/workspace; may resume the parent vendor session — policy from `parley info`). Drive it with the same watch loop.

   If `parley fix` exits with `retry_limit_exceeded` (exit 7) or `reattempt_window_expired` (exit 8):

   ```
   parley fix --fresh <task> "<what to fix>"
   ```

   `--fresh` starts a blank session, is uncapped by resume retry limits, and stays in the attempt chain. Exact limits and window live in `parley info` — re-read them when unsure.

## Fan-out: several tasks in parallel

Each task gets its own worktree, so parallel tasks never collide. Batch them however it makes sense, then drive the **entire** set with the same watch loop above:

```
parley delegate -v <vendor> -n task-a --session <id> --type <id> "<brief A>"
parley delegate -v <vendor> -n task-b --session <id> --type <id> "<brief B>"
```

Do not poll `status` on an interval and do not sleep-and-check. One mechanism for n=1 and n=N.

## Session ID

The session ID identifies the current orchestration session. Resolution is env-first: `PARLEY_SESSION_ID` > `--session <id>` > session-state file > ancestry binding to a registered session. Install the harness plugin so provenance (session id + harness/model/effort) is set for you — via env vars or the INTERIM state-file channel; see [sessions.md](sessions.md).

## Context files

`--context <file>` is repeatable; each file lands in the worktree under `.parley/context/`, materialized by **basename**.

```
parley delegate -v <vendor> -n task-a --session <id> \
  --context /path/to/config.json \
  --context /path/to/other.json \
  "<brief A>"
```

### Integrating fan-out branches

When several branches share a fork point, review each branch on its own and resolve conflicts at merge time. When tasks share files or one builds on another, prefer **dependency waves** over blind parallelism: merge task A first, then delegate task B with `--base-ref` on the freshly-merged target so it forks from its actual prerequisite.

## Beyond the golden path

One-liner pointers — read the linked file only when its condition fires:

- **Non-default task shapes** — structured `--report-schema` results, no git worktree `--cwd`, sandbox postures: read [task-shaping.md](task-shaping.md).
- **Harness plugins and session provenance** (`PARLEY_SESSION_ID` / `HARNESS` / `MODEL` / `EFFORT`): read [sessions.md](sessions.md).

## When a task fails

Check the task's `error` field first (`parley status <task> --json | jq '.error'`), then `diag.log` in its `logs_dir`, before touching the raw vendor stream — full order and what each layer means: [docs/agents/troubleshooting.md](../../docs/agents/troubleshooting.md). `parley logs <task>` is the last resort; it burns a lot of context on long tasks.

After triage, if the failure is fixable with a clearer brief, use the fix loop above (`parley fix` / `parley fix --fresh`) rather than starting an unrelated new delegate when you want a linked attempt chain.

## Reporting parley bugs

Parley is in early testing — when parley itself misbehaves (wrong state transition, lost report, worktree damage, a `PARLEY-DIAG` you can't act on), file it upstream after the triage above, whether or not you found a workaround: open an issue on [github.com/femoral/parley](https://github.com/femoral/parley) labelled `needs-triage`, body per [bug-report.md](bug-report.md). Done when the issue URL exists and you've told the user.
