# Workflow runs

`delegate` sends one brief to one child. Real work is often a pipeline: plan,
then implement, then review a few times; or search wide, funnel, validate,
adversarially review. **Workflows** let that shape be written down once as a
file, and **runs** execute it with the daemon holding the state, instead of
the orchestrator holding the whole pipeline in its context.

`parley init` (project scope) seeds three example definitions under
`.parley/workflows/`: `coding-1`, `coding-2`, and `research`. Global
definitions can live under `~/.parley/workflows`; the nearest id wins.

## The model

- A **run** holds **nodes**. A node is either a **step**, which owns one or
  more delegated tasks, or a **gate**, which spawns nothing and waits to be
  actioned.
- Nodes declare typed **ports** (inputs and outputs). Deliverables flow along
  them: text, urls, files, dirs, named enums, named schemas, in arrays or
  dicts.
- **Execution is a line; data flow is a graph.** Steps execute in declaration
  order, with two twists: **fan-out** (a step widens into parallel sibling
  tasks, either by authored slots or by reading a plural output) and bounded
  **loop-back** (a later node can send the run back to an earlier one, a
  limited number of times).
- Every task inside a run is still a normal Parley task: isolated worktree,
  same report contract, same inbox events.

## Starting a run

```bash
parley run start coding-1 --input goal="add rate limiting to the public API"
parley run start research --inputs inputs.json     # container and schema ports
parley run start coding-1 --base-ref origin/main
```

Scalar ports bind with repeatable `--input name=value`; container and
named-schema ports bind through an `--inputs` JSON file. Unbound or unknown
ports are usage errors that name the port. In practice your orchestrating
agent starts runs for you; gates are where you come back in.

## Gates: where humans decide

A gate blocks the run and lands in the attention inbox (and in the Console)
until someone actions it:

```bash
parley run approve <run>              # continue past the gate
parley run reject <run>               # follow the gate's declared on-reject path
parley run redirect <run> --to <node> # send a live blocked run elsewhere
parley run finish <run>               # complete the run at its current node
```

A terminal run (finished or cancelled) can be forked to try again from any
node without losing the parent's history:

```bash
parley run cancel <run>
parley run fork <run> --to implement --note "same plan, stricter brief"
```

## Reading a run

A run can own forty tasks; reading it should not cost forty task dumps. Four
resolutions:

```bash
parley run status                        # every run in the session
parley run status <run>                  # one run: a node table, one line per node and iteration
parley run status <run> --node review    # one node: its tasks and deliverables
parley run get <id-or-address>           # one deliverable, or a collected fan-out
```

The node table stays one line per node and iteration even when a step fanned
out 40 wide; the width is written, not drawn. `parley run get` accepts an
address (like `node.iteration.slot`) because a collected fan-out has no
single deliverable id. Exit code 9 means the address resolves but retention
already purged the value.

The Console's run detail screen renders the same projection graphically.

## Authoring definitions

Workflow files are validated by `parley lint` (also part of the seeded
project scope), which checks config, classification, rubrics, and workflows,
and warns when a local workflow shadows a global id. The seeded examples
under `.parley/workflows/` are the practical reference for the format; start
from one of them, or let `/parley-wizard` interview you into one.

Whole-run metrics and evaluation aggregate over the run's tasks; see
[Evaluation](/guide/evaluation).
