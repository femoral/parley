# ADR-0018: Run workspaces — ownership, topology, and workspace modes

**Status**: accepted · **Date**: 2026-07-26 · **Decided**: [#220](https://github.com/femoral/parley/issues/220), [#230](https://github.com/femoral/parley/issues/230) (amended by [#226](https://github.com/femoral/parley/issues/226)) · **Amends**: ADR-0005

## Context

ADR-0005 gives every *task* a worktree it owns and auto-removes. A run breaks
every assumption in that: sequential steps must share a tree, forty siblings must
not interleave in one, a join must read a sibling's output after that sibling has
settled, and one of the three shipped pipelines touches no repo at all.

## Decision

- **The run owns every checkout and every branch in it.** Per-task auto-remove,
  per-task baselines and per-task naming all stop applying inside a run, and no
  new ownership concept is needed to say so.
- **A run-owned task is shaped exactly like a `--cwd` task**: working directory
  set, `worktree` and `branch` null. Those columns mean "parley created this for
  you", and for a run-owned task it didn't — the run did. This is what makes
  `isWorktreeModified` and per-task auto-remove skip run-owned tasks *by
  construction*, with no flag: otherwise step 1 finishing untouched would remove
  the checkout step 2 spawns into.
- **Two workspace modes, declared on the definition, default `repo`, not
  overridable at run start** — unlike the fields in ADR-0016's config chain,
  `workspace` changes what a node *means*, and flipping it would leave every
  prompt in the workflow lying about the tree it stands in.

```
repo      run checkout + run branch + checkpoints  (every coding workflow)
scratch   parley-owned plain directory, no git      (research-shaped work)
```

- **`scratch` drops git, not the workspace.** A run always has a directory,
  because ADR-0016 materializes inputs to files. It exists for **reach**, not
  cost: a research run is about a question, not a repo, and empty-branch churn
  alone would never have earned a mode.
- **`cwd` is deliberately not a third mode.** It is a third *engine*, not a third
  location: checkpoints would either land on a branch parley does not own or be
  switched off, taking retry-does-not-inherit-the-corpse with them.
- **Layout.** Branch names carry the **address**; checkout paths carry the **id**;
  scratch sibling directories carry the address, because with no branch the path
  is the only place it can live.

```
~/.parley/worktrees/<repo>/
  <runId>              run checkout   branch parley/<runId>-<workflow>
  <runId>--<taskId>    isolated sibling, branch parley/<runId>/<node>.<iter>[.<slot>][-r<n>]

~/.parley/runs/<runId>/                      scratch run workspace
  <node>.<iter>[.<slot>]/                    nested isolated sibling

<workspace>/.parley/tmp/<node>.<iter>[.<slot>]/{in,out}
```

- Two git traps shape the scheme: **a ref cannot also be a directory** (hence the
  mandatory `-<workflow>` suffix on the run branch) and **worktrees cannot nest**
  (hence sibling checkouts beside the run checkout, while scratch, having no such
  constraint, nests into one deletable subtree). Retries append `-r<n>`.
- **Isolation is read off the sandbox, not opted into.** A `read-only` sibling
  provably cannot corrupt a shared tree and stays in the run workspace; a writable
  one gets its own checkout — or, in `scratch`, its own directory. Only the noun
  changes between modes.
- **Handoff: the daemon writes `in/`, the child writes `out/`, nothing merges.**
  A cross-workspace handoff is a daemon-side copy, so ADR-0006's single writable
  root stands. The tmp path is **addressed** because a shared-workspace data
  fan-out runs n siblings concurrently in one tree; any flat layout is a race by
  construction. A join's inputs are materialized deliverables, never branches —
  where a sibling's code is wanted, the branch *name* travels as a deliverable
  value and the child uses plain git.
- **Parley authors checkpoint commits** — `parley: <node>.<iteration>` on a step
  settling, complete *or* failed. New behaviour, stated plainly; it is not a merge,
  so ADR-0005's principle stands. It exists because a retry would otherwise open
  onto the failed task's half-finished edits, and a loop would have no diff.
  Checkpoints are a **`repo`-mode behaviour**: in `scratch` the tmp address does
  both those jobs (`-r<n>` is a fresh directory; iterations are addressed).
- **Definitions resolve independently of mode** (ADR-0016), which is what lets a
  run start outside a repo at all. A `repo` workflow started outside one fails at
  run-start preflight; a `scratch` workflow started inside one ignores it, records
  `repo` as null, and refuses `--base`.
- **Retention.** In `repo` mode, run-terminal removes every checkout the run owns
  *if untouched* and prunes provably-empty branches (tip == base); **gc never
  deletes branches**, because expiring a row and destroying committed work are
  different categories of act. In `scratch` mode there is no "untouched" predicate
  — it is git on both halves — so **gc is the only owner of deletion** and a
  scratch subtree survives to the sweep, with `parley clean <run>` as the on-demand
  escape hatch.
- **gc retains a run's declared `outputs`; every other payload purges.** Without
  it, a coding run keeps its branch at day 31 while a research run's entire product
  evaporates. The rule is one sentence: **the product survives, the scaffolding
  decays.**

## Consequences

- **ADR-0005 is amended, not replaced.** Nothing in it reverses. The amendment
  carries: a workspace belongs to a **task or a run**; a run's workspace is a
  checkout *or* a parley-owned scratch directory; parley **authors checkpoint
  commits** and still never merges; `parley clean` prunes provably-empty run
  branches.
- ADR-0005's text says generated paths go in `.git/info/exclude`; the code
  deliberately does not, because `info/exclude` resolves through the *common*
  gitdir and would ignore paths in the user's real checkout. The real mechanism is
  a worktree-private `parley-exclude` wired via `core.excludesFile --worktree`.
  **A documentation bug that predates workflows, corrected here.**
- `scratch` is the only mode where a `file`/`dir` deliverable's bytes and its row
  share a lifetime, which is what lets a fork past one **copy the bytes** instead
  of erroring as it must in `repo` mode. A declared `file`/`dir` output still dies
  at gc — the row only ever held a path.
- Per-task context moves into the address, and a shared workspace gets **no
  `child.json` at all**: concurrent read-only siblings would otherwise overwrite
  each other's fixed-path `.parley/TASK.md` and `child.json`, and the walk-up
  fallback can never disambiguate siblings, so it must fail loudly.
- Cleanup only ever destroys provably-empty things, which is the difference between
  a run leaving 1 branch and leaving 41.
