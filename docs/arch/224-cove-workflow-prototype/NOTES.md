# Prototype: Parley Cove's view of a running workflow

Throwaway artifact for [#224](https://github.com/femoral/parley/issues/224) on the
[workflows map](https://github.com/femoral/parley/issues/213). Not production, not built
by the app, not read by any code. Absorb into the ADR, then delete.

**Question:** how does Cove show a running workflow — a thing that is ordered, branching,
and partly waiting on someone else — without inventing a second navigation model beside
the task-centric cockpit that already exists?

Open `index.html` over http (`python3 -m http.server` from the repo root); it links the
real `packages/ui/src/tokens/tokens.css` and the real self-hosted faces, so every colour,
radius and type step below is the shipped token, not an approximation.

Five boards:

- **1** — the chart: a run drawn as a route on aged paper, with a broken seal behind it and a loop-back arcing over the route
- **1b** — the same paper with a seal still **held**, and a forty-wide fan-out on one mark
- **2** — roster and inbox: runs and plain tasks coexisting, and a gate surfaced but **not** actionable
- **3** — the inspector's run view: one line per (node, iteration), plus deliverable browsing
- **4** — a fork: inherited, skipped, and superseded nodes

---

## The surface the boards imply

```
chart      run  → a route inked on aged paper, pinned to the sea
           node → one mark per (node, iteration); fan-out width is WRITTEN beside the
                  mark (×40 hands), never drawn as n marks
           gate → a wax seal on the route: whole and glowing = held, cracked = answered
           state→ carried by ink tone + a glyph: ✓ sailed, ✦ under way, ? ahead, ✕ blotted
roster     a run is a row beside its tasks, with a pip track; run-owned tasks
           wear a run chip (7f3a · review.2.tests) in their meta line
inbox      two subject kinds: Gate cards and Question cards (ADR-0007 widened by #219)
           — surfaced only; no verb in the UI (F3)
inspector  run view (node × iteration table) · deliverable view · lineage
```

---

## What drafting exposed

### F1 — the run view is paper, and the fan-out's width is *written* not drawn *(settled)*

The first draft put a run in the sailing scene: islands in declaration order joined by a
rhumb line. It was legible and completely dull — a flowchart wearing a nautical costume,
and a betrayal of DESIGN.md's own north star, which is not "a scene with ships in it" but
**"The Weathered Chart-Room"**: an aged chart you keep open.

**Settled: a run is drawn on paper.** A parchment sheet pinned to the deep-teal sea; the
route inked as a dashed treasure-trail; nodes as ringed marks; the destination an ✕; the
loop-back a longer-dashed arc curving back over the route with an arrowhead; a compass
rose, rhumb lines, a sea serpent and hand-lettered marginalia in the empty quarters. The
flavour lives entirely in the *paper* — every operational label stays Outfit and every id
stays mono, so the Flavor-Font Rule holds with room to spare.

The fan-out question the first draft agonised over dissolves on paper. A chart doesn't
draw forty ships; it writes a number. **One mark per (node, iteration), with the width in
a tally chip beside it** (`×40 hands`, `×3 slots`). This is the same rule #222 settled for
the text summary — one line per (node, iteration) — so the chart's size is bounded by
`nodes × loop.max`, the static number lint can already print, and a `search ×40` renders
exactly as large as a `search ×1`.

What the chart gives up, and should: it is no longer where you watch an individual agent
work. That is the roster's job, and the roster keeps it.

### F1b — a paper surface forces a second state ramp *(new token proposal)*

Layer 0's state family is luminous by design, tuned to glow on plate wood (`#1d140c`).
None of it clears WCAG AA on parchment (`#efe0bd`) — Running Green on paper is a pale
smear. So the chart needs a **second state ramp in the same warm-on-cold system**: dark
inks rather than lights. The mock proposes five, and they are the only new tokens it asks
for:

```
--ink-chart        #5b3a24   the pen the whole map is drawn in
--ink-chart-soft   #7d5636   older ink — answered gates, marginalia
--ink-chart-ghost  #b39a76   not yet sailed
--ink-live         #a8331f   fresh vermilion — under way
--ink-done         #4a5f38   dried olive — sailed
--ink-fail         #8f1d12   a blot
```

Every one is paired with a glyph (`✓ ✦ ? ✕`) and repeated in an on-paper key, so the
State-Colour Reservation's second-cue requirement holds. Worth deciding in #227 whether
these are a `chart` sub-family of the state tokens or a genuinely separate ink palette.

### F2 — the paper is a centre-stage swap, not a new navigation model *(settled)*

The first draft's problem was that a course needs *ordered* positions while `placeIslands`
(`packages/ui/src/scene/layout.ts`) is a deterministic **scatter** whose docs state
placement is "never a pure function of array index alone." Moving the run onto paper
doesn't dissolve that — it relocates it. The chart is laid out by its route, the sailing
scene by the scatter, and the two share no key: the scatter seeds on **task id**, the chart
addresses by **(node, iteration)**.

**Settled: selection swaps the centre stage.** Select a run in the roster and the paper
replaces the Cove scene; select a plain task and the scene returns. No third footer view,
no new navigation — selection is already the roster's one verb, and the ticket's
requirement was precisely that runs coexist without a second navigation model.

Rejected: a third footer view beside Cove / Soundings (explicit, but three views is where
a cockpit starts feeling like an app), and putting the paper in the 344px inspector rail
(nowhere near enough paper).

The accepted cost: the ambient scene disappears while you are reading a run, and "leave it
open all day" is partly about that scene being there. Two follow-ons for implementation —
what the centre stage shows when *nothing* is selected (unchanged: the scene), and that the
Soundings toggle now switches away from whichever of the two is currently mounted.

### F3 — Cove never actions a gate, because the orchestrator is an agent *(settled)*

The ticket called a gate "the one place Cove is genuinely actionable," and the first draft
drew four buttons — approve / reject / redirect / finish, #217's verbs — to have something
concrete to argue with.

**Settled: no verbs in the UI.** The reason is stronger than the product-register one I
first reached for (PRODUCT.md's "they are watching, not driving"). It is that **the
orchestrator is an agent, not the person looking at the cockpit.** A human clicking
*approve* would be a second hand on a wheel already being turned: the orchestrator may be
mid-`watch`, holding an inbox lease, about to issue its own verb. Two actors racing one
gate is a conflict the design can simply not create.

So the gate card shows the question, its `shows` ports, how long it has been held, and a
plain statement that the helm belongs to the orchestrator. The only control is **Copy run
id** — copying is not an action on the run. Board 2's language was scrubbed accordingly:
"awaiting *your* decision" became "held — awaiting the orchestrator", because a label that
implies a verb is as misleading as the button would have been.

The cost is real and worth writing into the ADR: per #219 a gate is never acked, only
actioned, and one undecided gate blackholes the session inbox until the delivery breaker
trips a `panicked` session. **Cove therefore shows the user, in real time, a thing jamming
their session that they cannot clear from this surface.** That is the honest trade, not an
oversight — and it makes the `panicked` state's visibility in Cove (#219) more important,
not less.

### F4 — a run is a roster row, not a roster group

The tempting shape is a collapsible tree: run header, tasks nested beneath. It breaks the
roster's founding rule. Grouping is by **attention state** (`ATTENTION_DISPLAY_ORDER`), and
a run's tasks are routinely in three different states at once — so nesting them under one
run header would either fragment the run across three groups or defeat attention ordering.

Board 2 keeps the flat state groups and adds the run as its **own row** in whichever group
its own state puts it (`blocked` sits with awaiting, per #219 folding run events into the
existing four tiers). Its tasks stay in their own groups, wearing a run chip. A run and its
tasks are peers in the list, which is exactly what #219 meant by "a run is an inbox subject
beside the task."

The pip track on the run row is `nodes × loop.max` pips — the same static bound again, so
the row's width never depends on fan-out.

### F5 — the inspector's run view is #222's table, and that is a feature

Board 3 is deliberately close to `docs/arch/222-query-surface-prototype/02-run-summary.txt`:
same columns, same one-line-per-(node, iteration) rule, same three-part gist. Drawing it
found no reason to diverge, and one reason not to: if the cockpit's run view and
`parley run status` disagree about what a run looks like, the ADR has two answers to one
question.

Two additions the visual form buys that the text form can't:

- A **spine** down the left edge whose knot colour carries node state, with a bracket where
  the node fans out — the sequence reads as a sequence without the reader parsing node ids.
- The gate row is the only **polymorphic** cell (#222's STATE column), and giving it a
  beacon plus the `on_reject → funnel` badge makes the branch visible at rest, which the
  text view has to spend a line on.

### F6 — a deliverable's three kinds want three different treatments, and one of them is a dead end

`inline` is browsable — board 3 renders the JSON in a report-tinted well and it is the
overwhelming default per #216.

`file` and `dir` are references parley never copied, so Cove can show the path, the size,
and nothing else. It cannot preview them: the bytes live in a worktree the daemon does not
serve, and a remote Cove (PRODUCT.md contemplates one) has no filesystem access at all.
The honest render is a path plus "reference only" — which the board says out loud rather
than implying with a broken preview.

`purged` is a **state the view must render**, not an error. #216's decay clock means an old
run's deliverable rows are simply gone while the addresses survive, so Cove needs a
first-class empty treatment or every historical run eventually looks broken.

### F7 — the fork needs its own vocabulary in the STATE column, and one of the words is an accusation

Board 4 renders `inherited` and `skipped` — the pair #222's drafting found missing from
#221 — and shows why they can't share a treatment. `inherited` is benign: the value was
copied at iteration 0, nothing was lost. `skipped` on a gate means **a human approval was
silently discarded by the fork**, which is the hole #222 flagged in re-entry.

Drawing them made the asymmetry obvious enough to propose a rule: **inherited is quiet
(struck-through, archive ink); skipped-a-gate is loud (coral).** A fork that walks past a
mandatory approval should look wrong in the UI even before anyone decides whether the
engine ought to allow it.

### F8 — "voyage" is a synonym, and the glossary has a rule about those

The boards use *voyage*, *hands*, *route*, and *seal* in flavour copy while every
operational label stays in #214's vocabulary (run, node, step, gate, task, deliverable).
PRODUCT.md licenses exactly this — "flavor is allowed to be decorative; status is never
allowed to be decorative" — but `CONTEXT.md` carries an avoided-synonyms discipline, so
whether *voyage* may appear at all is a call for #227, not a thing this prototype settled.
The safe reading: flavour serif copy may say voyage; no label, column header, or state
string may.

---

## Deliberately not drawn

- **Soundings.** Whole-run eval and metrics belong to
  [#225](https://github.com/femoral/parley/issues/225); nothing here proposes a Soundings change.
- **Live motion.** Every board is a resting frame. Any animation on the course (a sloop
  tracking along a leg, a lighthouse pulse) owes a `prefers-reduced-motion` still, and the
  still is what is drawn.
- **The ≤1080px collapse.** The three-region board already has a documented single-column
  behaviour; a course that reflows into a narrow column is a real problem and is not
  addressed here.
