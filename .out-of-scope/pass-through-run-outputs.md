# Pass-through run outputs

A workflow may not declare a run output wired straight from a run input:

```json
{
  "inputs":  { "brief": { "type": "text" } },
  "outputs": { "brief_echo": { "type": "text", "from": "run.brief" } }
}
```

Lint rejects this, and that rejection is the intended end state — not a gap
waiting to be filled.

## Why this is out of scope

ADR-0035 decided that **a run output is a view, not a stored row**: the read
path loads the run's definition snapshot, follows the output's `from`, and
resolves the underlying node deliverable. One value, one retention clock, one
resolved deliverable id, nothing materialized at completion.

A run input has no deliverable row for a view to read. So a pass-through output
is not a small extension of the shape — it is a second, differently-shaped thing
wearing the same name, and every field in the run-detail `outputs` index becomes
a special case:

- `deliverable_id` — there is no row to point at
- `address` — there is no `<node>.<port>.<iteration>` to name
- `state` — the vocabulary is `produced` / `pending` / `purged`. A run input is
  frozen at start, so it is arguably `produced` from the instant the run exists,
  and `purged` is unreachable for it. That is a fourth concept borrowing a third
  concept's word.
- the `DeliverableValue` envelope — what `kind`, `task_id` and `created_at`
  would claim is undefined

The naming collision is the deeper problem. ADR-0035 deliberately overloaded the
`run.` prefix on the grounds that refs and addresses are different grammars
pointing in opposite directions:

> `run.x` in a ref is what went *in*, `run.x` in an address is what came *out*.

A pass-through output makes one prefix mean both things in the same workflow,
which dissolves the distinction the ADR was built on.

## What to do instead

The motivating use case is real: a caller that fans several runs out over a
parameter and collects the products afterwards should not have to correlate on
run id and fetch inputs separately, when the run's inputs are frozen at start
and trivially available.

But that need is for a **run-inputs read surface**, not for smuggling inputs
through the outputs block. Inputs are already frozen and already on disk; they
need to be *readable*, not *re-declared as products*. That is the smaller and
more honest feature, and it does not require amending ADR-0035 or reverting the
lint rule added in #388.

Tracked as #399.

## Prior requests

- #389 — "feat: a run output that echoes a run input (pass-through outputs)"
