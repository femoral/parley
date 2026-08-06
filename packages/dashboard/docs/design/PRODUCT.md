# Product

Direction contract for `@useparley/dashboard` (wayfinder map #337, ticket #342).
Lives with the Console design register under `packages/dashboard/docs/design/`.

## Register

product

## Platform

web

## Users

The primary user is a developer running delegated agent work through parley — solo
tasks and gated workflow runs — who keeps the console open to know, at a glance,
what needs the orchestrator and what is simply proceeding. Their job here is triage
by eye: held gates, outstanding asks, stalls, and fresh failures must separate from
the calm majority without reading. Answering, approving, and redirecting are not
done here — gate verbs and answers belong to the orchestrating agent; this surface
hands the operator precise copy scaffolds (`parley answer`, `parley fix`) instead of
buttons. Runs on localhost today; must not assume local-only forever.

The console is the **default** UI the daemon serves when none is configured. That
default slot is earned with obligations: full coverage of the daemon's observable
surface (see `coverage-audit.md`) and honesty everywhere — every loading, empty,
stale, and error state designed, never defaulted.

## Product Purpose

Parley Console is the operator's instrument panel for parley. Headless agent work
is invisible; workflow runs make it also *structured* — nodes, gates, fan-outs,
iterations, deliverables. The console renders that structure and the live fleet
around it as dense, truthful telemetry: one screen answers "is anything wrong?",
one more click answers "exactly where and why". Success is an operator trusting the
console as the single pane they check first, and never catching it saying more or
less than the daemon knows.

## Positioning

The instrument panel for delegated agent work. Where Parley Cove is agent work you
want to *watch*, the console is agent work you need to *know about* — density and
precision over atmosphere, for the operator with real work in flight.

## Brand Personality

Instrument, not app. Flight-deck / broadcast-telemetry calm: every pixel is data or
structure, zero flavor copy, zero decoration. Personality emerges from precision —
alignment, rhythm, hairline discipline, typographic restraint — the way a good
instrument feels designed without ever performing. The console is quiet when the
fleet is quiet and unmissable where something needs the orchestrator; it never
celebrates, never chats, never dresses data up.

## Anti-references

- **Generic SaaS dashboard** — hero-metric tiles, card grids, a single blurple
  accent, whitespace standing in for hierarchy. The console's density is the
  feature; padding is not polish.
- **The panel wall (Grafana-style)** — a grid of disconnected charts where the
  operator does the correlating. The console is one composed instrument with an
  attention hierarchy, not a dashboard of widgets.
- **Hacker-terminal cosplay** — green-on-black, scanlines, glitch effects, neon
  "cyber" styling. The console is monospace-heavy because data is tabular, not as
  costume.
- **Parley Cove** — the sibling register. No nautical vocabulary, no gamification,
  no weathered materials, no flavor states anywhere in the console's UI copy, code
  identifiers, or docs. The two registers never blend.

## Design Principles

- **Attention hierarchy is law.** Held gates, outstanding asks, stalls, and fresh
  failures out-rank everything; a calmly running fleet reads calm. One glance
  answers "does anything need the orchestrator?" without reading a word.
- **Every pixel is data or structure.** Ink goes to values, labels, and the
  hairlines that organize them. If an element carries neither data nor structure,
  it goes. Motion means exactly one thing: this datum is live.
- **Honesty states are first-class screens.** Connecting, empty, stale, partial,
  and failed are designed with the same rigor as the happy path — the console
  never renders a guess as a fact, and never renders nothing where it knows why.
- **Observation-only, scaffolds not buttons.** No mutating affordance exists. The
  console's only verbs are copy: precise CLI scaffolds for the operator to carry
  to the orchestrating agent.
- **Coverage is the price of default.** Everything the daemon exposes to a UI has
  a home here; the coverage matrix is a contract, and gaps are defects, not
  roadmap.
- **Pluggable and vendor-agnostic.** One front-end among several; vendors and
  harnesses are data (name, coat color), never bespoke layout.

## Accessibility & Inclusion

Target **WCAG 2.1 AA** at the console's real densities: body and table text ≥4.5:1
against its ground, large numerals ≥3:1. State is never carried by hue alone —
every state color pairs with a text label (the mock's chip pattern: dot + uppercase
label). Full keyboard operation of every interactive surface with visible focus;
ARIA table/tablist/listbox semantics; live regions for attention-count changes;
`prefers-reduced-motion` stills the live-dot pulse to its resting frame. Dense
type sizes (9–12px) make contrast and hinting non-negotiable — measured, not
assumed.

## Quality Bar

The console is held to the impeccable standard as the default UI:

- **Rendered proof, not reasoning.** Every visual claim — alignment, contrast,
  density, truncation, state treatment — is verified against rendered pixels at
  1280, 1460, and 1920 widths. Impeccable review runs against this contract.
- **Viewport floor 1280.** First-class from 1280 up; the mock's 1460 layout adapts
  down without horizontal scroll. No tablet/mobile commitment in v1.
- **Dark only in v1.** The neutral-dark palette in DESIGN.md is the identity;
  light theming is out of scope for this effort.
- **Full-coverage checklist.** The coverage audit's must-add list ships in v1;
  every honesty state it enumerates is demonstrable against a live daemon (see
  the verification plan).
