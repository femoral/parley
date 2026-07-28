---
name: Parley Cove
description: A gamified localhost cockpit for watching delegated AI agents — weathered nautical chart × cozy strategy-game HUD.
colors:
  sea-abyss: "#06171f"
  sea-deep: "#0c2c3b"
  sea-mid: "#123f52"
  sea-shallow: "#1b5064"
  plate-top: "#1d140c"
  plate-bottom: "#150e07"
  brass-bright: "#ffcf4d"
  brass: "#f0c25a"
  brass-deep: "#b87825"
  brass-frame: "#8a6a34"
  ink-parchment: "#f2e3c4"
  ink-soft: "#d8c39a"
  ink-muted: "#c9b184"
  ink-label: "#967c54"
  ink-on-sea: "#e0cfa4"
  parchment-bg: "#efe0bd"
  parchment-text: "#5b3a24"
  ink-dark-on-gold: "#2a1a08"
  palm-green: "#5e7a4a"
  state-pending: "#c9a87a"
  state-queued: "#d4b06a"
  state-running: "#5fd08a"
  state-awaiting: "#ffcf4d"
  state-stalled: "#7fa8bf"
  state-completed: "#7fd0ff"
  state-failed: "#ff7a6b"
  state-cancelled: "#9a8a72"
  ink-chart: "#5b3a24"
  ink-chart-soft: "#7d5636"
  ink-chart-ghost: "#b39a76"
  ink-live: "#a8331f"
  ink-done: "#4a5f38"
  ink-fail: "#8f1d12"
  quality-good: "#3ec8c0"
  quality-poor: "#e888a0"
  quality-neutral: "#b8a078"
  faction-fake: "#A69B8D"
  faction-codex: "#18A886"
  faction-grok: "#59616F"
  faction-claude: "#D1784C"
  faction-gemini: "#4D8CE8"
  faction-kilo: "#D64E80"
  faction-goose: "#B99435"
  faction-openclaw: "#D65A45"
  faction-cline: "#25A6B5"
  faction-openhands: "#A66BD0"
  faction-opencode: "#80A83D"
  faction-hermes: "#D18B2F"
  faction-pi: "#7567D8"
  faction-kimi: "#39A06F"
  faction-unaligned: "#8A6A34"
  ember-border: "#d97e3a"
  # Ember / attention / report plate gradient stops (composed into fill tokens in layer 0)
  ember-fill-top: "#241206"
  ember-fill-bottom: "#180d05"
  attn-awaiting-fill-top: "#3a1a0c"
  attn-awaiting-fill-bottom: "#25130a"
  attn-stalled-fill-top: "#12222c"
  attn-stalled-fill-bottom: "#0e1a22"
  report-fill-top: "#122019"
  report-fill-bottom: "#0e1a13"
  report-border: "#3f8f68"
  alert-red-top: "#c22b1f"
  alert-red-bottom: "#9c1c14"
  alert-cream: "#ffe6a8"
  # Depth washes — black/white alpha ramps for shadows, scrims, inset rims, masks
  wash-black: "#000000"
  wash-black-18: "rgba(0, 0, 0, 0.18)"
  wash-black-22: "rgba(0, 0, 0, 0.22)"
  wash-black-25: "rgba(0, 0, 0, 0.25)"
  wash-black-28: "rgba(0, 0, 0, 0.28)"
  wash-black-30: "rgba(0, 0, 0, 0.3)"
  wash-black-32: "rgba(0, 0, 0, 0.32)"
  wash-black-35: "rgba(0, 0, 0, 0.35)"
  wash-black-38: "rgba(0, 0, 0, 0.38)"
  wash-black-40: "rgba(0, 0, 0, 0.4)"
  wash-black-45: "rgba(0, 0, 0, 0.45)"
  wash-black-50: "rgba(0, 0, 0, 0.5)"
  wash-black-55: "rgba(0, 0, 0, 0.55)"
  wash-black-60: "rgba(0, 0, 0, 0.6)"
  wash-white-20: "rgba(255, 255, 255, 0.2)"
  wash-white-28: "rgba(255, 255, 255, 0.28)"
  wash-white-30: "rgba(255, 255, 255, 0.3)"
  wash-white-32: "rgba(255, 255, 255, 0.32)"
  wash-white-35: "rgba(255, 255, 255, 0.35)"
  wash-white-40: "rgba(255, 255, 255, 0.4)"
  wash-white-50: "rgba(255, 255, 255, 0.5)"
