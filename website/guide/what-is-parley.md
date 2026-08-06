# What is Parley

Parley turns the coding agent you already work with into an orchestrator of
other coding agents. You describe the work in plain language. Your agent writes
the briefs, delegates them to child agents (Codex, Grok, Claude Code, and
more), answers their questions while they work, and reviews every branch that
comes back. Parley is the machinery underneath: a CLI and a local daemon that
spawn, isolate, and track the whole crew.

The important inversion: **you do not operate Parley by hand**. The `parley`
CLI is a surface built for agents. Your role is to install it, point your
agent at it, and judge the results.

## The cast

<div class="parley-diagram">
<svg viewBox="0 0 780 320" role="img" aria-label="Parley architecture: you brief the orchestrating agent, it drives the parley daemon, the daemon spawns child agents in isolated worktrees, and events flow back through the attention inbox">
  <defs>
    <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 1 L 9 5 L 0 9 z" fill="#2c343b" />
    </marker>
    <marker id="arr-soft" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 1 L 9 5 L 0 9 z" fill="#43b98c" />
    </marker>
  </defs>

  <rect class="d-box" x="16" y="122" width="104" height="76" rx="10" />
  <text class="d-label" x="68" y="156" text-anchor="middle">You</text>
  <text class="d-sub" x="68" y="176" text-anchor="middle">the human</text>

  <path class="d-edge" d="M 120 160 H 176" marker-end="url(#arr)" />
  <text class="d-edge-label" x="148" y="148" text-anchor="middle">brief</text>

  <rect class="d-box-accent" x="180" y="110" width="176" height="100" rx="10" />
  <text class="d-label" x="268" y="152" text-anchor="middle">Orchestrating agent</text>
  <text class="d-sub" x="268" y="172" text-anchor="middle">your main harness</text>

  <path class="d-edge" d="M 356 148 H 424" marker-end="url(#arr)" />
  <text class="d-edge-label" x="390" y="100" text-anchor="middle">delegate · answer</text>
  <path class="d-edge-soft" d="M 424 184 H 356" marker-end="url(#arr-soft)" />
  <text class="d-edge-label" x="390" y="226" text-anchor="middle">attention inbox</text>

  <rect class="d-box" x="428" y="110" width="148" height="100" rx="10" />
  <text class="d-label" x="502" y="152" text-anchor="middle">parley daemon</text>
  <text class="d-sub" x="502" y="172" text-anchor="middle">local · sqlite state</text>

  <path class="d-edge" d="M 576 138 C 610 128 622 84 650 66" marker-end="url(#arr)" />
  <path class="d-edge" d="M 576 160 H 650" marker-end="url(#arr)" />
  <path class="d-edge" d="M 576 182 C 610 192 622 236 650 254" marker-end="url(#arr)" />
  <path class="d-edge-soft" d="M 650 88 C 626 104 614 132 580 144" marker-end="url(#arr-soft)" />
  <path class="d-edge-soft" d="M 650 276 C 626 260 614 188 580 176" marker-end="url(#arr-soft)" />

  <rect class="d-box" x="654" y="26" width="112" height="64" rx="10" />
  <text class="d-label" x="710" y="54" text-anchor="middle">Codex child</text>
  <text class="d-sub" x="710" y="72" text-anchor="middle">worktree 1</text>

  <rect class="d-box" x="654" y="128" width="112" height="64" rx="10" />
  <text class="d-label" x="710" y="156" text-anchor="middle">Grok child</text>
  <text class="d-sub" x="710" y="174" text-anchor="middle">worktree 2</text>

  <rect class="d-box" x="654" y="230" width="112" height="64" rx="10" />
  <text class="d-label" x="710" y="258" text-anchor="middle">Any harness</text>
  <text class="d-sub" x="710" y="276" text-anchor="middle">worktree N</text>

  <text class="d-edge-label" x="612" y="228" text-anchor="middle">questions · reports</text>
</svg>
</div>

| Role | Who | What it does |
| ---- | --- | ------------ |
| You | a human | Describe the work, set the guardrails, judge the merged result |
| Orchestrator | the agent you already use | Writes briefs, delegates, answers questions, reviews branches |
| Daemon | a local background process | Spawns children, isolates worktrees, tracks state in sqlite |
| Children | any supported coding agent | Do the work in their own worktree, report back when done |

## What a task looks like

1. You tell your agent something like *"split this refactor into three parts
   and farm it out"*.
2. The agent runs `parley delegate` once per brief. Each child gets its own
   git worktree and its own branch, so parallel tasks never collide.
3. The agent blocks on `parley watch`, the single wait primitive. It wakes up
   only for the events that matter: a child asking a question, a stall, a
   failure, or a completed report.
4. Finished work lands as a branch (`parley/<id>-<name>`). The agent reviews
   the diff, merges what holds up, and opens a linked fix attempt
   (`parley fix`) for anything that does not.

Parley never merges anything itself. Judgment stays with the orchestrator, and
ultimately with you.

## Why it works

- **Isolation by construction.** Every child works in a parley-owned worktree
  cut from your repo. Fan-out is safe because nothing shares a working copy.
- **One wait primitive.** There is exactly one way to wait
  (`parley watch`), with level-triggered, at-least-once delivery. No polling
  loops, no missed events.
- **Vendor agnostic.** One interface over every supported harness, with
  sandbox postures declared honestly per vendor, and a
  [public adapter contract](/reference/adapter-authoring) for your own.
- **Accountable.** Every task records tokens, duration, profile, and
  classification. `parley metrics` and [the Console](/guide/console) slice the
  aggregates.

## Where to go next

- [Installation](/guide/installation): get the CLI and the Console.
- [Getting started](/guide/getting-started): `parley init`, then hand the
  keys to your agent.
- [How the orchestrator works](/explainer/how-the-orchestrator-works): the
  delegation loop your agent runs, explained.
