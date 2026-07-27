# ADR-0022: Run start — input binding, frozen base, check-then-commit

**Status**: accepted · **Date**: 2026-07-27 · **Decided**: [#249](https://github.com/femoral/parley/issues/249) · **Extends**: ADR-0018 · **Related**: ADR-0008, ADR-0016, ADR-0017

## Context

After the run engine, preflight, workspaces, gates, and fork landed, nothing
could create a *first* run. `insertRun` had a production caller only on the
fork path, which requires a terminal parent. The five open decisions at run
start — how inputs are bound, what validation runs before anything exists,
ordering of fallible work vs commit, what `--base-ref` means, and return
posture — were settled in triage for #249.

## Decision

### CLI and HTTP surface

- `parley run start <workflow>` creates and enters a run. Workspace mode is
  declared on the definition and is **not** overridable at start (ADR-0018).
- HTTP: `POST /runs` with `{ workflow, cwd, inputs?, input_flags?, base_ref?,
  orchestrator_session_id? }`.
- Workflow resolution reuses the existing two-layer discovery (nearest wins by
  id). No second path.

### Input binding

Two layers, merged by port name with the **flag winning**:

- `--inputs <file>` — a JSON object keyed by port name. The only way to bind
  container (`T[]`, `dict<string,V>`) and named-schema ports.
- `--input <name>=<value>` — repeatable, binds **scalar atoms only** (`text`,
  `url`, `file`, `dir`, named enum). A flag aimed at a container or named-schema
  port is a usage error that names the port, its declared type, and points at
  `--inputs`. The flag never sniffs whether its value looks like JSON.
- Binding an undeclared port, or leaving a declared port unbound, is a usage
  error naming the port(s).

### Validation before the run exists

Compile the declared input ports with the existing port-type compiler and
validate the merged object with Ajv, then stat `file`/`dir` referents (exists,
correct kind, non-empty). Same two-stage seam ADR-0016 specifies for reports;
no second hand-rolled validator.

### Ordering — check first, then commit

```
phase 1   resolve workflow → parse → bind and merge inputs
          → Ajv validate → stat referents → preflightRunStart
          failure ⇒ clean exit; no run row, no workspace, no branch

phase 2   create workspace → insertRun → write frozen inputs → enter node 1
          failure ⇒ a `failed` run row carrying the error
```

The asymmetry is deliberate: a phase-1 failure is a bad invocation and should
vanish; a phase-2 failure has a workspace on disk worth diagnosing. The fork
path is the template for phase 2 (minus inheritance, plus input binding and
preflight).

### Base ref

- Flag name is `--base-ref` (matching `delegate`), not `--base`.
- Optional; defaults to `HEAD` for `repo` mode.
- Resolved to a concrete commit at start. **Both** the ref as asked for and the
  commit it resolved to are recorded on the run (`base_ref`, `base_commit`), so
  a fork weeks later can rebuild from the same commit even if the branch has
  moved.
- A `scratch` run refuses a base ref through the existing preflight refusal
  (`preflightScratchRun`); start does not reimplement it.
- This **extends ADR-0018**: the frozen base commit is the durable baseline for
  the run checkout, not only a create-time argument.

### Return posture

`start` returns as soon as phase 2 commits, printing the run id and entered
node. Observation is `parley watch` / `parley run status`, consistent with
ADR-0008. No `--wait`, no foreground blocking.

## Consequences

- The run engine is reachable end-to-end without tests calling `insertRun` or
  workspace helpers directly.
- Fork's own base-ref derivation still uses the parent branch tip; switching it
  to the newly recorded `base_commit` is a deliberate follow-up behaviour change
  and is out of scope for #249.
- Inputs are frozen at start; there is no re-bind after the run exists.
- `preflightRunStart` gains its first production caller; its signature is
  unchanged.