typography:
  display:
    fontFamily: "Cinzel, 'Times New Roman', serif"
    fontSize: "clamp(1.625rem, 3.4vw, 2.5rem)"
    fontWeight: 900
    lineHeight: 1.1
    letterSpacing: "7px"
  headline:
    fontFamily: "Cinzel, 'Times New Roman', serif"
    fontSize: "1.25rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "1px"
  title:
    fontFamily: "Cinzel, 'Times New Roman', serif"
    fontSize: "0.875rem"
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "2px"
  chrome:
    fontFamily: "Cinzel, 'Times New Roman', serif"
    fontSize: "0.75rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "1px"
  body:
    fontFamily: "Outfit, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 500
    lineHeight: 1.45
    letterSpacing: "normal"
  sub:
    fontFamily: "Outfit, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "normal"
  label:
    fontFamily: "Outfit, system-ui, sans-serif"
    fontSize: "0.625rem"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "1px"
  mono:
    fontFamily: "'JetBrains Mono', ui-monospace, monospace"
    fontSize: "1.25rem"
    fontWeight: 500
    lineHeight: 1
    letterSpacing: "normal"
  meta:
    fontFamily: "'JetBrains Mono', ui-monospace, monospace"
    fontSize: "0.6875rem"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "normal"
  flavor:
    fontFamily: "'IM Fell English', Georgia, serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "normal"
rounded:
  cartouche: "13px"
  panel: "11px"
  card: "10px"
  inbox: "9px"
  well: "8px"
  control: "7px"
  emblem: "7px"
  tight: "4px"
  micro: "3px"
  hairline: "2px"
  pill: "999px"
spacing:
  gutter: "12px"
  board-inset: "14px"
  header: "11px 15px 8px"
  body: "12px 14px"
  region-roster: "300px"
  region-right: "344px"
components:
  button-primary:
    backgroundColor: "{colors.brass}"
    textColor: "{colors.ink-dark-on-gold}"
    typography: "{typography.title}"
    rounded: "{rounded.control}"
    padding: "7px 14px"
  button-secondary:
    backgroundColor: "#241812"
    textColor: "#e8c88a"
    typography: "{typography.title}"
    rounded: "{rounded.control}"
    padding: "7px 14px"
  button-tertiary:
    backgroundColor: "#00000000"
    textColor: "#9c8154"
    typography: "{typography.title}"
    rounded: "{rounded.control}"
    padding: "7px 14px"
  button-success:
    backgroundColor: "#123a2a"
    textColor: "#aef0c8"
    typography: "{typography.title}"
    rounded: "{rounded.control}"
    padding: "7px 14px"
  plate:
    backgroundColor: "{colors.plate-top}"
    textColor: "{colors.ink-parchment}"
    rounded: "{rounded.panel}"
    padding: "{spacing.body}"
  badge:
    backgroundColor: "{colors.wash-black-30}"
    textColor: "{colors.ink-label}"
    rounded: "{rounded.pill}"
    padding: "2px 8px"
  emblem:
    backgroundColor: "{colors.brass-frame}"
    textColor: "#ffffff"
    rounded: "{rounded.emblem}"
    size: "23px"
  stat:
    textColor: "#e8c88a"
    typography: "{typography.mono}"
  well:
    backgroundColor: "#100a06"
    textColor: "{colors.ink-parchment}"
    rounded: "{rounded.well}"
    padding: "8px 10px"
---

# Design System: Parley Cove

## Overview

**Creative North Star: "The Weathered Chart-Room"**

Parley Cove is a cozy captain's chart-room. Warm parchment-and-brass panels float on a deep teal sea; the fleet of delegated agents is laid out on an aged nautical map you keep open to watch the work happen. The whole surface is built around one promise from PRODUCT.md — *agent work you want to watch* — so it is unapologetically atmospheric: a slowly spinning compass rose, drifting sea texture, corner flourishes, engraved-caps titles. It is a place, not a panel.

That delight is a feature, never a coat of paint. Beneath the atmosphere the system is strict about honesty: status is never decorative, attention hierarchy is law, and functional prose stays in a plain humanist sans that never asks you to squint. The loudest thing on screen is always the thing that changed or needs notice — an agent's coat color, a beacon, a state — and everything at rest stays quiet and legible. The chart-room is warm because you live in it; it is precise because you trust it.

This system explicitly rejects three things. It is **not a generic SaaS dashboard** — no flat slate-gray, no lone blurple accent, no identical card grids or hero-metric tiles. It is **not a cold ops console** — it shows logs but is not a log viewer; no pure-black monospace-everything hacker screen. And it is **not skeuomorphic clutter** — the wood and brass are crafted materials used with restraint, never gaudy fake-texture on every element.

