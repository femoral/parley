# Design System: Parley Console

Direction contract for `@useparley/dashboard` (wayfinder map #337, ticket #342).
Lives with the Console design register under `packages/dashboard/docs/design/`.
Token values below are authoritative (originally lifted from the approved design
mock, whose export has since been removed from the repo); the build must express
them as CSS custom properties, not hex literals in components.

## Overview

Neutral dark instrument panel. One composed board — chrome header, left nav rail,
center screen, right attention rail, footer legend — rendered in two typefaces, one
palette, zero radii, and hairline discipline. Nothing is decorative; the visual
system's job is to make density legible and attention unmissable.

## Colors

### Ground and surfaces

| Token | Hex | Use |
| --- | --- | --- |
| ground | `#0b0d0f` | page/center ground |
| well | `#080a0c` | log/firehose wells (deepest) |
| surface-sunken | `#0d1013` | toolbar strips, sub-wells |
| surface | `#0e1114` | rails, panel headers |
| surface-raised | `#101316` | chrome (header/footer), sticky table heads |
| surface-hover | `#14181c` | row hover, selected-row ground |

### Lines

| Token | Hex | Use |
| --- | --- | --- |
| hairline | `#14181c` | row separators |
| hairline-strong | `#1a2025` | intra-panel dividers |
| border | `#232a30` | panel and control borders |
| border-strong | `#2c343b` | emphasized borders (copy buttons, outputs) |

### Text

| Token | Hex | Use |
| --- | --- | --- |
| text | `#e3e8ec` | primary: names, values |
| text-strong-2 | `#cfd6dc` | section titles, secondary values |
| text-2 | `#93a0ab` | supporting data |
| text-3 | `#8b98a4` | labels, metadata |
| text-4 | `#7c8b98` | faint meta, counts |
| text-time | `#6d7d89` | timestamps in wells |
| link | `#7fb2d9` (hover `#a8cde9`) | branches, references |

### State colors (reserved — status only)

| State | Hex | | State | Hex |
| --- | --- | --- | --- | --- |
| pending | `#8b96a2` | | stalled | `#7f9bb0` |
| queued | `#7b8894` | | completed | `#5d8ca8` |
| running | `#43b98c` | | failed | `#d9534a` |
| awaiting_answer / gate | `#e0a02e` | | cancelled | `#7f8790` |
| eval-good | `#3ea99c` | | eval-poor | `#c4707f` |

State chip pattern: square 7px dot + uppercase mono label, border `<state>44`,
ground `<state>14`. Attention order (sorting, legend): awaiting_answer, stalled,
failed, running, queued, pending, completed, cancelled.

Chip and footer legend share **one label table** (`stateLabels.ts`): the same
uppercase vocabulary (e.g. DONE, CANCEL, AWAITING) renders in both places.

### Interaction neutrals (not status)

| Token | Hex | Use |
| --- | --- | --- |
| focus-ring | `#9aa8b5` | `:focus-visible` outline color (width is `--focus-ring-width`) |
| selection-ink | `#8b98a4` | 2px left selection rule, active-tab underline, checkbox `accent-color` |

These are cool neutrals on the text ramp — never amber, never a state ink.
Measured vs ground `#0b0d0f`: focus-ring **8.01:1**, selection-ink **6.61:1**.

### Success-rate bar ramp (not eval)

| Token | Hex | Band |
| --- | --- | --- |
| success-bar-good | `#5a9a7a` | high completion rate |
| success-bar-mid | `#b79a63` | mid completion rate |
| success-bar-poor | `#a88890` | low completion rate |

Success rate and eval score are different measures — the metrics success bar must
not use `--state-eval-*`. Ratios vs ground: good **5.88:1**, mid **7.25:1**,
poor **6.11:1**.

### Harness coats (identity, from wire data)

codex `#18A886` · grok `#59616F` · claude `#D1784C` · gemini `#4D8CE8` ·
kimi `#39A06F` · opencode `#80A83D` — 12px square swatch beside `harness · model`
text. Coats are identity, never status.

### Named Rules

- **Status ink is reserved.** State colors appear only where they state a state
  (chips, dots, attention, legend, status-colored rules on status surfaces).
  Never as focus ring, selection, active tab, checkbox accent, link, chart
  flourish, or generic emphasis.
- **Interaction uses neutrals.** Focus and selection use `--focus-ring` and
  `--selection-ink` only — tabbing a quiet board must not light amber.
- **Three inks per cell.** A table cell uses at most primary text, one secondary
  tone, and (if stateful) one state color.
- **Amber means "needs the orchestrator."** `#e0a02e` is shared by asks and gates
  and nothing else; it is the loudest ink on the board.

## Typography

IBM Plex Sans (400/500/600) and IBM Plex Mono (400/500/600), **self-hosted** — the
daemon serves offline; no font CDN at runtime.

### Hierarchy

| Role | Spec |
| --- | --- |
| Section label | 600 10px Sans, uppercase, letterspacing .12–.14em, text-3 |
| Micro label (chips, node kinds) | 600 9–10px Mono, uppercase, ls .06–.1em |
| Row primary (names) | 500 11.5–12px Sans |
| Data (ids, branches, counts, ages) | 400 10–10.5px Mono |
| KPI numeral | 500 21px Mono |
| Screen title | 600 15px Sans |
| Log line | 400 10.5px/1.5 Mono |

### Named Rules

- **Two families, one job each.** Sans names things; Mono states data. A value
  set in Sans or a name set in Mono is a defect.
- **Uppercase is structural.** Only section labels and state chips are uppercase,
  always letterspaced; body content never is.
- **No type below 9px**, and everything ≤10px is contrast-checked at AA against
  its actual ground.

## Layout

Fixed chrome grid: 46px header / content / 26px footer. Content: left rail
(nav, filters, scope, burn) · center screen · right rail (attention queue,
firehose). Screens: Fleet (KPI strip, runs table, tasks table), Run (header,
view switch: pipeline / iteration grid / node table, deliverables + run tasks),
Task (brief + attempt chain · log tail · Q&A + report), Metrics (group-by table,
distribution, heatmap).

### Named Rules

- **Tables are the medium.** Sticky heads on `surface-raised`, hairline row
  separators, uppercase Sans column labels, right-aligned numerics, ellipsis
  truncation with full value on `title`.
- **Selection is a 2px left rule** in `--selection-ink` (neutral); hover is
  `surface-hover`. Never a fill swap that fights state chips. Never amber.
- **Density floor, legibility law.** Rows 24–30px; the viewport floor is 1280
  with no horizontal scroll at board level (wide tables scroll within their
  region, with a visible cue).
- **One scroll owner per region.** Rails and screens scroll internally; the page
  never scrolls.

## Shapes & Depth

- **Zero radius.** Everything is square — panels, chips, buttons, dots (state
  dots are squares; only the live-connection dot is a circle). Exception: none in
  v1.
- **No shadows, no gradients.** Depth is expressed by the surface ladder and
  borders only.
- **Hairline discipline.** Every division is 1px; double borders are a defect.

## Motion

- **Animation only means live.** The 2.4s opacity pulse (`pcPulse`) marks live
  data feeds: running-state dots, the daemon connection dot, tailing log status.
  Nothing else moves at rest.
- `prefers-reduced-motion`: pulses still to full opacity; no other motion exists
  to remove.

## Components

- **State chip** — dot + label per the state pattern; the only colored capsule.
- **KPI cell** — label / numeral+unit / note stack; numerals in state ink only
  when the KPI is itself a state count.
- **Pip track** — run progress squares (10px, bordered), one per (node,
  iteration) slot; severity-preserving aggregation past 20 slots; text summary
  for assistive tech.
- **Copy scaffold** — bordered mono button (`surface-hover` ground,
  border-strong) whose label is the command; click copies, label confirms.
  The console's only "verb".
- **Panel** — border + `surface` header strip (uppercase label + faint count/meta
  right) + content; no chrome beyond that.
- **Attention card** — 2px state-color left rule, badge + age, title, reason,
  meta; rows variant is a single line. Ordered by attention rank, then age.
- **Log well** — deepest ground, timestamp gutter, kind-colored line prefix,
  stick-to-bottom with scroll-release, status line with live dot.

## Do's and Don'ts

### Do

- Design every honesty state (connecting, empty, stale, error, partial) with the
  same rigor as data states.
- Keep the two-register wall: no Cove vocabulary, tokens, or assets anywhere.
  One exception: the parley brand mark (the pirate-skull logo, shipped at
  `public/assets/parleylogo.svg`) is shared product identity across registers
  and appears in the console header unchanged.
- Verify claims on rendered pixels at 1280 / 1460 / 1920.

### Don't

- Add icons where a label works; the console is nearly icon-free by design.
- Introduce a new color, size, or weight without adding it here first.
- Let charm in. If it's fun, it's Cove's.
