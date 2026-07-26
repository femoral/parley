# Prototype: the multi-resolution query surface

Throwaway artifact for [#222](https://github.com/femoral/parley/issues/222) on the
[workflows map](https://github.com/femoral/parley/issues/213). Not production, not read by
any code. Absorb into the ADR, then delete.

**Question:** what does the orchestrator actually read to understand a run, at each level of
detail — and can an orchestrating agent follow a run without dumping the pipeline into its
context?

Five drafted views, written in the vocabulary settled by
[#214](https://github.com/femoral/parley/issues/214) and against the workflows drafted in
[#215](https://github.com/femoral/parley/issues/215):

- [`01-run-list.txt`](01-run-list.txt) — many runs, one line each
- [`02-run-summary.txt`](02-run-summary.txt) — the default view; Research, 32 tasks, blocked
- [`03-run-summary-gates.txt`](03-run-summary-gates.txt) — gates, a live fan-out, a fork
- [`04-node-detail.txt`](04-node-detail.txt) — one node: fan-out, a lost sibling, a gate
- [`05-deliverable.txt`](05-deliverable.txt) — fetch by id; file, dir and purged cases
- [`06-query-and-surface.txt`](06-query-and-surface.txt) — filters, channels, wire types

---

## The surface the drafts imply

```
parley run status                      # list
parley run status <run>                # summary        <- the default zoom
parley run status <run> --node <id>    # node detail
parley run get <deliverable-id>        # deliverable

GET /runs · /runs/:ref · /runs/:ref/nodes/:node · /deliverables/:id
RunEnvelope · NodeProjection · DeliverableRef · DeliverableValue · RunBlock
```

CLI and daemon HTTP. **Not** the child MCP/HTTP channel (F5).

---

## What drafting exposed

### F1 — the summary's cost is `nodes × loop.max`, and that is the whole answer *(settled)*

The ticket's requirement — follow a run without dumping the pipeline into context — is met by
one rule: **one line per (node, iteration)**.

The Research run in `02` has 32 tasks, including a 6-wide and a 12-wide fan-out, and prints
10 lines at roughly 350 tokens. The same workflow with a 40-way `search` prints the same 10
lines. The summary is independent of fan-out width and of deliverable size, and grows only
with the workflow's declared shape times its loop passes.

Both of those numbers are **static in `workflow.json`**, so `parley lint` can print the
worst-case summary size before a run ever starts. That is the strongest form of the
requirement anyone asked for: not "it is usually cheap" but "here is the bound, in the file".

### F2 — a gist is three deterministic parts, and the third one is why no inference is needed

The map forbids daemon-side summarization, so the GIST column composes:

1. **enum out-ports, tallied** — `verdict=2 approve, 1 changes_requested`
2. **plural out-ports, counted** — `41 sources`
3. **the child's own `summary`, verbatim — only when the node has exactly one task**

Rule 3 is the load-bearing one. A 12-wide fan-out has twelve child-authored summaries, and
both picking one and merging them are inference. So a fan-out shows counts and you zoom to
read prose. `n/m ok` is appended wherever a sibling was lost, so absence is never silent.

**The austerity is real and worth accepting knowingly.** `validate` renders
`12/12 ok · 12 validations`, which is nearly useless — the orchestrator wants
`10 supports, 1 contradicts, 1 unreachable`, and the daemon *could* produce it, because
`validation.status` is an enum inside `types/validation.schema.json`. The draft refuses:
tallies come from **top-level enum ports only**, never from inside a named schema type.
Reaching in makes the rollup's quality depend on how deeply someone nested a field, with no
rule for which of five enum fields to tally.

The consequence is an authoring pressure the ADR should state out loud: **a step that wants a
legible summary line must declare a top-level enum out-port.** `adversarial-review` already
does (`coverage`); `validate` does not, and reads worse for it.

### F3 — the STATE column is polymorphic, and that is #214 surfacing exactly once

For a step, STATE is the projection over its tasks. For a gate, STATE is the **verb the
orchestrator used** — `waiting | approved | rejected | redirected | finished` — and TASKS,
USAGE are `-` because a gate spawns nothing.

This is the only place in the whole surface where "a node is either a step or a gate" is
visible. Everywhere else the two kinds share columns. Given #214 made that duality the centre
of the model, having it cost exactly one polymorphic column is a good outcome.

A waiting gate keeps DURATION, and that is deliberate: **how long a gate has been sitting on
the orchestrator is the most actionable number in the view.**

### F4 — a fork needs two node states, and one of them exposes a hole in #221 *(new)*

`03` renders a fork, and neither existing state fits the nodes before the entry point:

- **`inherited`** — a step whose deliverables were copied from the parent run. Renders at
  **iteration 0**, so #221's inherited-marker surfaces in the view for free.
- **`skipped`** — a gate the re-entry jumped past.

#221 only ever discussed inheriting *deliverables*, and a gate has no ports, so `approve-plan`
has nothing to inherit and needed its own word. Drafting also turned up the consequence:
**re-entering past a gate silently discards a human approval the author declared mandatory.**
`coding-1` puts `approve-plan` before `implement` specifically so no code is written unapproved,
and `reentry: "implement"` walks straight past it. The view naming it is the minimum; whether
lint should warn belongs in the ADR.

### F5 — the child channel must not get this surface *(settled)*

CLI yes, daemon HTTP yes (Cove needs it), **child MCP/HTTP no.**

A child already gets everything it is entitled to: #216 materializes its declared input ports
into `.parley/tmp/<node>.<iteration>/in/` before spawn, scoped by the author to exactly the
ports they wired. A `run_status` tool would blow that scope open — and the concrete damage is
`coding-2`, which fans out to three reviewers precisely to get three *independent* verdicts.
Let the fast-sweep reviewer read the adversarial reviewer's verdict mid-flight and the node
stops meaning what the author wrote it to mean.

### F6 — `parley run`, not `parley workflow` *(settled)*

The verb namespace already exists — #217's approve/reject/redirect/finish, #218's cancel,
#221's fork — so the query surface joins it. And the list/detail split lands on one command
because that is `parley status`'s existing shape: a ref promotes the table into a detail view.
An orchestrator that knows `parley status` knows this without being told.

`--node` is a **flag on the summary**, not a subcommand, for the same reason: it is a zoom,
and zooms are flags here.

### F7 — the block reason belongs in STATE, and there is precedent

`blocked` alone is useless when #218 gave it four causes. The list renders
`blocked (gate)`, `blocked (loop 2/2)`, `blocked (2/3 slots)`, `blocked (spawn)` — which is
exactly the shape `formatState` already uses for `queued #2 (vendor:fake)` in
`packages/cli/src/commands/tasks.ts`. No new convention.

On the wire, `block.verbs` ships the offered verb set, because #218 made it vary by reason
(no `reject` outside a declared gate) and an agent should not be re-deriving that table.

### F8 — a fan-out's `success` policy has to render its verdict, not just its counts

`04`'s second case prints `success: min 1 - MET, 2 of 3`, and keeps the failed sibling's row
while omitting its deliverable row. That is #218's "a lost sibling is an absent key, not a
null" showing up as a shorter table, and #218's explicit hand-off: approving past a thin
fan-out is a judgement call that needs the counts in front of the orchestrator.

### F9 — gate `shows` prints enum values in place of sizes

Every other deliverable listing shows a size and an id to fetch. On a gate's `shows`
projection, an enum-typed entry prints its **value** instead — `changes_requested` is shorter
than `12 B` and it is the thing being decided on. Small, but it is the difference between a
gate view you can act on and one you have to fetch from.

### F10 — what is refused, and why each refusal is cheap

- **Full-text search inside deliverables.** Children grep the materialized files; orchestrators
  pipe `parley run get`. An index would be a search engine bolted onto a task daemon.
- **Predicate queries over values** (`--where 'verdict=approve'`). The summary's tallies
  already answer the only version anyone asked for, without an expression language to
  specify, parse and version.
- **Cross-run aggregates.** That is [#225](https://github.com/femoral/parley/issues/225)'s
  surface, which already has a filter vocabulary in `METRICS_FILTER_FLAGS`.

The line: **this surface answers "what is happening in THIS run", at four resolutions.**
Aggregate is metrics; textual is grep.

---

## Raised by drafting, settled on the ticket

### O1 — the summary keeps every loop pass *(settled)*

`02` prints every `(node, iteration)`: 10 lines at `loop.max: 2`, 40 at 8 nodes ×
`loop.max: 5`. Kept anyway, because **the trajectory across passes is the judgement** — a run
blocked on loop exhaustion is being approved or redirected precisely on whether `coverage`
moved, and a collapsed view shows the second `insufficient` with no way to see it never
changed. The pathological case is self-limiting: 40 lines is ~1.4 kB of context, less than
one deliverable fetch. Pagination is available later if a real workflow makes it hurt; it is
not worth pre-paying for.

### O2 — `parley run get` takes both an id and an address *(settled)*

```
parley run get d104                  # what one task produced
parley run get r7 search.sources     # what the next node consumes
```

Not two spellings of one fetch. **The address names something the id cannot**: a fan-out
port's *collected* value (`dict<string, source[]>`, exactly what `funnel` reads) has no
deliverable row — it is a view assembled over six rows at fetch time. So the id form fetches
one sibling's contribution and the address form fetches the collection, which is the more
useful of the two when debugging why a join produced what it did. This is #215's rule 4
("collection preserves the container") surfacing in the fetch surface.

Defaults: `--iteration` latest; no `--slot` means the whole collection, not an error.

The round trip it saves (summary → zoom node for `d104` → fetch) is a real but secondary
benefit.

### O3 — no `--watch` on the run surface *(derived)*

ADR-0008 makes `parley watch` **the only wait primitive**, and #219 already added the `run.*`
event family to `--follow`. A `parley run status <run> --watch` would be a second wait
primitive, which is the one thing ADR-0008 exists to prevent. Nothing to decide.

---

## What this hands other tickets

- **[The port type system](https://github.com/femoral/parley/issues/228)** — this surface is
  its first real consumer, and needs exactly two predicates as first-class: **is this type an
  enum** (tally it) and **is this type plural** (count it). F2's austerity rule is stated in
  those terms, so #228 settling them settles the GIST column.
- **[Parley Cove](https://github.com/femoral/parley/issues/224)** — consumes
  `RunDetailResponse` unchanged; the four resolutions are the four things a UI needs panes for.
- **[Metrics and whole-run eval](https://github.com/femoral/parley/issues/225)** — owns every
  cross-run question this surface refuses (F10).
- **[Bounding a data fan-out's width](https://github.com/femoral/parley/issues/229)** — the
  summary is width-independent (F1), so the query surface puts no pressure on that bound
  either way. Worth knowing before that grilling starts.
- **[ADRs and implementation issues](https://github.com/femoral/parley/issues/227)** — the
  wire types in `06`, the `inherited`/`skipped` node states and the gate-skip warning from F4,
  and lint printing the worst-case summary size from F1.

---

## Verdict

Four resolutions, three commands, joining the `parley run` namespace the gate verbs already
opened. The requirement — follow a run without dumping the pipeline into context — is met by
a single structural rule, **one line per (node, iteration)**, whose cost is `nodes ×
loop.max` and therefore lintable from the file before a run starts.

Six things were decided by drafting these: a gist is **three deterministic parts** with prose
only on single-task nodes (F2), the node table's STATE column is **polymorphic** and that is
the only place a step and a gate differ (F3), a fork needs **two node states nobody had
named** and re-entry past a gate silently discards a mandatory approval (F4), the surface is
**denied to the child channel** because fan-out siblings must not read each other (F5), the
block reason rides **inside STATE** on the existing `queued #2 (vendor:fake)` precedent (F7),
and `parley run get` takes an **address as well as an id** because only the address can name
a collected fan-out (O2).

The one knowingly-accepted ugliness is F2's austerity: `validate` renders
`12/12 ok · 12 validations` when the orchestrator wants `10 supports, 1 contradicts`. The
daemon will not reach inside a named schema type to tally, so **legible summaries are an
authoring responsibility** — declare a top-level enum out-port, as `adversarial-review` does
and `validate` does not.
