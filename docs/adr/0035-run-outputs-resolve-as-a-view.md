# ADR-0035: Run outputs resolve as a view, addressed `run.<name>`

**Status**: accepted · **Date**: 2026-08-19 · **Decided**: [#388](https://github.com/femoral/parley/issues/388)

## Context

ADR-0016 gave a workflow a top-level `outputs` block so a run's product could be
named independently of its topology — "a run's product is not always on its last
node, and pointing a reader at a node would reintroduce node-level scope the map
ruled out". The block was parsed, type-checked by lint, and retained by gc. It
was never *readable*. `parley run get run.<name>` parsed `run` as a node id, found
no such node, and reported `no deliverable at <run>/run/<name>/<n>`;
`run status --json` carried no outputs at all; and the console's run-outputs card
had a state word where the product should be. A consumer had to know the internal
node topology to fetch a result — the exact thing the block exists to prevent.
The path was previously untestable (runs did not reach `completed` before #381),
so this never worked rather than regressed.

## Decision

- **A run output is a view, not a stored row.** Nothing is materialized at
  completion. The read path loads the run's own definition snapshot, follows the
  output's `from`, and resolves the underlying node deliverable. One value, one
  retention clock, no second product to keep consistent. gc already pins declared
  outputs, so a view provably cannot dangle.
- **Readable at any run state.** A view costs nothing on an unfinished run, and
  `blocked` and `cancelled` are exactly when an orchestrator wants the partial
  product. Materializing at completion would have made those states unreadable
  and pushed the reader back to node addressing.
- **Addressed `run.<name>`.** The prefix is deliberately overloaded against
  `from`-ref `run.<input>`: refs and addresses are different grammars, and the
  two read in opposite directions — `run.x` in a ref is what went *in*, `run.x`
  in an address is what came *out*. **`run` becomes an illegal node id** (lint
  error), a change the shadowing bug it fixes justified independently: such a
  node was already unreachable by any `from` ref, silently. For the same reason
  **an output may not be wired `from` a run input**: lint accepted
  `outputs.<name>.from = "run.<input>"` and it could never resolve, because a
  run input has no deliverable row for a view to read (gc already skipped such
  a declaration when pinning declared outputs). Echoing an input into the
  product is a distinct feature, not a silently dead declaration.
- **`--iteration` and `--slot` are rejected on a run-level address**, not
  forwarded. A run output *is* the most recent completed iteration, and lint
  forbids it from fanning out, so neither flag has a meaning to carry.
  Forwarding them would let a caller construct a "run output" that is not the
  run's product.
- **Resolution uses the completed-iteration rule, not the address resolver's.**
  These differ, and the difference is load-bearing: the address resolver takes
  the max iteration in *any* state, so a node mid-loop resolves to an iteration
  with no row yet; the fill rule takes the max *completed* iteration and serves
  the last good value. A run output takes the latter — it is definitionally what
  a node placed after the last one would have read. **The node-address resolver
  is left alone**: an address asks what is at a coordinate, a run output asks
  what the product is. Iteration 0 already counts as a completed contribution,
  so a fork's inherited outputs resolve with no special case.
- **A purged latest never falls back to an older iteration.** The resolver picks
  the latest completed iteration *including* purged rows, then reports decay.
  Filtering purged rows first would silently serve a stale iteration as the run's
  product. gc retains declared outputs, so this is rare — which is precisely why
  it must not be silent when it happens.
- **Four separated failures**: an undeclared name is usage (exit 2) and names the
  declared outputs; declared-but-unproduced is **exit 10 `not_produced`**; purged
  stays exit 9; an unloadable definition snapshot is a generic failure, not
  usage. This is the argument that already justified 9 — a poller must
  distinguish "not ready" from "you typo'd" without parsing prose.
- **Two surfaces, values on one.** `run get` returns the value; `run status`'s
  **detail** response gains a values-free `outputs` index — per name: its type,
  `from`, resolved deliverable id, address, and a state of `produced` /
  `pending` / `purged` mirroring the exit taxonomy. Inlining bodies into a polled
  status would break ADR-0021's budget outright.

## Consequences

- ADR-0021's read surface gains its first resolution that takes a **name** rather
  than structural coordinates. `CONTEXT.md`'s **Address** entry carries the
  carve-out.
- Two iteration rules now coexist by design. Anyone moving to unify them should
  read the mid-loop case first: it is the reason they differ.
- `parley run eval`'s standing promise — that the judge reads run-level artifacts
  via `run status` / `run get` — becomes true with no change to eval itself.
- The console's run-outputs card can render the product's names and states,
  retiring `sealed` as a state string there (flavour is permitted in marginalia,
  not in status copy).
- Exit 10 joins the CLI's exit vocabulary; the `run get` line in `--help` grows a
  fourth code.
