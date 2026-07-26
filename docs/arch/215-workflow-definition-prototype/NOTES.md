# Prototype: the workflow definition file

Drafted for [#215](https://github.com/femoral/parley/issues/215) on the
[workflows map](https://github.com/femoral/parley/issues/213), and **refreshed at the end
of the map** against everything settled after them. Still not read by any code — but no
longer throwaway: [#230](https://github.com/femoral/parley/issues/230) ruled that parley
ships **no** shipped-workflow resolution layer, so these three become the seed examples
`parley init` copies into a project, which the user then owns and edits.

The design they informed is now ADR-0016 (definition, ports, deliverables), ADR-0017 (the
run engine), ADR-0018 (workspaces), ADR-0019 (inbox), ADR-0020 (eval), ADR-0021 (reading a
run). Where this file and an ADR disagree, **the ADR wins** — the record below of what
drafting exposed is kept as history, not as the spec.

**Question:** what does a workflow definition file actually declare?

Three drafts, written in the vocabulary settled by
[#214](https://github.com/femoral/parley/issues/214):

- [`coding-1/workflow.json`](coding-1/workflow.json) — plan → gate → implement → review ×3 → triage, **unattended** rework loop
- [`coding-2/workflow.json`](coding-2/workflow.json) — implement → review ×3 (three vendors) → triage → gate, **orchestrator-decided** rework loop
- [`research/workflow.json`](research/workflow.json) — scope → search ×n → funnel → validate ×n → adversarial review, loop back to scope

Prompt bodies are stubbed except [`coding-1/prompts/review.md`](coding-1/prompts/review.md)
and [`coding-1/prompts/review/correctness.md`](coding-1/prompts/review/correctness.md),
which exist to show the base-plus-slot prompt layering concretely. The two JSON Schema
types under [`research/types/`](research/types/) are real.

---

## What the refresh changed

Each line is a later ticket landing on the drafts. Nothing here was a drafting mistake —
these are decisions made after the drafts were written.

| change | why |
|---|---|
| `worktree: "own"` **deleted** from every fanned-out step; `sandbox: "read-only"` declared instead | [#220](https://github.com/femoral/parley/issues/220) reads isolation off the sandbox, and [#223](https://github.com/femoral/parley/issues/223) made `sandbox` slot-overridable, so a second switch would contradict it — F9's "it wants to be the default" was right, and the default is now derived |
| top-level `type` | [#225](https://github.com/femoral/parley/issues/225): the run inherits it and it resolves the rubric through the existing `taskTypes` map |
| top-level `workspace` | [#230](https://github.com/femoral/parley/issues/230): research declares `scratch` and needs no repo at all |
| top-level `outputs` | [#226](https://github.com/femoral/parley/issues/226): a run's product is not always on its last node, and eval may not bind to one |
| `over` on `search` and `validate` | [#228](https://github.com/femoral/parley/issues/228): a data fan-out declares itself, which makes **F5's silent 40-way fan-out a plain type error** |
| `max_items` on `scope.queries` and `funnel.shortlist`; `max_length` on the big `text` ports | [#229](https://github.com/femoral/parley/issues/229) and #223: bounds live on the **producing** port, so lint can finally print the worst case F9 and F5 both wanted |
| `accumulate: true` on `funnel.harvest` | #226: without it the loop's broadening pass **replaced** the evidence instead of adding to it, and the report rested on pass 2 alone |
| `success: { min: 3 }` on `search` | [#218](https://github.com/femoral/parley/issues/218)'s data default is `{min: 1}`, which would build a shortlist from an eighth of the harvest |
| `on_reject` on both gates | [#217](https://github.com/femoral/parley/issues/217): a gate is a decision, so its "no" branch is mandatory and author-declared |
| `retries: 1` on both `implement` steps | #218: opt-in per step, default 0, and a fresh task rather than a fix attempt |
| research `validate` splits `verdict` (enum) out of the `validation` schema | [#222](https://github.com/femoral/parley/issues/222) tallies **top-level enum ports only**, so the run's most informative count was invisible inside a named type |

Two things the drafts asked for that were answered elsewhere and need no file change: F2's
"can a step do both?" is a lint **error** (#228), and F1's loop-payload rule survived
verbatim — though #226 had to exempt a `from`-less port from #217's ports-filled gate,
without which `scope.gaps` deadlocks the run at node 1.

---

## The schema the drafts imply

Superseded by ADR-0016; kept because the rules below explain *why* each field exists.

```
workflow  := { id, version, type, workspace, description,
               inputs, outputs, types, nodes[], reentry? }
node      := step | gate
step      := { id, kind:"step", task_type?, profile?|vendor?+model?+effort?,
               sandbox?, prompt, slots?, over?, success?, retries?,
               in{}, out{}, loop? }
gate      := { id, kind:"gate", question, shows{}, on_reject, loop? }
slot      := { profile?|vendor?+model?+effort?, prompt_append? }
in-port   := { type, from?:"<node>.<port>" | "run.<input>" }
out-port  := { type }
loop      := { to:"<node id>", max, while?:{ port, is }, with?:{ port: "<node>.<port>" } }
```

### Nine rules

1. **Execution order is declaration order.** `nodes` is a list; the daemon walks it. No
   `next` pointers, no edges to read.
2. **`from` only ever points backwards.** Wiring is `<node>.<port>`; the reserved node id
   `run` exposes the workflow's own `inputs`, so the brief needs no special syntax. Data
   flow is a graph over a linear execution order — `triage` reads `plan.plan` three nodes
   back, `adversarial-review` reads `scope.queries` four nodes back — but never forwards.
3. **Fan-out has two sources, and only one of them is a port type.**
   - **Authored** — the step declares `slots`, a named map of siblings, each optionally
     overriding `vendor`/`model`/`effort`/`profile` and appending a prompt fragment. The
     slot names *are* the fan-out container. Used by `review` in both coding workflows.
   - **Data** — no `slots`; a scalar input port reads a plural upstream output port.
     Plural source + scalar input ⇒ one task per element. Width and keys come from the
     deliverable. Used by `search` and `validate` in Research.

   Same shape on both sides ⇒ one task, and if that shape is plural the step *is* the
   join. `funnel` and `triage` are joins; neither says so.
4. **Collection preserves the container.** A fanned-out step's outputs come back wrapped
   in the container it fanned over. `review` fans over authored slot names, so
   `review.verdict` reads downstream as `dict<string, verdict>` keyed by slot. `validate`
   fans over `source[]`, so `validate.verdict` is `validation[]`. Nothing is flattened:
   `search` yields `source[]` per task and collects to `dict<string, source[]>`, which is
   what lets `funnel` say which query found what.
5. **A gate has no ports.** It spawns nothing, so it produces nothing. `shows` is a
   read-only projection of upstream deliverables; `question` is what the orchestrator is
   being asked. Its position in the list is its meaning.
6. **Loops hang off the node that decides.** On a **step**, `while` tests a named output
   port — unattended (`coding-1`, `research`). On a **gate**, there is no `while`: the
   orchestrator's answer is the condition (`coding-2`). `to` names the node to resume at;
   `max` bounds the passes.
7. **A loop edge carries its own payload.** `loop.with` fills named input ports on the
   target node — `implement.rework`, `scope.gaps`. Those ports are declared with a type
   and **no `from`**, which is exactly what marks them loop-filled: empty on pass 1, no
   `optional` keyword needed anywhere in the schema.
8. **A step without `slots` has one implicit slot.** The degenerate case of rule 3, which
   is why `plan`, `implement`, `triage` and `funnel` need no extra notation.
9. **`reentry` defaults to the first node** — and none of the three drafts set it, which
   is worth noticing on its own.

---

## What drafting exposed

### F1 — a loop's backwards data flow belongs on the loop, not on a port *(settled)*

The rework brief has to reach the *next* implementation pass, and the node that writes it
(`triage`) is declared after the node that reads it (`implement`). Wiring it as an input
port would have meant an input pointing forwards, and #214's "any earlier node's output
port" would have had to be restated as a temporal rule ("any port filled before this node
runs") plus an `optional` flag for pass 1.

**Settled on #215: the loop edge carries the payload.** `loop.with` names the ports it
fills on its target. `from` keeps pointing strictly backwards, #214's rule survives
verbatim, and `optional` never has to exist — a port declared with a type and no `from` is
self-evidently loop-filled. The cost is a second way to fill a port, which lint has to
cover: a `from`-less input port that no `loop.with` targets is an error, and so is a
`loop.with` naming a port that already has a `from`.

### F2 — fan-out siblings are not homogeneous, so multiplicity is *not* purely a port type

The sharpest thing the drafts surfaced. `coding-2`'s three reviewers run on three different
vendors with three different appended instructions. That variation is **execution config** —
vendor, model, effort, profile, prompt layer — and no upstream deliverable should be
choosing it: a child that picks its own siblings' vendors is routing around the model
allowlist (ADR-0014) and the project's profile config.

But Research's `search ×n` genuinely *is* data-driven: the width is however many queries
`scope` produced, and nobody can author that in advance.

Hence rule 3's two mechanisms. Consequences:

- **Authored width is static.** It lints, it renders in `parley info`, and a run can be
  planned against concurrency caps before it starts.
- **Data width is dynamic and unbounded.** Nothing in the file caps it; a `scope` step that
  emits forty queries spawns forty tasks. Needs either a `max_fanout` on the step or an
  explicit cap interaction — the map already has concurrency caps in fog.
- **Can a step do both?** Slot names × data keys is a cross product, and the collection key
  becomes a pair. Ruled out for v1 in these drafts; worth an explicit "no" in the ADR.
- The per-slot `prompt_append` layers onto the existing compounding prompt stack
  (protocol preamble → `PROMPT.md` layers → step `prompt` → slot `prompt_append`). That
  ordering belongs to [#223](https://github.com/femoral/parley/issues/223).

### F3 — the `×n` in the motivating examples means parallel siblings *(settled)*

Settled on #215: n parallel reviewers on possibly different vendors/profiles, not n
sequential rounds. So each coding workflow carries a fan-out **and** a loop, and needs an
explicit `triage` join to turn n verdicts into one decision. The loop bound and the
fan-out width are independent numbers.

### F4 — plurality composes, so the type system must too

`dict<string, source[]>` appears in `research` and is not exotic — it is just what rule 4
produces. [#228](https://github.com/femoral/parley/issues/228) therefore has to deliver
container composition, not a flat list of types. The drafts need: scalar builtins (`text`),
enums declared inline (`verdict`, `coverage`), named types backed by JSON Schema files
(`source`, `validation` — reusing the existing `report_schema` seam in
`packages/core/src/contract.ts`), `T[]`, `dict<K, V>`, and a **shape-comparison** relation,
because data fan-out is a type check.

### F5 — a join is invisible

Rule 3 is elegant but silent: nothing in `funnel` says "I am a join." A typo in a type
(`source` instead of `source[]`) silently turns a join into a 40-way fan-out. Lint must
surface the inferred plan.

### F6 — a workflow is a directory *(settled)*

Prompts do not survive JSON, and authored slots multiply the fragments, so `prompt` is a
path and a workflow drags files along with it.

**Settled on #215: `.parley/workflows/<id>/` holds `workflow.json` plus `prompts/` and
`types/`.** The id is the directory name; paths inside the file are relative to it. A
workflow is one self-contained, copy-pasteable unit — at the cost of the flat
one-file-per-id symmetry with `.parley/rubrics/<id>.json`, and of type schemas being
per-workflow rather than shared.

Follow-on: the `id` field inside `workflow.json` is now redundant with the directory name.
Rubrics have the same redundancy and lint warns on mismatch (`project-lint.ts`); do the
same here.

### F7 — a gate on a loop-back edge needs no new notation *(settled)*

The ticket asked for a gate somewhere non-obvious. `coding-2` puts one **last**, with the
loop hanging off it — so it is entered only at the end of each pass, and answering it is
what sends the run back to `implement`. Confirmed on #215.

The rejected alternative: declare the gate *before* `implement` and add a workflow-level
`start` field so pass 1 skips it. That works, but needs a second position marker alongside
`reentry` and reads backwards.

What the gate's answer *is* — approve / redirect / finish, and how "finish here" ends a run
that has unreached nodes — belongs to [#217](https://github.com/femoral/parley/issues/217)
and [#218](https://github.com/femoral/parley/issues/218).

### F8 — loop conditions read ports, not outcomes

A review task that finds twelve bugs still ends `completed`. Task outcome carries no
signal about whether the loop should take, so `while` tests a **named output port** with an
enum type. The cost is that every unattended loop needs a step whose deliverable is a
decision — which is what `triage` and `adversarial-review` are for.

### F9 — per-node execution settings

`profile` on most nodes; `coding-2`'s review slots pin `vendor` + `model` + `effort`
explicitly to show both forms, and slot config overrides step config. `task_type` feeds
the existing classification/rubric machinery. `worktree: "own"` is the map's opt-in for
fan-out siblings — every fanned-out step in these drafts sets it, which suggests it wants
to be the *default* for fan-out rather than an opt-in.

Absent on purpose: `size`, `difficulty` (per-task metrics classification — does a node
declare them, or does the run?), `answer_timeout`, `runner`, sandbox posture.

### F10 — relation to the rest of `.parley/`

Workflows are **id-addressed documents** like `rubrics/*.json`, not a layered settings
section like `config.json` — nothing about a pipeline wants deep-merging with a global
layer. `parley lint` extends naturally, reusing `LintFinding`'s `file`/`field`/`message`
shape:

- **errors** — duplicate node or slot id; `from` naming an unknown node/port or a later
  node; `loop.to` not an earlier node; `loop.max` < 1; `while` naming a non-enum or
  unknown port; `loop.with` naming a port that already has a `from`; a `from`-less input
  port no `loop.with` fills; a gate declaring `in`/`out`/`slots`; an unresolvable type; a
  slot naming a vendor/model outside the allowlist; `slots` combined with a data fan-out
  on the same step; `id` not matching the directory name (warning, per F6).
- **warnings** — a plural output no node ever joins (F5); a step with no `out` ports; a
  `while` case the enum can never produce; an unreachable node; a data fan-out with no
  width bound.

Lint should also **print the inferred plan** — which steps fan out, how, over what, and
where they join — because that is the part the file does not say out loud.

---

## Verdict

Three files a reader can follow without a spec, and the schema above is what they imply.
Four things were decided by drafting them: fan-out is **two mechanisms** (authored slots
and data plurality), a loop **carries its own payload** so ports never point forwards, a
workflow is a **directory**, and a **gate placed last** is how a loop-back edge gets gated.

Open, and belonging to other tickets: the type system (#228), gate answer semantics
(#217/#218), prompt-stack ordering (#223), and a width bound for data fan-out (concurrency
caps, still in fog).