**Key Characteristics:**
- Deep-teal sea canvas with warm brass/parchment panel chrome; one loud faction hue per element.
- Engraved-caps display type (Cinzel) for chrome, humanist sans (Outfit) for all functional text, mono (JetBrains) for logs and numerals.
- Attention hierarchy drives every color and motion decision.
- Ambient, atmospheric motion that fully stills under `prefers-reduced-motion`.
- Read-only calm: the resting state is quiet; loudness is reserved for change.

## Colors

A warm-on-cold palette: cool teal seas underneath, warm brass and parchment on top, with a single vivid faction hue allowed per element and a set of luminous state colors reserved for status.

### Primary
- **Chart Brass** (`#f0c25a`): The signature accent. Panel titles, frames, dividers, primary buttons, roster selection — the warm metal that makes the chrome feel crafted. **Bright Brass** (`#ffcf4d`) is its highlight for beacons, focus rings, and the `awaiting_answer` glow; **Deep Brass** (`#b87825`) and **Brass Frame** (`#8a6a34`) are its shadow and inset-ring tones.

### Secondary
- **Deep Teal Sea** — a four-stop depth ramp from **Sea Shallow** (`#1b5064`) at the top to **Sea Abyss** (`#06171f`) at the bottom. Rendered as the room's radial-gradient backdrop, not a panel fill. This is the only cool family and it stays behind everything.

  **One continuous sea.** The DOM backdrop and the sailing canvas draw the *same* ellipse from the same `--sea-grad-*` / `--sea-vignette-*` fractions, both scoped to the cockpit box, so the living chart has no visible edge against the surrounding water. Those fractions are **radii**, and CSS `radial-gradient(<rx> <ry> at …)` takes radii too — so both sides multiply by 100, never 200. Doubling one side draws that sea at half depth and puts a hard rectangle around the centre stage.

### Tertiary
- **Faction Coats** — one loud hue per harness, worn only on that harness's emblem, sail, and hull. Flagship examples are **Codex Green** (`#18A886`), **Grok Slate** (`#59616F`), **Claude Terracotta** (`#D1784C`), **Gemini Blue** (`#4D8CE8`), **Pi Purple** (`#7567D8`), and **Unaligned Brass** (`#8A6A34`, the neutral privateer for unknown harnesses); the full list lives in `src/tokens/factions.ts`. Faction color is the only run-time color in the system; everything else is a fixed token.

`src/tokens/factions.ts` is the source of truth for faction coats, reflecting PRODUCT.md's data-driven vendor-as-faction model.

### Neutral
- **Parchment Ink** (`#f2e3c4`): default body text on dark panels — warm, high-contrast, never gray.
- **Soft Ink** (`#d8c39a`): one step quieter than parchment for soft-quiet roster names and similar.
- **Muted Ink** (`#c9b184`) / **Label Ink** (`#967c54`): secondary text and ALL-CAPS micro-labels. Warm tans, not neutral grays. Label is the quietest functional tier (≥4.5:1 on plate wood).
- **Ink on Sea** (`#e0cfa4`): body text that sits on the teal sea backdrop (empty-state copy) — plate inks fail AA there.
- **Plate Wood** — panel chrome ramp from **Plate Top** (`#1d140c`) to **Plate Bottom** (`#150e07`); dark warm browns that read as aged wood, lit by the brass frame.
- **Parchment Tag** (`#efe0bd` on `#5b3a24` text): the one light chip in the whole UI — a genuine paper label against the dark room.
- **Palm Green** (`#5e7a4a`): scene foliage only — earthy olive kept outside the state family so Running Green stays rare.

### Depth washes
Black and white **alpha ramps** for shadows, scrims, inset rims, scroll tracks, and mask feathers — not brand color. Named as an ordered scale (`--wash-black-18` … `--wash-black-60`, `--wash-white-20` … `--wash-white-50`, plus opaque `--wash-black` for mask stops) because the same wash reappears on popovers, text-shadows, wells, and scene drop-shadows; inventing per-surface names would invent false distinctions. Each alpha is a distinct rendered appearance — do not snap between steps. Plate chrome recipes (`--plate-shadow` and friends) compose these washes rather than hard-coding `rgba(0,0,0,…)`.

