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
  ink-muted: "#c9b184"
  ink-label: "#967c54"
  ink-on-sea: "#e0cfa4"
  parchment-bg: "#efe0bd"
  parchment-text: "#5b3a24"
  ink-dark-on-gold: "#2a1a08"
  palm-green: "#5e7a4a"
  state-pending: "#c9a87a"
  state-running: "#5fd08a"
  state-awaiting: "#ffcf4d"
  state-stalled: "#7fa8bf"
  state-completed: "#7fd0ff"
  state-failed: "#ff7a6b"
  state-cancelled: "#9a8a72"
  faction-codex: "#10a37f"
  faction-grok: "#2b2b2e"
  faction-pi: "#6c5ce7"
  faction-unaligned: "#8a6a34"
  ember-border: "#d97e3a"
  report-border: "#3f8f68"
  alert-red-top: "#c22b1f"
  alert-red-bottom: "#9c1c14"
  alert-cream: "#ffe6a8"
typography:
  display:
    fontFamily: "Cinzel, 'Times New Roman', serif"
    fontSize: "40px"
    fontWeight: 900
    lineHeight: 1.1
    letterSpacing: "7px"
  headline:
    fontFamily: "Cinzel, 'Times New Roman', serif"
    fontSize: "19px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "1px"
  title:
    fontFamily: "Cinzel, 'Times New Roman', serif"
    fontSize: "13px"
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "2px"
  body:
    fontFamily: "Outfit, system-ui, sans-serif"
    fontSize: "12.5px"
    fontWeight: 500
    lineHeight: 1.45
    letterSpacing: "normal"
  label:
    fontFamily: "Outfit, system-ui, sans-serif"
    fontSize: "9px"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "1px"
  mono:
    fontFamily: "'JetBrains Mono', ui-monospace, monospace"
    fontSize: "19px"
    fontWeight: 500
    lineHeight: 1
    letterSpacing: "normal"
  flavor:
    fontFamily: "'IM Fell English', Georgia, serif"
    fontSize: "10.5px"
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
  pill: "999px"
spacing:
  gutter: "12px"
  board-inset: "14px"
  header: "11px 15px 8px"
  body: "12px 14px"
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
    backgroundColor: "#0000004d"
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

## 1. Overview

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

## 2. Colors

A warm-on-cold palette: cool teal seas underneath, warm brass and parchment on top, with a single vivid faction hue allowed per element and a set of luminous state colors reserved for status.

### Primary
- **Chart Brass** (`#f0c25a`): The signature accent. Panel titles, frames, dividers, primary buttons, roster selection — the warm metal that makes the chrome feel crafted. **Bright Brass** (`#ffcf4d`) is its highlight for beacons, focus rings, and the `awaiting_answer` glow; **Deep Brass** (`#b87825`) and **Brass Frame** (`#8a6a34`) are its shadow and inset-ring tones.

### Secondary
- **Deep Teal Sea** — a four-stop depth ramp from **Sea Shallow** (`#1b5064`) at the top to **Sea Abyss** (`#06171f`) at the bottom. Rendered as the room's radial-gradient backdrop, not a panel fill. This is the only cool family and it stays behind everything.

### Tertiary
- **Faction Coats** — one loud hue per vendor, worn only on that vendor's emblem, sail, and hull: **Codex Green** (`#10a37f`), **Grok Charcoal** (`#2b2b2e`, lifted off true black so it reads on the sea), **Pi Purple** (`#6c5ce7`), **Unaligned Brass** (`#8a6a34`, the neutral privateer for unknown vendors). Faction color is the only run-time color in the system; everything else is a fixed token.

### Neutral
- **Parchment Ink** (`#f2e3c4`): default body text on dark panels — warm, high-contrast, never gray.
- **Muted Ink** (`#c9b184`) / **Label Ink** (`#967c54`): secondary text and ALL-CAPS micro-labels. Warm tans, not neutral grays. Label is the quietest functional tier (≥4.5:1 on plate wood).
- **Ink on Sea** (`#e0cfa4`): body text that sits on the teal sea backdrop (empty-state copy) — plate inks fail AA there.
- **Plate Wood** — panel chrome ramp from **Plate Top** (`#1d140c`) to **Plate Bottom** (`#150e07`); dark warm browns that read as aged wood, lit by the brass frame.
- **Parchment Tag** (`#efe0bd` on `#5b3a24` text): the one light chip in the whole UI — a genuine paper label against the dark room.
- **Palm Green** (`#5e7a4a`): scene foliage only — earthy olive kept outside the state family so Running Green stays rare.

