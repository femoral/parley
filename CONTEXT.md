# parley — domain glossary

Parley delegates work to child agent CLIs (codex, grok) — one brief to one
**task**, or one brief to a **run** of a multi-step **workflow** — each isolated
in a parley-owned workspace and coordinated by one global daemon. The
human/agent driving parley is the **orchestrator**.

## Terms

- **Orchestrator** — the agent (or human) that writes briefs, answers child
  questions, and reviews/merges branches. Parley never merges.
- **Orchestrator session** — the grouping id (`orchestrator_session_id`,
  set via `PARLEY_SESSION_ID` env > `--session` flag > ancestry; ADR-0013)
  tying together the tasks one orchestrator run spawned. The unit of listing
  filters *and* of inbox consumption.
- **Task state** — exact vocabulary: `pending`, `running`, `awaiting_answer`,
  `stalled`, `completed`, `failed`, `cancelled`. Terminal states: `completed`,
  `failed`, `cancelled`.
- **Actionable state** — a state demanding orchestrator action:
  `awaiting_answer`, `stalled`, `failed`, `completed`. Not actionable:
  `pending`, `running` (nothing to do), `cancelled` (orchestrator caused it).
- **Pending event** — a task currently in an actionable state whose state the
  orchestrator has not yet **acked**. Identified by the transition seq that
  produced the state. At most one pending event per task (see *collapse*).
- **Inbox** — the per-orchestrator-session set of pending events, delivered
  one at a time by `parley watch` in **priority order**:
  `awaiting_answer` > `stalled` > `failed` > `completed`, FIFO (oldest seq)
  within a tier. A derived view over task states + acks, not a stored queue.
- **Ack** — the orchestrator's mark that it handled a task's current
  actionable state (`watch --ack <event-id>`). Acking a **superseded** event
  is a no-op. Delivery without ack leaves the event pending — redelivered on
  the next `watch` (at-least-once).
- **Collapse / supersession** — a task leaving an actionable state
  auto-resolves that state's pending event (e.g. answering a question consumes
  its `awaiting_answer` event); the task's *new* actionable state, if any,
  becomes its pending event. Invariant: inbox size ≤ task count.
- **All-done** — the inbox exit condition: every watched task terminal *and*
  every pending event acked. `watch` exits 0; the orchestrator loop ends.
- **Firehose** — `watch --follow`: every transition streamed as JSONL, no
  ack, no priority; for UIs and debugging, not orchestration.
- **Attention** — shorthand for the states that interrupt an orchestrator:
  `awaiting_answer` and `stalled`. Exit codes 3 and 4 on `watch`
  (the only wait primitive; ADR-0008).
- **Report envelope** — the schema-validated result object a completed task
  hands back (worktree path, branch, report body).
- **Session provenance** — the identity of the orchestrator run parley records
  for eval/traceability: session id, harness, model, effort. Injected
  deterministically by a **harness plugin** as `PARLEY_SESSION_ID` /
  `PARLEY_HARNESS` / `PARLEY_MODEL` / `PARLEY_EFFORT` (primary), or via an
  **INTERIM** session-state file under
  `~/.parley/vendors/<vendor>/sessions/<id>/state.json` when env injection is
  incomplete; never self-reported by the model. Resolution is env > state file
  > unknown for harness/model/effort, and env > `--session` > state file >
  ancestry for session id (ADR-0013). Sessions without a plugin carry explicit
  *unknown* provenance and are evaluated under an unknown bucket.
- **Launch template** — a profile's opt-in full argv replacing adapter
  composition, with shell-like `$VAR` expansion from the spawn env
  (`$PROMPT` = the task prompt). Parley still wraps the process (workspace,
  sandbox, env, child channel); the profile's vendor/model/effort become
  **declared provenance** — tracked but unverified, exempt from the model
  allowlist (ADR-0015). May name a vendor outside the adapter registry.
- **Model allowlist** — the per-vendor map of permitted model+effort combos
  (explicit efforts, optional *default* combo, optional orchestrator-facing
  *hint*). Vendors are **deny-by-default** until one is configured; every
  spawn path validates against it, rejecting out-of-list combos with a
  nearest-combo suggestion (ADR-0014). The model catalog remains advisory.