### State Colors (reserved — status only)
- **Running Green** (`#5fd08a`), **Awaiting Gold** (`#ffcf4d`), **Stalled Slate** (`#7fa8bf`), **Completed Sky** (`#7fd0ff`), **Failed Coral** (`#ff7a6b`), **Pending Tan** (`#c9a87a`), **Cancelled Ash** (`#9a8a72`). These luminous hues are spent *only* on task state, so a color in this family always means "this is a state." Tuned to glow on plate wood; they do not clear WCAG AA on parchment.

### Chart Ink Palette (dark ramp for parchment)
The luminous state family is built for dark wood. On parchment those lights smear — Running Green on paper fails AA as a pale wash. A paper surface (the run chart pinned to the sea) needs a **second, dark ink ramp** in the same warm-on-cold system. This is its own ink palette, not a sub-family of the state tokens: three of the six are pen weights that carry no state at all, so filing them under a state namespace would invent a false distinction. The luminous layer-0 state ramp is unchanged; this adds a parallel ramp and does not rename, modify, or deprecate the first.

Contrast figures below are measured against **flat** `--parchment-bg` (`#efe0bd`) unless a second stop is named. The parchment the palette was ratified against is not flat — the #224 sheet is `linear-gradient(168deg, #f4e7c8, var(--parchment-bg) 46%, #e2cfa4)` plus stain layers, darkest at `#e2cfa4`. See the **Textured-sheet AA rule** under Named Rules.

**Pen weights** (route, marginalia, not-yet-sailed marks — not status):
- **Chart Ink** (`--ink-chart` `#5b3a24`): the pen the whole map is drawn in. ≈7.74:1 on flat `#efe0bd` (≥4.5:1 AA); ≈6.60:1 on `#e2cfa4`.
- **Chart Soft** (`--ink-chart-soft` `#7d5636`): older ink — answered gates, faded legs, marginalia. ≈4.93:1 on flat `#efe0bd` (≥4.5:1 AA); ≈4.21:1 on `#e2cfa4` (fails AA — see textured-sheet rule).
- **Chart Ghost** (`--ink-chart-ghost` `#b39a76`): not yet sailed. ≈2.06:1 on flat `#efe0bd` (≈1.76:1 on `#e2cfa4`) — **decorative-only**. Never used for text that must be read. Pair any "ahead" meaning with the `?` glyph so the cue survives without relying on this colour for legibility; that glyph must itself be inked in `--ink-chart` or `--ink-chart-soft`, never in `--ink-chart-ghost`.

**State inks on paper** (status alone, always glyph-paired):
- **Live Vermilion** (`--ink-live` `#a8331f`): under way. Glyph: **✦**. ≈5.09:1 on flat `#efe0bd` (≥4.5:1 AA); ≈4.34:1 on `#e2cfa4` (fails AA — see textured-sheet rule).
- **Done Olive** (`--ink-done` `#4a5f38`): sailed. Glyph: **✓**. ≈5.38:1 on flat `#efe0bd` (≥4.5:1 AA); ≈4.59:1 on `#e2cfa4` (clears AA).
- **Fail Blot** (`--ink-fail` `#8f1d12`): blotted. Glyph: **✕**. ≈6.83:1 on flat `#efe0bd` (≥4.5:1 AA); ≈5.82:1 on `#e2cfa4`.

The second-cue requirement holds without colour alone. Each **state** on the chart is ink tone + glyph: `✓` sailed (`--ink-done`), `✦` under way (`--ink-live`), `✕` blotted (`--ink-fail`). The pen-weight "ahead" mark may use ghost for the decorative mark; its `?` glyph is not a state cue and must be inked in chart or chart-soft (see ghost bullet). The on-paper key repeats the pairings.

### Named Rules
**The One Loud Hue Rule.** Each element gets at most one saturated color, and it is the faction coat or the state color — never both, never a decorative third. The room is warm neutrals; the loud hue is information.

**The Warm-Ink Rule.** Text is never neutral gray. Every ink tone carries the parchment/brass hue. Gray body text on the wood panels is forbidden — it reads washed-out and off-brand. When contrast is close, move toward Parchment Ink, never toward gray.

**The State-Color Reservation.** The luminous state palette is spent on status alone. Do not reuse Running Green or Failed Coral as decorative accents; their meaning depends on their rarity. Metric quality — scores, deltas, success rate, below-baseline, heatmap fail intensity — uses the separate **quality verdict** group (`--quality-good` / `--quality-poor` / `--quality-neutral`). State colors answer *what a task IS*; quality colors answer *how good work WAS*.

On parchment, the same reservation covers the chart state inks: **`--ink-live`**, **`--ink-done`**, and **`--ink-fail`** are state colours on paper exactly as the luminous family is on wood — spent on status alone, never decorative. Pen weights (`--ink-chart`, `--ink-chart-soft`, `--ink-chart-ghost`) are not state colours; ghost remains decorative-only and must not carry readable text.