### State Colors (reserved — status only)
- **Running Green** (`#5fd08a`), **Awaiting Gold** (`#ffcf4d`), **Stalled Slate** (`#7fa8bf`), **Completed Sky** (`#7fd0ff`), **Failed Coral** (`#ff7a6b`), **Pending Tan** (`#c9a87a`), **Cancelled Ash** (`#9a8a72`). These luminous hues are spent *only* on task state, so a color in this family always means "this is a state."

### Named Rules
**The One Loud Hue Rule.** Each element gets at most one saturated color, and it is the faction coat or the state color — never both, never a decorative third. The room is warm neutrals; the loud hue is information.

**The Warm-Ink Rule.** Text is never neutral gray. Every ink tone carries the parchment/brass hue. Gray body text on the wood panels is forbidden — it reads washed-out and off-brand. When contrast is close, move toward Parchment Ink, never toward gray.

**The State-Color Reservation.** The luminous state palette is spent on status alone. Do not reuse Running Green or Failed Coral as decorative accents; their meaning depends on their rarity.

## 3. Typography

**Display Font:** Cinzel (with 'Times New Roman', serif) — engraved Roman capitals.
**Body Font:** Outfit (with system-ui, sans-serif) — a clean geometric-humanist sans.
**Label/Mono Font:** JetBrains Mono for logs, ids, and numerals; **IM Fell English** (italic serif) for decorative flavor only.

**Character:** A deliberate three-way contrast, not a similar-fonts pairing. Cinzel's carved caps give the chrome its monumental, chart-engraving feel; Outfit keeps all readable data plain and modern; JetBrains Mono grounds the technical layer. IM Fell English is the room's handwriting — atmospheric marginalia, never operational text.

### Hierarchy
- **Display** (Cinzel 900, 40px, tracking 7px): the cove title in the cartouche. One per screen.
- **Headline** (Cinzel 700, ~19px, tracking 1px): major panel headers and stat-adjacent titles.
- **Title** (Cinzel 700, 13px, tracking 2px): panel-header titles, tabs, buttons — the tracked engraved caps that label every plate.
- **Body** (Outfit 500, 11.5–13px, line-height ~1.45): all functional prose — agent questions, empty-state guidance, goals, status. Keep prose columns comfortable; wrap rather than run a wall.
- **Label** (Outfit 600, 9–10px, tracking 1px, UPPERCASE): micro-labels under stats and on chips.
- **Numerals** (JetBrains Mono 500, 17–21px): stat readouts and the clock; 11px for log lines, 10–10.5px for ids and meta.
- **Flavor** (IM Fell English italic, 10.5–11px): taglines, footnotes, weather, legend hints.

### Named Rules
**The Flavor-Font Rule.** Reach for IM Fell English (`--font-flavor`) only when the answer to *"Must the user read this to use the feature?"* is **no**. Taglines, footnotes, and atmosphere get it; agent questions, empty-state guidance, errors, and any copy carrying state or data stay in Outfit. Borderline copy defaults to functional. Never set operational prose in the flavor serif.

**The Engraved-Chrome Rule.** Cinzel is for chrome only — titles, headers, tabs, buttons. It never sets a paragraph. If body copy is in Cinzel, it's wrong.

## 4. Elevation

The system conveys depth through **a single signature inset recipe**, not a soft-shadow ladder. Panels ("plates") are dark warm surfaces pressed into the sea by a double inner ring — a dark inset stroke, then a brass frame stroke — with one broad ambient drop shadow beneath. The effect is a metal-framed plaque resting on water, not a floating Material card. Surfaces are flat by default; there is no hover-lift ladder of `sm`/`md`/`lg` shadows.

### Shadow Vocabulary
- **Plate frame** (`inset 0 0 0 3px #13100a, inset 0 0 0 4px var(--brass-inner), 0 8px 22px rgba(0,0,0,0.5)`): the standard plate's double-inset ring + ambient drop.
- **Premium / Cartouche frame** (`inset 0 0 0 3px #120d07, inset 0 0 0 5px var(--brass-frame)` [+ inner vignette on the cartouche]): a heavier frame for the title cartouche and premium plates.
- **Gold button 3D edge** (`0 3px 0 var(--brass-shadow), inset 0 1px 1px rgba(255,255,255,0.4)`): the one tactile press affordance — a hard drop edge on the primary button, not a blur.

### Named Rules
**The Framed-Not-Floating Rule.** Depth comes from the inset brass frame, not from drop-shadow blur. Panels sit *in* the scene, pressed onto the sea. Never add a soft Material elevation shadow to a plate to make it "pop."