- **Model catalog / discovery** — advisory only (never gates spawn). Three
  channels feed `~/.parley/models.json` via `parley models --refresh` /
  `parley init`, in precedence **disk → probe → shipped**:
  1. **`readModels()`** — optional adapter method that reads the vendor's
     own on-disk config/state under the **operator vendor home** (no
     subprocess).
  2. **`listModels()`** — optional CLI probe (subprocess).
  3. **Shipped catalog** — point-in-time snapshot in
     `packages/core/src/shipped-model-catalog.ts`.
  Disk + probe merge is **union / richest-wins** (per-field; never shrink
  the id set). Fail-soft: bad files never crash refresh.
- **Selected model (CLI drift guard)** — optional `readSelectedModel()` on an
  adapter returns at most one model (+ optional effort) the operator has
  already chosen inside that vendor CLI. **Not a catalog channel** — never
  written to `models.json`. Surfaces only as (1) a setup allowlist pre-fill
  and (2) an advisory line on allowlist rejections when the CLI selection is
  outside the allowlist. Used by vendors that persist a selection but no
  enumerable catalog (goose, cline, openhands) (#284).
- **Operator vendor home** — the directory the *operator* uses when they run
  a vendor CLI interactively (`~/.codex`, `~/.kimi-code`, …, honouring the
  CLI's env override when set). Distinct from a **per-task isolated home**
  that adapters write into `SpawnPlan.env` for children (e.g.
  `<cwd>/.parley-kimi`, `<cwd>/.openclaw-state`). Discovery and selected-model
  reads must use the operator home and refuse parley-provisioned isolation
  markers so a delegated child cannot inject task-controlled model ids into
  the global catalog (`resolveOperatorVendorHome`, #281).
- **Harness plugin** — a per-vendor package installed into the orchestrator's
  own harness (via that harness's native hook/plugin system) that exports
  session provenance at session start (env vars and/or INTERIM state file).
  Distinct from a parley vendor **adapter** (ADR-0009), which is daemon-side
  spawn/parse plumbing.

## Workflow terms

- **Workflow** — the *definition*: a directory `.parley/workflows/<id>/`
  (with `prompts/` and `types/`) declaring `inputs`, `outputs`, named `types`,
  and an ordered list of nodes. Resolved in two layers — `~/.parley/workflows/`
  and a local layer based at `repoRoot(cwd) ?? cwd` — nearest wins by `id`,
  deduped when both resolve to the same directory. `parley lint` stays
  project-scoped: it lints the local layer and warns when a local id shadows a
  global one; to lint the global layer, run from the parley home's parent so
  layers dedupe (e.g. `cd ~ && parley lint` when home is `~/.parley`). Never a
  single execution of one; that is a *run* (ADR-0016).
- **Run** — one execution of a workflow. Holds **nodes**, stores a small status
  (`current_node`, `iteration`) and, unlike a step, a state of its own.
- **Run state** — exact vocabulary: `running`, `blocked`, `completed`,
  `failed`, `cancelled`. **`blocked` = the daemon cannot advance it** (a gate,
  loop-budget exhaustion, a spawn error); **`failed` = nobody can** (workspace
  gone, definition unparseable). A run never auto-fails (ADR-0017).
- **Node** — one declaration in a workflow, alive for the run's whole life.
  Either a **step** or a **gate**; nothing else.
- **Step** — a node owning 1..n **tasks**. Stores no status — a step's state is
  a projection over its tasks, settled on `isSettledState` (so `stalled`
  counts), never over `terminal` alone.
- **Gate** — a node that spawns nothing and waits for the orchestrator. Its
  *position in the sequence is its meaning*, which is why it is a node and not
  a flag. Carries a mandatory author-declared `on_reject` and four verbs:
  **approve / reject / redirect / finish**. Never acked — only actioned.
- **Port** — a node's typed input or output. Six atoms (`text`, `url`, `file`,
  `dir`, a named enum, a named schema) under `T[]` and `dict<string,V>`.
  Compared structurally over containers, nominally over atoms.
- **Deliverable** — the value filling an **output** port, stored as a row: an
  opaque id plus its address, its producing task, and either an inline JSON
  value or a path. Kinds: `inline` (the default), `file`, `dir` — the latter
  two are references parley never copies on submit.
- **Address** — the structural coordinates of a deliverable
  (**node/port/iteration/slot**) and, as `<node>.<iteration>[.<slot>][-r<n>]`,
  of a run's branches, scratch directories and tmp dirs. One string, read
  alike everywhere (ADR-0018).
- **Iteration** — one pass of a node. Backwards data reach resolves to a node's
  **most recent completed** iteration; iteration 0 additionally marks a node
  *inherited* by a fork.
- **Slot** — a named authored fan-out sibling, each able to override
  vendor/model/profile/sandbox and append a prompt fragment. Distinct from a
  **data** fan-out, whose width and keys come only from the data and which must
  declare itself with `over`.
- **Run inputs** — the values filling the workflow's declared **input** ports,
  bound once at run start and **frozen** for the run's life (written to
  `.parley/inputs.json` in the workspace; a fork inherits the parent's set).
  Read by `run.<name>` refs. Bound from a JSON file and/or repeated flags, the
  flags carrying scalar atoms only; validated against the compiled port schema
  *before* the run exists, so a binding error leaves nothing behind.
- **Run outputs** — the run's declared product, a top-level block naming
  earlier node ports. What `parley run eval` judges and what gc retains; a
  run's product is not always on its last node.
- **Accumulator port** — an input port declared `accumulate`, filled from *all*
  completed iterations instead of the most recent. A fill rule that never
  changes a type, so containers only; colliding dict keys resolve to the later
  iteration.
- **Workspace mode** — `repo` (run checkout + branch + checkpoints) or
  `scratch` (a parley-owned plain directory, no git). Declared on the
  definition, not overridable at run start.
- **Base ref** — what a `repo` run branches from, given as `--base-ref` and
  defaulting to `HEAD`. Recorded twice: the **ref as asked for** and the
  **commit it resolved to** at start. The resolved commit is what a fork
  rebuilds from, so a run reproduces even after the branch has moved. A
  `scratch` run refuses a base ref outright.
- **Checkpoint commit** — `parley: <node>.<iteration>`, authored by parley on a
  step settling (complete *or* failed) in `repo` mode. Parley authors commits;
  it still never merges.
- **Panicked** — a session state the daemon *enforces* (effective concurrency
  cap 0, sticky across restarts, cleared only by a human) when the delivery
  breaker trips: the same inbox event delivered n times without ack-or-action
  (ADR-0019).

## Avoided synonyms

- "queue" for the inbox (it is derived, not stored; no strict FIFO overall)
- "question" as a state name (the state is `awaiting_answer`)
- "done"/"finished" for individual states (say the exact state; *all-done* is
  only the inbox exit condition)
- "attempt" for a fan-out sibling or a loop pass (the words are *slot* and
  *iteration*; `attempt` is reserved for `parley fix` chains, and reusing it
  would make `metrics.ts` count parallel searches as fix retries)
- "workflow" for a single execution (that is a *run*), and "run" for the file
- "task_type" as a step's role selector (a step selects vendor/model/profile
  through the ordinary config chain; `type` selects a *rubric*)
- "DAG" for a workflow (execution is a line plus fan-out and bounded loops;
  only *data flow* between ports is a graph)
- "none" or "cwd" for a workspace mode (a `scratch` run has a workspace, and
  `cwd` already means something else for a single task)
- "`--base`" for the base ref (the flag is `--base-ref` everywhere, matching
  `delegate`; the short form appears only in prose that predates the surface)
- "voyage" for a run — with one carve-out: Cove's **flavour-serif** copy
  (chart marginalia, taglines) may say *voyage*, *hands*, *route*, *seal*. No
  label, column header, state string, empty-state guidance or error copy may;
  those stay `run` / `node` / `task`. Flavour is allowed to be decorative;
  status never is (ADR-0021, `packages/ui/PRODUCT.md`).