**The Textured-sheet AA Rule.** Chart-ink AA claims against flat `--parchment-bg` (`#efe0bd`) do not automatically hold on a textured or gradient sheet. The ratified #224 sheet darkens to `#e2cfa4`, where `--ink-chart-soft` (≈4.21:1) and `--ink-live` (≈4.34:1) fail normal-text AA while `--ink-chart` still holds ≈6.60:1. **Constraint:** text that must be read — including state glyphs and the "ahead" `?` — may use `--ink-chart-soft` or `--ink-live` only where the surface under that text is no darker than flat `#efe0bd`. Over any darker parchment region (including `#e2cfa4` stops, stains, or edge washes), step that text up to `--ink-chart`. `--ink-done` and `--ink-fail` still clear AA at `#e2cfa4`; `--ink-chart-ghost` never carries readable text.

**The Stroke-State Rule.** A route *leg* — the stroke between two chart marks — may not carry a **state ink**. A leg cannot wear a glyph, so a state colour on a stroke would be a single-channel cue; under a Viénot-1999 protanopia simulation, `--ink-chart-soft` vs `--ink-done` separate by ΔE2000 **less than 1** (measured ≈0.53), i.e. indistinguishable. Every route leg is therefore drawn in a *pen weight* only — `--ink-chart` or `--ink-chart-soft` — never `--ink-live`, `--ink-done`, or `--ink-fail`. Pen weight may vary to show **route structure** (strong pen for the charted trail, soft pen for structure not yet entered and for secondary arcs); that pair is safe without colour because under the same protanopia model `--ink-chart` vs `--ink-chart-soft` separate by ΔE2000 **≈10.0**. State lives **only** on marks, seals and tally chips, where the second cue (glyph) is available: `✓` sailed, `✦` under way, `?` ahead, `✕` blotted. The dash vocabulary stays free for route structure: dashed = the treasure-trail route, longer-dashed = a loop-back arc. (#259)

## Typography

**Display Font:** Cinzel (with 'Times New Roman', serif) — engraved Roman capitals.
**Body Font:** Outfit (with system-ui, sans-serif) — a clean geometric-humanist sans.
**Label/Mono Font:** JetBrains Mono for logs, ids, and numerals; **IM Fell English** (italic serif) for decorative flavor only.

**Character:** A deliberate three-way contrast, not a similar-fonts pairing. Cinzel's carved caps give the chrome its monumental, chart-engraving feel; Outfit keeps all readable data plain and modern; JetBrains Mono grounds the technical layer. IM Fell English is the room's handwriting — atmospheric marginalia, never operational text.

### Hierarchy
- **Display** (Cinzel 900, `--text-display` clamp(1.625rem…2.5rem), tracking 7px): the cove title in the cartouche. One per screen.
- **Headline** (Cinzel 700, `--text-stat` 1.25rem/20px, tracking 1px): major panel headers and stat-adjacent titles.
- **Title** (Cinzel 700, `--text-title` 0.875rem/14px, tracking 2px): panel-header titles; smaller chrome (buttons, tabs, group labels) steps down to `--text-chrome` 0.75rem/12px and `--text-chrome-sm` 0.6875rem/11px.
- **Body** (Outfit 500, `--text-body` 0.8125rem/13px, line-height ~1.45): all functional prose — agent questions, empty-state guidance, goals, status; secondary prose sits at `--text-sub` 0.75rem/12px. Keep prose columns comfortable; wrap rather than run a wall.
- **Label** (Outfit 600, `--text-label` 0.625rem/10px, tracking 1px, UPPERCASE): micro-labels under stats and on chips.
- **Numerals** (JetBrains Mono 500, `--text-stat` 1.25rem/20px and `--text-stat-sm` 1.125rem/18px): stat readouts and the clock; `--text-mono` 0.75rem/12px for log lines, `--text-meta` 0.6875rem/11px for ids and meta.
- **Flavor** (IM Fell English italic, `--text-flavor` 0.75rem/12px): taglines, footnotes, weather, legend hints.

All steps are rem so browser font-size preferences scale the whole HUD (the old px ramp ignored them and shrank physically on high-DPI monitors). Glyph slots and world-scaled scene art keep px on purpose.

### Named Rules
**The Flavor-Font Rule.** Reach for IM Fell English (`--font-flavor`) only when the answer to *"Must the user read this to use the feature?"* is **no**. Taglines, footnotes, and atmosphere get it; agent questions, empty-state guidance, errors, and any copy carrying state or data stay in Outfit. Borderline copy defaults to functional. Never set operational prose in the flavor serif.

**The Engraved-Chrome Rule.** Cinzel is for chrome only — titles, headers, tabs, buttons. It never sets a paragraph. If body copy is in Cinzel, it's wrong.

## Layout

The cockpit is a **room, not a page**. The shell is `position: fixed; inset: 0` with `overflow: hidden` and a `14px` board inset (`--board-inset`), so the chart-room fills the viewport exactly once and never scrolls as a whole. Scrolling belongs to individual regions, never to the room.

**The three-region board.** Under a full-width footer strip, the main row is a fixed / fluid / fixed triptych separated by a `12px` gutter (`--gutter`):

- **Roster** — fixed `300px` (`--region-roster`). The fleet list; scrolls internally.
- **Centre stage** — fluid (`flex: 1; min-width: 0`). Holds the cartouche + day chip head, then either the living Cove scene or the Soundings board. This is the only region that grows with the window; the flanks are fixed so the chart gets every spare pixel.
- **Status stack** — fixed `344px` (`--region-right`). Health, Inbox, and Inspector plates stacked vertically; the rail scrolls, and only the Inspector flexes within it so a populated logbook can never crush the Health plate.

The footer is a 3-up grid (`1fr auto 1fr`) so the Cove/Soundings toggle stays optically centred regardless of how wide the chart-key and settings groups grow.

**Padding rhythm.** Two paddings do nearly all the work: plate headers at `11px 15px 8px` (`{spacing.header}`) and plate bodies at `12px 14px` (`{spacing.body}`). Wells inset a step tighter at `8px 10px`.

**Responsive behavior.** One width breakpoint, two height breakpoints, plus container queries where the viewport is the wrong question:

- **≤1080px** — the triptych collapses to a single scrolling column, reordered so the chart still leads: centre stage first, status stack second, roster last. The stacked roster is capped at `40vh` and its scrollport is feathered with a bottom mask so a half-visible row reads as "more below" rather than a hard cut. The scene is floored at `clamp(320px, 50vh, 560px)` so the living chart never collapses to nothing.
- **≤720px tall** — the Inspector's flavor line and the logbook digest are both dropped, and the resting state centres itself. The digest is removed outright rather than flexed toward zero: below this the plate cannot seat one tally row plus a report line, and a shrunk digest only rendered a row cut in half. Removing it also keeps a zero-height "Fleet digest" region out of the accessibility tree.
- **Container queries on the title stack** — the cartouche's brand mark sizes to *its own plate* (`cqi`), not the viewport, at 40rem / 32rem / 26rem steps. Laptop centre columns are far narrower than a `vw`-based clamp implies; this is what stops the title shearing at ~1080–1200px. The Cove/Soundings nav is *not* engraved on this plate — it lives in the footer strip — so the cartouche reserves no horizontal space for it.

**Depth ordering is flat.** Atmosphere sits at `z-index: 0`, regions at `1`, and there is exactly one floating layer: `--z-popover: 20` for the chart key and the roster's search popover. There is no z-index ladder to reason about.

### Named Rules
**The Fixed-Flanks Rule.** The roster and status stack hold their widths; the centre stage absorbs every extra pixel. The chart is the point of the cockpit, so window space goes to the chart — never to padding out the rails.

**The Room-Doesn't-Scroll Rule.** The shell is fixed and clipped. If content overflows, a *region* scrolls, and that scrollport gets a real keyboard tab stop and an accessible name. Never let the whole board scroll.

**The Whole-Plate Rule.** A plate is drawn complete or not at all — its inset brass frame is the system's signature, and a plate sliced by a rail's clip has no bottom frame at all. When a plate's content can grow without bound (the inbox's question cards, the logbook's digest), clamp *inside* that plate and give the clamp a feather or a "more below" cue; never let it push a sibling plate past the fold. A half-drawn plate reads as a rendering bug, not as scrollable content.

## Elevation & Depth

The system conveys depth through **a single signature inset recipe**, not a soft-shadow ladder. Panels ("plates") are dark warm surfaces pressed into the sea by a double inner ring — a dark inset stroke, then a brass frame stroke — with one broad ambient drop shadow beneath. The effect is a metal-framed plaque resting on water, not a floating Material card. Surfaces are flat by default; there is no hover-lift ladder of `sm`/`md`/`lg` shadows.

### Shadow Vocabulary
- **Plate frame** (`inset 0 0 0 3px #13100a, inset 0 0 0 4px var(--brass-inner), 0 8px 22px var(--wash-black-50)`): the standard plate's double-inset ring + ambient drop.
- **Premium / Cartouche frame** (`inset 0 0 0 3px #120d07, inset 0 0 0 5px var(--brass-frame)` [+ inner vignette on the cartouche via `--wash-black-60`]): a heavier frame for the title cartouche and premium plates.
- **Gold button 3D edge** (`0 3px 0 var(--brass-shadow), inset 0 1px 1px var(--wash-white-40)`): the one tactile press affordance — a hard drop edge on the primary button, not a blur.

### Named Rules
**The Framed-Not-Floating Rule.** Depth comes from the inset brass frame, not from drop-shadow blur. Panels sit *in* the scene, pressed onto the sea. Never add a soft Material elevation shadow to a plate to make it "pop."

## Shapes

The form language is **rounded rectangles and pills, nothing else** — no bevels, no cut corners, no organic blobs. The only curve that isn't a rectangle corner is the emblem's rounded square and the fully-round pill. Every shape is drawn with a `1px` brass border plus the inset frame recipe, so silhouettes read as *framed metal plaques* rather than floating cards.

### Corner radii
Documented steps, large to small: **cartouche** 13px → **panel** 11px → **card** 10px → **inbox** 9px → **well** 8px → **control / emblem** 7px → **tight** 4px → **micro** 3px → **hairline** 2px, plus **pill** 999px. Hairline and micro sit below the old 4px floor for chip knobs, scrollbar thumbs, speech-bubble tails, and `calc()` inset corners that would look swollen at tight.

The scale is **hierarchical, not decorative**: radius tracks the element's rank in the room. The cartouche (the one title plate) is roundest; ordinary plates step down; controls and wells sit tighter; and anything nested inside a rounded parent uses `calc(parent − hairline)` so concentric corners stay optically parallel instead of drifting.

### Pills and chips
`--radius-pill` (999px) is reserved for things that read as *tokens rather than surfaces*: badges, state chips, the settings toggles, the roster session chips, the footer view nav, and the edge-of-frame attention chips. A pill signals "this is a small piece of status or a compact control," never "this is a panel."

### Clipping and masks
Plates clip their content (`overflow: hidden`) so the inset frame is never crossed. Two deliberate masks exist and both are functional, not ornamental: the stacked roster's bottom fade at ≤1080px (signalling more content), and the sloop sprite's silhouette / sail / pennant masks, which let a single raster wear any faction coat. Masks read the **alpha channel only** — the sprite PNGs are greyscale+alpha for exactly this reason.

### Named Rules
**The Concentric-Corner Rule.** A rounded thing inside another rounded thing subtracts, never guesses: `calc(var(--radius-parent) - var(--radius-hairline))`. Two independently-chosen radii on nested corners always look wrong at the tangent.

**The Pill-Means-Token Rule.** Full-round (999px) marks a chip, badge, or compact control. If it holds a header, a body, or more than one line of content, it is a plate and takes a plate radius.

## Components

### Buttons
- **Shape:** gently rounded (7px, `--radius-control`); Cinzel 700 caps at 11–13px, tracking 1–2px.
- **Primary:** brass gradient fill (`#e6b34a → #b87825`) with dark ink text (`#2a1a08`) and a hard 3D drop edge; hover brightens the gradient (`#ffcf4d → #b87825`). The one tactile control.
- **Secondary:** dark wood fill (`#241812`) with soft-brass text; hover raises the border to full brass.
- **Tertiary:** transparent with faint ink; a quiet text button that warms to brass on hover.
- **Success:** deep green fill (`#123a2a`) with mint text (`#aef0c8`) — the review/approve CTA in the report tab.
- **Focus:** 2px Bright Brass outline, 2px offset, on `:focus-visible` for every button and interactive element.
- **Target size:** every control clears 24×24px (WCAG 2.2 AA 2.5.8). Where the type is small, hold the floor with `min-height: 24px` and centred content rather than inflating padding — density is part of the HUD's character.

### Badges
- **Style:** pill (999px), 1px border in the badge's own color over a 30%-black wash; Outfit 600 at 9.5px, tracking 0.6px. The border and text share one variable so a badge is tinted by a single color.
- **State:** used for compact status/meta chips; the color carries the meaning.

### Cards / Containers (Plates)
- **Corner Style:** 11px panel / 13px cartouche / 10px card.
- **Background:** dark wood gradient (`#1d140c → #150e07`); the ember (inbox) and report (structured result) plates swap in warm-orange and sea-green fills respectively.
- **Shadow Strategy:** the double-inset brass frame from Elevation & Depth — never a soft Material shadow.
- **Border:** 1px brass border; `--premium`/`--cartouche` variants use the heavier brass-mid frame.
- **Internal Padding:** header `11px 15px 8px`, body `12px 14px`.

### Inputs / Fields
- **Style:** dark inset well (`#0e0a06`) with a faint warm border and 8px radius; Outfit body text.
- **Focus:** 2px Bright Brass outline (the global focus-visible treatment), not a color-shift-only cue.

### Navigation / Tabs
- **Style:** Cinzel 700 tracked caps; inactive tabs sit in faint ink, the active tab warms to brass with a brass underline/frame. Selection and hover use alpha tints of brass (`rgba(240,194,90,0.06–0.12)`), never a fill swap.

### Scrollports
- **Style:** thin brass-brown thumb (`--scroll-thumb`) on a `--wash-black-25` track; `scrollbar-width: thin` plus matching `::-webkit-scrollbar` rules so both engines agree.
- **Behavior:** any clipped, scrollable region carries `tabIndex={0}` and an accessible name (`role="region"` + `aria-label`, or an existing `role="log"` / `tabpanel`). A scrollport with no focusable children is otherwise unreachable by keyboard.

### Emblem (signature — faction chip)
- A 23px rounded-square chip filled with the vendor's **coat** color, wearing an original emblem mark (unicode glyph or authored SVG path — never a fetched brand logo). A bright rim (`var(--wash-white-32)`) keeps near-black coats (Grok) legible on the dark sea. This is the atom of the vendor-as-faction system: adding a vendor is one data record, zero new component code.

### Plate Header (signature)
- A brass radial-gradient icon tile, an engraved Cinzel title, and an optional italic subtitle, with an aside slot pushed right. The consistent "nameplate" that labels every plate in the cove.

## Do's and Don'ts

### Do:
- **Do** keep the deep-teal sea gradient as the room's only backdrop; panels rest on it, never replace it.
- **Do** spend saturated color on information only — one faction coat or one state color per element (The One Loud Hue Rule).
- **Do** set all readable data and prose in Outfit; reserve Cinzel for chrome and JetBrains Mono for logs/numerals.
- **Do** convey depth with the inset brass frame recipe (The Framed-Not-Floating Rule).
- **Do** make the highest-attention state the loudest thing on screen — `awaiting_answer` > `stalled` > `running` > terminal.
- **Do** back every state color with a second cue (icon, glyph, label, or position) so status survives color-blind vision and reduced motion.
- **Do** ship every animation with a `prefers-reduced-motion` still frame that stays legible.
- **Do** give every scrollable region a keyboard tab stop and an accessible name (The Room-Doesn't-Scroll Rule).
- **Do** keep data ramps monotonic — a heatmap or intensity scale must never render two different values identically.
- **Do** order ordinal buckets along their own scale (size `XS→XL`, difficulty `trivial→extreme`), never alphabetically (The Scale-Order Rule).
- **Do** print scores and deltas to a fixed one decimal so they align down a mono column; `8` beside `8.9` mis-scans as the smaller number.
- **Do** clamp a growing list inside a plate rather than letting it push a sibling plate past the rail's clip (The Whole-Plate Rule).

### Don't:
- **Don't** build a **generic SaaS dashboard** — no flat slate-gray surfaces, no single blurple accent, no identical card grids, no hero-metric tiles.
- **Don't** turn it into a **cold ops console** — no pure-black monospace-everything hacker screen; the logs live in a well, they are not the whole room.
- **Don't** pile on **skeuomorphic clutter** — no gaudy fake-wood on every element, no heavy bevel-and-shadow on everything; the materials are crafted and restrained.
- **Don't** use gray body text on the wood panels; move toward Parchment Ink (`#f2e3c4`) when contrast is close (The Warm-Ink Rule).
- **Don't** set operational prose in IM Fell English — the flavor serif is for atmosphere only (The Flavor-Font Rule).
- **Don't** reuse a state color (Running Green, Failed Coral, …) as a decorative accent; its meaning depends on its rarity.
- **Don't** add soft Material elevation shadows to plates to make them "pop"; depth is the inset frame, not blur.
- **Don't** hard-code an `rgba()` wash or an off-scale radius above layer 0 — compose from `--wash-*` and the radius scale.
- **Don't** use `opacity` to quiet text; it silently voids the token layer's contrast guarantees. Pick a dimmer ink instead.
