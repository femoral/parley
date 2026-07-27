# ADR-0016: Workflows — definition, ports, and deliverables

**Status**: accepted · **Date**: 2026-07-26 · **Decided**: [#214](https://github.com/femoral/parley/issues/214), [#215](https://github.com/femoral/parley/issues/215), [#216](https://github.com/femoral/parley/issues/216), [#228](https://github.com/femoral/parley/issues/228), [#229](https://github.com/femoral/parley/issues/229), [#223](https://github.com/femoral/parley/issues/223) (amended by [#226](https://github.com/femoral/parley/issues/226))

## Context

`delegate` sends one brief to one task. Real work is a pipeline — plan then
implement then review ×n; search ×n then funnel then validate then adversarially
review — and orchestrating that by hand means the orchestrator re-reads every
child's report, re-writes the next brief, and holds the whole shape in context.
Three motivating pipelines had to be expressible without contortion, one of them
touching no repo at all.

## Decision

- **Three levels that never overlap.** A **run** holds **nodes**, one per
  declaration, for the run's whole life. A node is either a **step**, which owns
  1..n **tasks**, or a **gate**, which spawns nothing. A run stores a small
  status; a step stores none — it is a projection over its tasks.
- **Nodes declare ports** (n in, n out). Types are six **atoms** — `text`,
  `url`, `file`, `dir`, a named enum, a named schema — under two containers,
  `T[]` and `dict<string,V>`. Compared **structurally over containers, nominally
  over atoms**: the grammar is deliberately smaller than JSON Schema, which it
  compiles to. `number`/`bool` are rejected — no atom exists unless the daemon
  does a distinct job with it.
- **`url` is the one reference atom that outlives its workspace**, so it forks
  safely, renders as a link, and is dereferenceable cross-machine. Parley
  validates it syntactically and **never dereferences it**.
- **Execution is a line; data flow is a graph.** Order is declaration order,
  plus **fan-out** and **bounded loop-back** — not a general DAG. An input port
  may name any earlier node's output; `from` never points forward. Backwards
  reach resolves to that node's **most recent completed iteration**.
- **Fan-out is two mechanisms.** Authored **slots** (named siblings, each
  overriding vendor/model/profile and appending a prompt fragment) and **data**
  plurality (a scalar input reading a plural output). A data fan-out must
  **declare itself** (`over: "<port>"`) — width and keys still come only from the
  data, but the declaration makes a silent 40-way fan-out a plain type error.
  Array fan-out addresses by index, dict fan-out by key.
- **Compatibility is one comparison with two outcomes**: exact match passes
  whole; input ≡ the upstream container's element type fans out; anything else is
  a lint error. The two provably cannot both fire, so a join needs no rule of its
  own. No coercion — the key is load-bearing in a task's address (ADR-0018).
- **Bounds are declared on the producing port**, because only the producing child
  can emit fewer: `max_items` is mandatory on any container port some step
  declares `over`, and `text` carries a default-bounded `max_length`. Both
  compile into the generated report schema and are enforced by Ajv, so the
  truncate/fail trilemma never reaches the engine.
- **A deliverable is the value filling an output port**, stored as a row: an
  opaque id plus the structural address **node/port/iteration/slot**, its
  producing task, and either an inline JSON value or a path. Three kinds —
  **inline** (the overwhelming default) and **file**/**dir** as references parley
  never copies on submit. Rows share their producing task's retention clock, so
  runs decay to `purged` rather than expire.
- **Validation reuses the existing seam.** The daemon **generates a task's
  `report_schema` from its node's output ports**; the child calls `submit_report`
  once; Ajv's shape check is followed by a reference stat (exists, inside the
  workspace, non-empty). Both failures are retryable. No new child verb.
- **A workflow is a directory** — `.parley/workflows/<id>/` with `prompts/` and
  `types/`, since prompts do not survive JSON — shaped
  `{ id, version, type, workspace, inputs, outputs, types, nodes[] }`. A run
  declares **`outputs`** as well as `inputs`: a run's product is not always on
  its last node, and pointing a reader at a node would reintroduce node-level
  scope the map ruled out (ADR-0020).
- **Definitions resolve in two layers** — `~/.parley/workflows/` and a local
  layer based at `repoRoot(cwd) ?? cwd` — nearest wins by `id`, deduped when the
  two directories are the same path (cwd *is* home, or cwd is the parley home's
  parent so local `…/.parley/workflows` equals global). There is **no shipped
  layer**: built-ins are examples `parley init` copies into a project, owned and
  edited from the moment they exist.
- **`parley lint` is project-scoped.** It validates the local layer only and
  emits a **warning** (never an error) when a project workflow id also exists
  globally. It does not lint `~/.parley/workflows` from inside a project. To
  lint the global layer, run lint from the parley home's parent so the layers
  dedupe onto that directory — e.g. `cd ~ && parley lint` when home is
  `~/.parley` (or the parent of `$PARLEY_HOME` when that override is set).
- **A step's execution config is one more optional layer** on the chain
  `delegate` already has (explicit → profile → `defaults.profile` →
  `defaults.vendor` → allowlist default) — never a role indirection, never
  `task_type`. Slot config merges field-wise except `profile`, which replaces
  wholesale; the overridable set includes `sandbox`.
- **Run-start preflight** resolves every (node, slot) against the ADR-0014
  allowlist before node 1 spawns, printing the resolved table and the caps it
  will contend for. It prints and never refuses on throughput; a pinned workflow
  is deliberately non-portable and says so here.
- **The prompt stack is unchanged.** Body order: workflow prompt (opt-in) → node
  prompt → slot append → `## Orchestrator note` → `## Inputs`. **No** generated
  "you are node 3 of 5" section and **no** `## Deliverables` — the report-schema
  summary already is the contract. Inputs render type-driven: scalars inline,
  containers by path, unfilled ports omitted entirely.

## Consequences

- Inputs are **materialized into the run's ignored tmp dir** before spawn, so a
  join greps files instead of swallowing forty reports in context (ADR-0018).
- `attempt` stays reserved for `parley fix` chains — never fan-out siblings,
  never loop passes. Reusing it would make `metrics.ts` count parallel searches
  as fix retries.
- Lint can print a run's static worst case from the file: task count is
  `width × loop.max` and inline context is `per-sibling cap × width`. Both were
  false promises until bounds became mandatory.
- Opacity has a price: the daemon tallies **top-level enum ports only** and never
  reaches inside a named schema type, which makes a legible node gist an
  authoring responsibility — put the enum you want counted at the top level.
- `describeField` must render constraints and descriptions, or a child is held to
  a cap it was never told.
