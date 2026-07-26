# Implement

Implement the orchestrator's brief directly in this workspace. There is no
separate planning step — the brief *is* the spec.

## Inputs

- `brief` — the full request: goal, constraints, acceptance criteria.
- `rework` — when present, a triage brief from a previous review round. Treat it
  as mandatory corrections; do not re-open decisions the rework brief settles.

## What to do

1. Read the brief and (if present) the rework brief end-to-end before editing.
2. Make the smallest change set that fully satisfies them.
3. Add or update tests for the new behavior; run the relevant suite and fix
   failures you introduced.
4. Leave the tree buildable and lint-clean for files you touched.

## Outputs

- `branch` — the git branch name where your commits live (the branch parley
  already checked out for this task; do not invent a different name).
- `summary` — what you changed and why, file-level where it helps a reviewer.
  Mention tests run and anything left unfinished with a clear reason.

## Constraints

- Prefer existing project patterns over inventing new architecture.
- Do not merge, force-push, or open a PR — the orchestrator reviews the branch.
- Stay inside the brief; do not expand scope.