## 5. Components

### Buttons
- **Shape:** gently rounded (7px, `--radius-control`); Cinzel 700 caps at 11–13px, tracking 1–2px.
- **Primary:** brass gradient fill (`#e6b34a → #b87825`) with dark ink text (`#2a1a08`) and a hard 3D drop edge; hover brightens the gradient (`#ffcf4d → #b87825`). The one tactile control.
- **Secondary:** dark wood fill (`#241812`) with soft-brass text; hover raises the border to full brass.
- **Tertiary:** transparent with faint ink; a quiet text button that warms to brass on hover.
- **Success:** deep green fill (`#123a2a`) with mint text (`#aef0c8`) — the review/approve CTA in the report tab.
- **Focus:** 2px Bright Brass outline, 2px offset, on `:focus-visible` for every button and interactive element.

### Badges
- **Style:** pill (999px), 1px border in the badge's own color over a 30%-black wash; Outfit 600 at 9.5px, tracking 0.6px. The border and text share one variable so a badge is tinted by a single color.
- **State:** used for compact status/meta chips; the color carries the meaning.

### Cards / Containers (Plates)
- **Corner Style:** 11px panel / 13px cartouche / 10px card.
- **Background:** dark wood gradient (`#1d140c → #150e07`); the ember (inbox) and report (structured result) plates swap in warm-orange and sea-green fills respectively.
- **Shadow Strategy:** the double-inset brass frame from Elevation — never a soft Material shadow.
- **Border:** 1px brass border; `--premium`/`--cartouche` variants use the heavier brass-mid frame.
- **Internal Padding:** header `11px 15px 8px`, body `12px 14px`.

### Inputs / Fields
- **Style:** dark inset well (`#0e0a06`) with a faint warm border and 8px radius; Outfit body text.
- **Focus:** 2px Bright Brass outline (the global focus-visible treatment), not a color-shift-only cue.

### Navigation / Tabs
- **Style:** Cinzel 700 tracked caps; inactive tabs sit in faint ink, the active tab warms to brass with a brass underline/frame. Selection and hover use alpha tints of brass (`rgba(240,194,90,0.06–0.12)`), never a fill swap.

### Emblem (signature — faction chip)
- A 23px rounded-square chip filled with the vendor's **coat** color, wearing an original emblem mark (unicode glyph or authored SVG path — never a fetched brand logo). A bright rim (`rgba(255,255,255,0.32)`) keeps near-black coats (Grok) legible on the dark sea. This is the atom of the vendor-as-faction system: adding a vendor is one data record, zero new component code.

### Plate Header (signature)
- A brass radial-gradient icon tile, an engraved Cinzel title, and an optional italic subtitle, with an aside slot pushed right. The consistent "nameplate" that labels every plate in the cove.

## 6. Do's and Don'ts

### Do:
- **Do** keep the deep-teal sea gradient as the room's only backdrop; panels rest on it, never replace it.
- **Do** spend saturated color on information only — one faction coat or one state color per element (The One Loud Hue Rule).
- **Do** set all readable data and prose in Outfit; reserve Cinzel for chrome and JetBrains Mono for logs/numerals.
- **Do** convey depth with the inset brass frame recipe (The Framed-Not-Floating Rule).
- **Do** make the highest-attention state the loudest thing on screen — `awaiting_answer` > `stalled` > `running` > terminal.
- **Do** back every state color with a second cue (icon, glyph, label, or position) so status survives color-blind vision and reduced motion.
- **Do** ship every animation with a `prefers-reduced-motion` still frame that stays legible.

### Don't:
- **Don't** build a **generic SaaS dashboard** — no flat slate-gray surfaces, no single blurple accent, no identical card grids, no hero-metric tiles.
- **Don't** turn it into a **cold ops console** — no pure-black monospace-everything hacker screen; the logs live in a well, they are not the whole room.
- **Don't** pile on **skeuomorphic clutter** — no gaudy fake-wood on every element, no heavy bevel-and-shadow on everything; the materials are crafted and restrained.
- **Don't** use gray body text on the wood panels; move toward Parchment Ink (`#f2e3c4`) when contrast is close (The Warm-Ink Rule).
- **Don't** set operational prose in IM Fell English — the flavor serif is for atmosphere only (The Flavor-Font Rule).
- **Don't** reuse a state color (Running Green, Failed Coral, …) as a decorative accent; its meaning depends on its rarity.
- **Don't** add soft Material elevation shadows to plates to make them "pop"; depth is the inset frame, not blur.
