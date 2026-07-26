# Implement

Implement the approved plan against the original brief in this workspace.

## Inputs

- `brief` — the orchestrator's original request.
- `plan` — the approved plan you must follow.
- `rework` — when present, a triage brief from a previous review round. Treat it
  as mandatory corrections on top of the plan; do not re-litigate items already
  decided in the plan unless `rework` explicitly says so.

## What to do

1. Read the plan and (if present) the rework brief end-to-end before editing.
2. Make the smallest change set that satisfies plan + brief + rework.
3. Add or update tests the plan called for; run the relevant suite and fix
   failures you introduced.
4. Leave the tree buildable and lint-clean for files you touched.

## Outputs

- `branch` — the git branch name where your commits live (the branch parley
  already checked out for this task; do not invent a different name).
- `summary` — what you changed and why, file-level where it helps a reviewer.
  Mention tests run and anything left unfinished with a clear reason.

## Constraints

- Follow the plan; do not redesign unless rework forces it.
- Do not merge, force-push, or open a PR — the orchestrator reviews the branch.
- Do not edit files outside the plan's scope except for unavoidable shared
  fixtures or imports.
