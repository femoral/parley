# How the orchestrator works

You will rarely type any command on this page. This is the loop your
orchestrating agent runs on your behalf, documented so you can read a session
transcript, or a Console screen, and know exactly what is going on. The
[CLI reference](/reference/cli) covers every flag.

## The loop at a glance

```bash
parley info        # the agent reads your project's effective configuration
parley session     # registers the orchestrating session once

# 1. Delegate: returns immediately with a pending task
parley delegate -v codex -m gpt-5.6-sol --effort low -n fix-flaky \
  "Fix the flaky retry test in packages/api. Done when 'pnpm test' is green."

# 2. Wait: the only wait primitive
parley watch --json

# 3. Review and integrate: the branch is the deliverable
git diff main..parley/t1-fix-flaky
parley clean t1    # removes the worktree, keeps the branch
```

## One conversation, end to end

<div class="parley-diagram">
<svg viewBox="0 0 760 470" role="img" aria-label="Sequence: the orchestrator delegates, blocks on watch, answers a child question, receives the completed report, reviews the branch, and acks the event">
  <defs>
    <marker id="sarr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 1 L 9 5 L 0 9 z" fill="#2c343b" />
    </marker>
    <marker id="sarr-soft" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 1 L 9 5 L 0 9 z" fill="#43b98c" />
    </marker>
  </defs>

  <rect class="d-box-accent" x="60" y="10" width="160" height="38" rx="8" />
  <text class="d-label" x="140" y="34" text-anchor="middle">Orchestrator</text>
  <rect class="d-box" x="310" y="10" width="160" height="38" rx="8" />
  <text class="d-label" x="390" y="34" text-anchor="middle">daemon</text>
  <rect class="d-box" x="560" y="10" width="160" height="38" rx="8" />
  <text class="d-label" x="640" y="34" text-anchor="middle">child (worktree)</text>

  <line x1="140" y1="48" x2="140" y2="455" stroke="#1a2025" stroke-width="2" />
  <line x1="390" y1="48" x2="390" y2="455" stroke="#1a2025" stroke-width="2" />
  <line x1="640" y1="48" x2="640" y2="455" stroke="#1a2025" stroke-width="2" />

  <text class="d-edge-label" x="265" y="76" text-anchor="middle">delegate -v codex "brief"</text>
  <path class="d-edge" d="M 140 82 H 386" marker-end="url(#sarr)" />

  <text class="d-edge-label" x="515" y="106" text-anchor="middle">spawn in isolated worktree</text>
  <path class="d-edge" d="M 390 112 H 636" marker-end="url(#sarr)" />

  <text class="d-edge-label" x="265" y="140" text-anchor="middle">watch (blocks)</text>
  <path class="d-edge" d="M 140 146 H 386" marker-end="url(#sarr)" />

  <text class="d-edge-label" x="515" y="178" text-anchor="middle">ask_orchestrator("which retry policy?")</text>
  <path class="d-edge-soft" d="M 640 184 H 394" marker-end="url(#sarr-soft)" />

  <text class="d-edge-label" x="265" y="212" text-anchor="middle">task.question · exit 3</text>
  <path class="d-edge-soft" d="M 390 218 H 144" marker-end="url(#sarr-soft)" />

  <text class="d-edge-label" x="265" y="246" text-anchor="middle">answer t1 "exponential, cap 30s"</text>
  <path class="d-edge" d="M 140 252 H 386" marker-end="url(#sarr)" />

  <text class="d-edge-label" x="265" y="280" text-anchor="middle">watch (blocks)</text>
  <path class="d-edge" d="M 140 286 H 386" marker-end="url(#sarr)" />

  <text class="d-edge-label" x="515" y="314" text-anchor="middle">submit_report + commits on branch</text>
  <path class="d-edge-soft" d="M 640 320 H 394" marker-end="url(#sarr-soft)" />

  <text class="d-edge-label" x="265" y="348" text-anchor="middle">task.completed · exit 6</text>
  <path class="d-edge-soft" d="M 390 354 H 144" marker-end="url(#sarr-soft)" />

  <rect class="d-box" x="46" y="372" width="188" height="34" rx="8" />
  <text class="d-sub" x="140" y="393" text-anchor="middle">review diff · merge or reject</text>

  <text class="d-edge-label" x="265" y="424" text-anchor="middle">watch --ack &lt;seq&gt; · exit 0, inbox empty</text>
  <path class="d-edge" d="M 140 430 H 386" marker-end="url(#sarr)" />
</svg>
</div>

## Watch: the attention inbox

`parley watch` is the **only** wait primitive. It blocks until the next event
that needs the orchestrator, then exits with a code that says what happened:

| Exit | Event | The agent's move |
| ---- | ----- | ---------------- |
| 3 | child asked a question | `parley answer <task> "..."` |
| 4 | task stalled | `parley answer` resumes it |
| 5 | task failed | triage, then `watch --ack <seq>` |
| 6 | task completed | review the branch, merge if it holds up, then `watch --ack <seq>` |
| 0 | inbox empty | all done |

Delivery is level-triggered and at-least-once: an already-pending event
returns immediately, and an event is redelivered until it is explicitly acked
with `watch --ack <seq>`. A crashed or restarted orchestrator session picks
up exactly where it left off. Questions that go unanswered past
`--answer-timeout` (default 30 minutes) stall the task instead of hanging it
forever.

This is why fan-out stays cheap: ten in-flight tasks still mean one blocked
`watch`, not ten polling loops.

## Sessions

`parley session` registers the orchestrating session once; every delegate
records which session owns it, and `watch` serves that session's inbox.
`--session <id>` or `PARLEY_SESSION_ID` scope commands explicitly; a known id
re-anchors after a harness restart, so the inbox survives crashes.

## Review, fix, clean

Completed work is a branch, never a merge:

- `git diff main..parley/<id>-<name>`, then merge or reject. Parley takes no
  part in this judgment.
- `parley fix <task> "<brief>"` opens a linked reattempt when review finds
  gaps. It inherits the parent's profile and workspace and resumes the
  vendor session where supported; `--fresh` starts a blank session with
  daemon-composed context instead.
- `parley clean <task>` removes the worktree and keeps the branch;
  `parley clean --all-terminal` sweeps every finished task,
  `parley gc` purges expired terminal tasks entirely (never branches).

## Inspection

- `parley status` (or bare `parley`): the task table, session-scoped.
- `parley logs <task>`: the captured vendor stream, coalesced into readable
  lines; `--json` for the raw event stream.
- `parley metrics`: aggregates by vendor, model, profile, size, difficulty,
  or type.
- `parley cancel <task>`: terminate a child.

For multi-step pipelines the same inbox carries run events too; see
[Workflow runs](/guide/workflows).
