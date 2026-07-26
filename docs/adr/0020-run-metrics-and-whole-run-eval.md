# ADR-0020: Run metrics and whole-run eval are a separate report

**Status**: accepted · **Date**: 2026-07-26 · **Decided**: [#225](https://github.com/femoral/parley/issues/225) (amended by [#226](https://github.com/femoral/parley/issues/226))

## Context

`parley metrics` groups tasks by vendor, model and profile, and `parley eval`
scores one task against one rubric. A run has none of those: ADR-0016 makes a
workflow's three reviewers three *different* vendors on purpose, so bucketing a
run under `null` for `--group-by vendor` would claim it has no vendor rather than
many.

## Decision

- **Run metrics and task metrics are two reports that are never joined.** The
  split is permanent, not a v1 shortcut: even once per-node eval arrives, tuning a
  workflow stays a different question from ranking a vendor. **Comparability is an
  explicit non-goal** — shared 0–10 scale, same rubrics, same formula, never a
  shared row.
- **A run-owned task is not evaluable at all.** `evalTask` gains the ownership
  guard it has never had and rejects a task whose `run_id` is non-null, pointing at
  `parley run eval`. Three separately scored reviewer tasks *are* per-node scoring
  through the side door, so the guard is what makes that deferral honest.
- **The rubric resolves through existing machinery**: the definition declares
  `type`, the run inherits it, and `resolveRubricForTask` maps type → rubric via
  the project `taskTypes` map exactly as for a task. `parley run eval --type`
  overrides, mirroring `delegate`. **No new rubric documents.**
- **The judge reads a purely run-level artifact set**: run **inputs**, run
  **outputs** (ADR-0016), and the structural run **summary** — plus the run's final
  branch when the mode is `repo`. **No node appears anywhere in eval.** Pointing
  the judge at the terminal *node's* ports was rejected for reintroducing per-node
  eval through the side door, and a run's product is not always on its last node
  anyway.
- **Summaries are child-authored at every level.** The daemon performs no
  inference and gains no model dependency; a run summary is a structural rollup of
  child-authored gists.
- **Terminal runs only** — `completed`, `failed`, `cancelled` — the same
  precondition as `parley run fork`, so there is one rule: a dead run can be judged
  and can be forked; a live one can be neither. `blocked` is excluded because it is
  not abandoned but *waiting on the orchestrator*, and scoring it would measure
  inbox latency.
- **Grouping keys on the composite `workflow` = `id@version`**, mirroring
  `rubricGroupKey`, with `workflow` and `workflow_version` as separate filters.
  `version` is **author-declared**, and workflows — unlike rubrics — are edited
  precisely in order to be tuned, so id-only would average across the change just
  made. A content hash overcorrects: a definition is a directory, so every typo in
  `prompts/` would shatter the bucket.
- **Full dimension set**: `workflow`, `type`, `rubric`, `size`, `difficulty`, and
  the six `orch_*` / `eval_*` provenance dimensions. No `vendor`, `model`, or
  `profile`.
- **Forks split as `first_run` / `fork`**, never `fix` — that is ADR-0017's
  category error at run level. A `workflow` bucket already holds a parent and its
  fork exactly once, so the honest cost number is a new **cost-per-completed-run**
  field rather than a lineage rollup, which would double-count the parent.

## Consequences

- Pipeline health belongs to the **state counts** over all runs, live included;
  the rubric judges work quality over terminal ones. Letting a score stand in for
  "it got stuck" would blur two things that tune a workflow differently.
- `evals_by_size` / `evals_by_difficulty` already exist per group, which makes
  *"does this workflow earn its cost on hard briefs but not easy ones"* free — the
  sharpest workflow-tuning question there is.
- Baselines needed nothing: `scoreRubric` derives the baseline from the rubric's
  negative weights, and runs stay on the same rubric documents.
- Per-node eval is deferred, not designed away, and stays cheap to add: run-owned
  tasks already sit in `parley metrics` under their own vendor with an empty eval
  column, so filling it is additive, not a population migration.
- A criterion assuming a single report is answered against the run summary; a
  criterion needing the product itself is answered against the run's declared
  outputs. Neither requires forking the shipped rubric text.
