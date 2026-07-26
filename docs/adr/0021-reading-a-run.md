# ADR-0021: Reading a run — resolutions, not a dump; and a chart, not a scene

**Status**: accepted · **Date**: 2026-07-26 · **Decided**: [#222](https://github.com/femoral/parley/issues/222), [#224](https://github.com/femoral/parley/issues/224)

## Context

A run can own forty tasks. The requirement is to follow one without dumping the
pipeline into the orchestrator's context — and, on the web cockpit, without
`layout.ts` trying to scatter forty sibling islands across the sea. Both surfaces
face the same problem, and both answers turn on refusing to draw per-task.

Prototype boards live at `docs/arch/222-query-surface-prototype/` and
`docs/arch/224-cove-workflow-prototype/`.

## Decision

- **Four resolutions over three commands**, joining the `parley run` verb
  namespace ADR-0017 opened rather than inventing `parley workflow`:
  `parley run status` (every run), `parley run status <run>` (one run's node
  table), `… --node <node>` (one node's tasks), and `parley run get` (one
  deliverable).
- **One line per (node, iteration)** — never per task. 32 tasks including a
  12-wide fan-out render as 10 lines at ~350 tokens, and the same run with a 40-way
  search renders the *same* 10 lines. The bound is `nodes × loop.max`, which lint
  can print from the file before a run starts.
- **A gist is three deterministic parts**: enum ports tallied, plural ports
  counted, and the child's `summary` **only on single-task nodes** — merging twelve
  siblings' prose is the inference ADR-0020 forbids.
- **The STATE column is polymorphic**: a task projection for a step, the actioned
  verb for a gate. This is the only place the step/gate duality costs anything.
- **`parley run get` takes an address as well as an id**, because only an address
  can name a collected fan-out, which has no deliverable row of its own.
- **Denied to the child MCP/HTTP channel.** A `run_status` tool would let a
  workflow's three reviewers read each other mid-flight and stop being independent.
- **In Cove, a run is not a scene — it is a chart.** A parchment sheet pinned to
  the sea, the route inked as a dashed treasure-trail, nodes as ringed marks, the
  destination an `✕`, and **a gate as a wax seal** — whole and glowing while held,
  cracked once actioned. The first draft put runs in the sailing scene and was a
  flowchart in a nautical costume; paper is DESIGN.md's actual north star.
- **A chart writes the width rather than drawing it** (`×40 hands`) — the same
  one-unit-per-(node, iteration) rule as the CLI, which bounds the chart instead of
  bounding `layout.ts`.
- **Selection swaps the centre stage** — a run shows paper, a task shows the scene
  — rather than adding a third footer view, because the chart's route layout and
  the scene's island scatter share no key: one seeds on task id, the other
  addresses by (node, iteration).
- **A run is a roster row beside its tasks, never a group over them.** Attention
  grouping and run membership are orthogonal.
- **Cove never actions a gate.** Not because the user is a watcher, but because
  **the orchestrator is an agent** — a human clicking approve is a second hand on a
  wheel already being turned by a session that may be mid-`watch` holding an inbox
  lease. The only control is Copy run id, and the label reads "held — awaiting the
  orchestrator", never "awaiting your decision".

## Consequences

- Parchment defeats the **luminous** layer-0 state family entirely, so the chart
  needs a **second, dark ink state ramp** — a genuinely new token family, each
  glyph-paired, to place in DESIGN.md.
- `validate` reads `12/12 ok · 12 validations` where a verdict tally was wanted,
  because the daemon counts **top-level enum ports only** and never reaches inside
  a named schema type (ADR-0016). A legible summary is therefore an **authoring**
  responsibility: put the enum you want counted at the top level.
- The inspector's run view is the CLI's node table verbatim, plus a state-carrying
  spine — one projection, two surfaces.
- `file`/`dir` deliverables can only ever render as a path: their bytes died with
  the workspace, and a remote Cove has no filesystem at all. `purged` needs a
  first-class empty state or every old run looks broken.
- A fork's `inherited` should read quiet while `skipped` on a gate reads **loud**:
  it means a mandatory human approval was silently discarded (ADR-0017).
- Cove now shows, live, a thing jamming the session that it cannot clear. Accepted;
  ADR-0019's delivery breaker is the fuse.
