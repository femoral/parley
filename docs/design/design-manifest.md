# Parley Cove — Design-System Manifest

Source: `Parley Cove HUD.dc.html` (Claude Design export). This document extracts every
token, component, and behavior an implementation needs to rebuild the HUD faithfully.

> **Placeholder note — the living view.** The central "Living Workboard" (the 3-column
> task-card grid) in this design is a *placeholder direction*. The implementation will
> replace it with an animated game scene: the orchestrator as a big ship, islands that
> pop from the water for each piece of active work, and small ships circling islands
> while agents work. The tokens, chrome (plate frames, banners, badges, bars) and state
> visual language in this manifest still govern that scene's HUD framing and overlays.

---

## 1. Overview & principles

**Concept.** A gamified localhost cockpit for watching delegated AI agents: weathered
nautical chart × cozy strategy-game HUD. Warm parchment and brass panels float on a deep
teal sea; the vendor's faction color is the only loud hue per element.

**Principles**

1. **Attention hierarchy is law.** `awaiting_answer` > `stalled` > `running` > terminal
   (`completed` / `failed` / `cancelled`); `pending` is transient. A blocked-on-question
   agent must be the loudest thing on screen (gold glow, red "PARLEY!" banner, beacon
   pulse, top of every list).
2. **Delight over density.** Decorative flavor copy (IM Fell English italics — only where
   the user need not read to act), corner flourishes, a slowly spinning compass rose,
   and drifting sea texture keep it a place you *want* to leave open. Functional copy
   and data stay readable in Outfit/JetBrains Mono, but never a wall.
3. **Vendor-agnostic factions.** A vendor = a faction = `{ label, coat color, emblem
   mark, tagline }`. Emblem marks are data (unicode glyph or original SVG path) — never
   per-vendor component code. The system is extensible: adding a vendor means adding one
   faction record, never new layout.
4. **Read-only calm, act-only where it matters.** The only interactive inputs are the
   inbox answer box / suggestion chips / resume button and the inspector tabs; everything
   else is observation.

---

## 2. Design tokens

### 2.1 Color — surfaces & sea

| Token | Value | Use |
|---|---|---|
| `sea-abyss` | `#06171f` | Page background, radial gradient outer stop |
| `sea-deep` | `#0c2c3b` | Gradient mid stop |
| `sea-mid` | `#123f52` | Gradient mid stop |
| `sea-shallow` | `#1b5064` | Gradient center-top stop |
| `sea-vignette` | `rgba(3,12,18,0.72)` | Inset vignette (`inset 0 0 240px 70px`) |

Background: `radial-gradient(130% 100% at 50% -6%, #1b5064 0%, #123f52 30%, #0c2c3b 60%, #06171f 100%)`.

### 2.2 Color — wood/parchment panel chrome

| Token | Value | Use |
|---|---|---|
| `plate-top` | `#1d140c` | Panel gradient top (`linear-gradient(180deg,#1d140c,#150e07)`) |
| `plate-bottom` | `#150e07` | Panel gradient bottom |
| `plate-card-bottom` | `#140d07` | Card gradient bottom |
| `plate-footer` | `#100a06` | Panel footer / stat wells |
| `plate-well` | `#1a1209` | Inset content boxes (goal, Q bubbles) |
| `plate-well-border` | `#3a2716` | Border of inset boxes, tab bar divider |
| `line-faint` | `#2a1c10` | Faint hairlines, stat-well borders |
| `progress-track` | `#0c0904` | Progress bar track (with `inset 0 0 0 1px #3a2c15` ring) |
| `input-bg` | `#0e0a06` | Text input background |

### 2.3 Color — brass / gold

| Token | Value | Use |
|---|---|---|
| `brass-bright` | `#ffcf4d` | Hover links, glow color, awaiting accents, flourish dots |
| `brass` | `#f0c25a` | Primary gold: headings, title, selected borders, active tab |
| `brass-link` | `#e6b34a` | Links, primary button gradient top, log panel icon |
| `brass-soft` | `#e8c88a` | Secondary headings, mono values in health grid |
| `brass-mid` | `#d9a441` | Ornament strokes, cartouche/inspector outer border |
| `brass-dim` | `#c99b45` | Ornament secondary strokes |
| `brass-border` | `#b98f3f` | Standard panel outer border |
| `brass-frame` | `#8a6a34` | Inner frame ring, divider gradients, dim ornament glyphs |
| `brass-inner` | `#6f5326` | Inner frame ring (standard panels), divider stops |
| `brass-deep` | `#a8681f` | Gold gradient bottom (buttons, anchor chips) |
| `brass-shadow` | `#5b3a24` | Button 3D drop edge, title text-shadow, parchment-tag text |
| `card-border-idle` | `#5a441f` | Idle card border |
| `card-ring-idle` | `#4a381caa` | Idle card inner ring |

### 2.4 Color — ink / text

| Token | Value | Use |
|---|---|---|
| `ink-parchment` | `#f2e3c4` | Primary body text |
| `ink-warm` | `#e2d0a8` / `#e8d3a6` | Goal text, faction labels, secondary button text |
| `ink-cream` | `#e0cfa4` | Legend labels |
| `ink-soft` | `#d8c39a` | Weather label, brief mono values |
| `ink-muted` | `#c9b184` | Log message text, card ctx % |
| `ink-tan` | `#c9a87a` | Subtitle caps, pending state, inspector kicker |
| `ink-gold-dim` | `#b39a6a` | Roster ctx %, card charter line |
| `ink-label` | `#8a6f4d` | ALL-CAPS field labels, counts, inactive tabs, empty-state text |
| `ink-faint` | `#9c8154` | Roster branch·id line, tertiary button text |
| `ink-dim` | `#7a6242` | "ctx" prefix, legend hints |
| `ink-ghost` | `#6f5a3c` | Flavor footnotes, empty-state prose |
| `ink-dot` | `#5b4426` | Separator dots |
| `ink-timestamp-faded` | `#5f4a2c` | Q&A timestamps |
| `ink-dark-on-gold` | `#2a1a08` | Text on gold buttons/plates |

### 2.5 Color — parchment tag (light chip)

| Token | Value |
|---|---|
| `parchment-bg` | `#efe0bd` |
| `parchment-border` | `#b8935a` |
| `parchment-text` | `#5b3a24` |

Used for branch chips (`⑂ branch-name`), the one *light* element in the dark HUD.

### 2.6 Color — task states (canonical, from `stateMeta`)

| State | Color | Glyph | Label | Hint |
|---|---|---|---|---|
| `pending` | `#c9a87a` | ⏳ | PENDING | queued & calm |
| `running` | `#5fd08a` | ⛵ | RUNNING | hard at work |
| `awaiting_answer` | `#ffcf4d` | 🚩 | AWAITING | needs your input |
| `stalled` | `#7fa8bf` | 🧭 | STALLED | blocked / waiting |
| `completed` | `#7fd0ff` | 🏁 | COMPLETED | report ready |
| `failed` | `#ff7a6b` | ✖ | FAILED | terminal state |
| `cancelled` | `#9a8a72` | ⊘ | CANCELLED | called back |

Legend glyph glow = state color + `44` alpha suffix.

Report outcomes reuse: `success #5fd08a`, `partial #ffcf4d`, `failed #ff7a6b`.

### 2.7 Color — vendor factions (extensible registry)

| Vendor | Faction | Coat | Coat-dark | Emblem | Tagline |
|---|---|---|---|---|---|
| codex | Codex | `#10a37f` | `#0b7359` | hexagonal knot (SVG) | Green helm. Open charts. |
| grok | Grok | `#2b2b2e` | `#141416` | X letterform (SVG) | Truth under black canvas. |
| pi | Pi | `#6c5ce7` | `#4a3db8` | π | A personal current. |

Emblem chips: coat background, light rim border, white/light mark,
`inset` sheen. Near-black coats keep a slightly stronger rim so they read on dark sea.
Marks are original in-repo path data or glyphs (not trademark logos). The coat color also
tints the task's name in the global log stream.

### 2.8 Color — alerts & auxiliary

| Token | Value | Use |
|---|---|---|
| `alert-red-top` / `alert-red-bottom` | `#e23b2e` / `#9c1c14` | PARLEY! banner & "N NEEDS YOU" pill gradient |
| `alert-cream` | `#ffe6a8` | Banner text, awaiting question snippet |
| `question-parchment` | `#ffe6c2` | Inbox/Q&A question text |
| `attn-awaiting-bg` | `linear-gradient(180deg,#3a1a0c,#25130a)` + border `#f0c25a` | Awaiting inbox card |
| `attn-stalled-bg` | `linear-gradient(180deg,#12222c,#0e1a22)` + border `#4a6b7a` | Stalled inbox card |
| `inbox-panel` | bg `linear-gradient(180deg,#241206,#180d05)`, border `#d97e3a`, inner ring `#8a4a22` | Inbox panel (ember-tinted plate) |
| `report-panel` | bg `linear-gradient(180deg,#122019,#0e1a13)`, border `#3f8f68`, inner ring `#2f6b4e` | Structured report panel (sea-green plate) |
| `report-well` | bg `#10241a`, border `#2f7d5a55` | Report summary / answer bubbles |
| `report-mono-green` | `#9fe0bf` | File paths, brief branch/worktree |
| `report-text` | `#cde6d5` (body), `#bfe6cf` (heading), `#bfe0cc` (list), `#eafff2` (emphasis) | Report greens |
| `report-labels` | `#6f9c85`, `#7a9c86`, `#7fb99a`, `#8fb0a0` | Report muted greens |
| `diff-add` / `diff-del` | `#6fbf8a` / `#e07a6b` | +adds / −dels |
| `healthy-green` | `#5fd08a` dot, `#8fe0a8` text | Daemon HEALTHY chip, live-log dot |
| `sessions-blue` | `#7fd0ff` | Durable sessions stat |
| `resume-blue` | border `#7fd0ff`, bg `#123243`, text `#cdeeff` | RESUME button |
| `stalled-copy` | `#9db0b8` | "Adrift …" copy |
| `log-timestamp` | `#3f5a4d` | Mono timestamps in both log views |
| `scroll-thumb` | `#6b4a2c` (hover `#8a613a`) on track `rgba(0,0,0,0.25)` | Scrollbars, chip borders |
| `badge-bg` | `rgba(0,0,0,0.3)` (some `0.25`) | All state/outcome badge fills |

Log stream level colors: `ERR #ff8a7a`, `ASK #ffcf4d`, `RUN #7fb0ff`, `OK #8fe0a8`,
`INFO #8fa0b0`. Inspector raw-log line colors by kind: `reasoning #7f9c8e`,
`tool #7fb0ff`, `shell #ffcf4d`, `stdout #8fe0a8`, `error #ff8a7a`, `question #ffcf4d`,
fallback `#c9a87a`.

Context-pressure bar ramp (fill gradient top/bottom + glow):

| Usage | Top | Bottom | Glow |
|---|---|---|---|
| < 75% | `#ffd76b` | `#c98a2a` | `#ffcf4d44` |
| ≥ 75% | `#ffb03a` | `#c9781f` | `#ffb03a55` |
| ≥ 90% | `#ff8a7a` | `#a8342f` | `#ff7a6b55` |

### 2.9 Typography

Google Fonts load: `Cinzel:wght@500;700;900`, `IM Fell English:ital@0;1`,
`Outfit:wght@300;400;500;600;700`, `JetBrains Mono:wght@400;500`.

| Family | Role | Weights/sizes actually used |
|---|---|---|
| **Cinzel** (serif) | Engraved caps plates: titles, panel headers, tabs, buttons | 900 @ 40px ls 7px (title), 900 @ 10px ls 2px (PARLEY! banner), 700 @ 19/14/13/12.5/12/11/10.5px ls 1–2px (headers, tabs, buttons), 500 @ 12px ls 6px (subtitle), 500 @ 10px ls 2px (kit section labels) |
| **IM Fell English** (serif, italic) | Decorative flavor only (see rule below) | italic 11px (day-chip weather), 10.5px (footnotes, faction taglines, state-legend hints) |
| **Outfit** (sans) | Default HUD text, values, labels, and all functional prose | 600 @ 13px (names), 500 @ 12.5px (rows), 11.5–13px (body, buttons, questions, empty states, goals, panel subtitles), 9–10px ls 0.5–1px (ALL-CAPS micro-labels) |
| **JetBrains Mono** | Logs, ids, branches, numerics | 21px / 19px / 17px (stat numerals, clock), 11px (log lines), 10–10.5px (ids, ctx %, meta) |

**Flavor-font rule (functional vs decorative).** Token: `--font-flavor` (`IM Fell English`).
Apply it only when the answer to *"Must the user read this text to use the feature?"* is
**no**. Borderline informational copy defaults to **functional** (Outfit / `--font-body`).

| Class | Treatment | Examples |
|---|---|---|
| **Decorative** — keep `--font-flavor` | Taglines, footnotes, purely atmospheric lines the user can ignore | Day-chip weather, brief standing footnote, kit-band faction taglines, kit-band state-legend hints |
| **Functional** — use `--font-body` (Outfit); italic optional | Agent questions, empty-state guidance, goals, error/status, panel subtitles that can carry state/data | Inbox/Q&A question text, roster/inbox/log/report/QA/scene empty copy, brief goal well, plate-header subtitles (e.g. health version), inspector placeholder |

Copy classes that still get the flavor font after this rule: day-chip weather
(`.pc-daychip__weather`), brief footnote (`.pc-brief__footnote`), faction taglines
(`.pc-kit__faction-tagline`), state-legend hints (`.pc-kit__legend-hint`). Keep the
token; do not reintroduce it on operational prose.

Scale summary: micro-labels 9–10px, body 11–13px, headers 12–14px (Cinzel, tracked),
display 19–21px numerals, 40px title. Line-heights: logs 1.6, prose 1.35–1.5, tight
headers 1.1–1.25.

### 2.10 Spacing, radii, borders, shadows

- **Canvas**: designed at fixed `1600 × 1000`; board inset `14px`; global gutter `12px`
  between all regions and stacked panels.
- **Radii**: panels `11px`, cartouche `13px`, cards `10px`, inbox cards `9px`, wells and
  rows `8px`, buttons/inputs `7px`, emblem chips `6–8px`, badges/pills `9–11px`
  (pill-ish), progress bars `5px`, state-dot circles `50%`.
- **Panel plate recipe** (the signature chrome): `border:1px solid #b98f3f;
  box-shadow: inset 0 0 0 3px #13100a, inset 0 0 0 4px #6f5326, 0 8px 22px rgba(0,0,0,0.5)`
  over `linear-gradient(180deg,#1d140c,#150e07)`. Double inset ring = dark gap + brass
  inner frame. Premium variant (cartouche, inspector): border `#d9a441`, rings
  `inset 0 0 0 3px #120d07, inset 0 0 0 5px #8a6a34`, cartouche adds
  `inset 0 0 30px rgba(0,0,0,0.6)` and `0 10px 30px rgba(0,0,0,0.6)`.
- **Divider rule**: 2px tall, `linear-gradient(90deg,transparent,#8a6a34 22%,#e6c05a 50%,#8a6a34 78%,transparent)`
  (vertical version rotates to `180deg` with `#6f5326` stops).
- **Gold 3D buttons**: `box-shadow: 0 3px 0 #5b3a24, inset 0 1px 1px rgba(255,255,255,0.4)`
  (send button uses `0 2px 0`).
- **Padding rhythm**: panel headers `~11px 15px 8px`, list gutters `6–10px`, card padding
  `10–11px`, wells `8–12px`.
- **Scrollbars**: 8px, rounded brown thumb (see 2.8).

### 2.11 Texture & atmosphere

- **Sea texture**: full-canvas overlay at `opacity:0.5`, two crossing
  `repeating-linear-gradient`s of faint white (`rgba(255,255,255,0.045)` @115° every
  46px; `0.03` @65° every 60px), animated with `seaMove` (16s linear infinite,
  background-position drift `220px 0` / `-180px 90px`).
- **Compass-rose watermark**: 760px SVG (two circles + 4 polygon points in `#f0c25a`),
  centered ~52% down, `opacity:0.05`, spinning 360° over 140s (`spinRose`).
- **Vignette**: full-canvas `inset 0 0 240px 70px rgba(3,12,18,0.72)`.
- **Corner flourishes**: small SVGs (30px on cartouche corners, 24px on inspector top
  corners) — a curled bracket path in `#d9a441` (2.4 stroke) + inner curl `#c99b45`
  (1.6 stroke) + `#ffcf4d` dot; mirrored per corner via `scaleX/Y(-1)`. Toggleable via
  an `ornaments` boolean prop.

---

## 3. Layout regions

Fixed 1600×1000 canvas → 14px inset flex column, 12px gaps.

```
┌──────────────────────────────────────────────────────────────────┐
│ MAIN ROW (flex:1)                                                │
│ ┌─────────┐ ┌──────────────────────────────┐ ┌────────────────┐  │
│ │ FLEET   │ │ CENTER column (flex:1)       │ │ RIGHT STACK    │  │
│ │ ROSTER  │ │  ├ Title cartouche + day/    │ │ (344px fixed)  │  │
│ │ (300px  │ │  │  weather chip (220px)     │ │  ├ Daemon      │  │
│ │  fixed) │ │  ├ Workboard header line     │ │  │  Health     │  │
│ │         │ │  ├ LIVING WORKBOARD          │ │  ├ Inbox       │  │
│ │ footer: │ │  │  3-col card grid, scrolls │ │  │ (max 290px) │  │
│ │ totals  │ │  │  (flex:1)  ← placeholder  │ │  └ Active      │  │
│ │         │ │  └ Log/Report band (194px):  │ │    Inspector   │  │
│ │         │ │     Raw Log (1.35fr) │       │ │    (flex:1)    │  │
│ │         │ │     Structured Report (1fr)  │ │                │  │
│ └─────────┘ └──────────────────────────────┘ └────────────────┘  │
│ BOTTOM: HUD KIT BAND (toggleable via showKit)                    │
│  Factions (300px) │ State legend (flex:1) │ Chrome kit (448px)   │
└──────────────────────────────────────────────────────────────────┘
```

- Left roster: header + gold divider, scrollable grouped list, fixed footer with two
  big stats (TOTAL TASKS gold, ACTIVE green).
- Center: cartouche row is fixed-height; workboard grid `grid-template-columns:repeat(3,1fr); gap:11px`
  scrolls; bottom band fixed at 194px.
- Right stack: health (auto), inbox (auto, max-height 290px, scrolls), inspector fills
  the remainder with tabbed scrollable body.
- Kit band is a style-guide strip (factions / legend / chrome samples) separated by
  vertical gold dividers — useful as a living reference, hideable in production.

---

## 4. Component inventory

1. **Panel plate** — the base container (recipe in §2.10). Variants: *standard* (brass),
   *premium* (brighter brass + optional corner flourishes: cartouche, inspector),
   *ember* (inbox: orange border `#d97e3a`), *sea-green* (structured report). All
   `border-radius:11px`, `overflow:hidden`.
2. **Panel header** — 24–28px icon chip (radial-gradient gold or dark-bronze, or faction
   coat) + Cinzel 700 tracked title + optional Outfit italic subtitle (functional —
   may carry version/status) + right-aligned status chip; followed (sometimes) by the
   gold divider rule.
3. **Title cartouche** — PARLEY COVE, Cinzel 900 40px, letter-spacing 7px, `#f0c25a`
   with `text-shadow: 0 2px 0 #5b3a24, 0 0 26px rgba(255,207,77,0.25)`; flanked by
   `✦ ⚓ ✦` in `#8a6a34`; subtitle "AI SUB-AGENT COCKPIT" Cinzel 500 12px ls 6px `#c9a87a`;
   4 corner flourishes.
4. **Day/weather chip** — 220px plate: "Day N" (Cinzel 19px gold) `·` clock (mono 19px
   `#e8c88a`); weather emoji + label (`#d8c39a`) + wind reading (mono `#8fb0a0`).
   Pure flavor; clock is real.
5. **Roster state group** — group header: 19px circular state-dot (dark radial bg,
   border+glyph in state color) + Cinzel 11px state label in state color + mono count
   `#8a6f4d` right-aligned. Only non-empty groups render, in attention order:
   awaiting → running → pending → stalled → completed → failed → cancelled.
6. **Roster task row** — 23px faction emblem chip + name (12.5px 500) over
   `branch · id` (mono 10px `#9c8154`) + optional `ctx N%` (active states only) +
   beacon-pulsing 🚩 when awaiting. States: *idle* (transparent), *selected*
   (bg `rgba(240,194,90,0.12)`, border `#f0c25a88`). Clickable → selects in inspector.
7. **Task card (workboard)** — placeholder for the game scene, but its chrome is
   canonical: emblem chip + name + faction label + state badge; a 2-line activity/
   charter line (running → latest log line, normal `#9fc7a8`; awaiting → the question,
   italic `#ffe6a8`; else → prompt, italic `#b39a6a`); footer row of parchment branch
   chip + ctx progress bar + `ctx N%`. Variants: *awaiting* (gold border `#f0c25a`,
   pulsing `glowPulse` shadow `0 0 22px rgba(255,207,77,0.5)` + red PARLEY! ribbon),
   *selected* (border `#e6b34a` + 1px gold ring), *idle* (border `#5a441f`, inner ring
   `#4a381caa`), *dimmed* (opacity 0.9 completed, 0.62 failed/cancelled).
8. **PARLEY! ribbon** — absolutely positioned top-right, rotated 2°, bleeding off-edge
   (`right:-30px`); red gradient, gold top/bottom borders, Cinzel 900 10px ls 2px
   `#ffe6a8`; animated `bannerBounce` 1.4s.
9. **State badge** — pill, `1px solid <stateColor>`, text in state color,
   bg `rgba(0,0,0,0.3)`, 9.5–10px, weight 600. Same pattern for outcome badges
   (SUCCESS/PARTIAL/FAILED) and the standalone PARLEY pill.
10. **Branch chip (parchment tag)** — `⑂ branch-name`, mono 9.5–10px, light parchment
    colors (§2.5), max-width + ellipsis.
11. **Context progress bar** — 8–9px track `#0c0904` with inset ring; fill gradient +
    glow ramps by pressure (§2.8); paired `ctx N%` mono readout with dim `ctx` prefix.
12. **Raw log stream (global)** — mono 11px/1.6 rows: timestamp `#3f5a4d` → `[LEVEL]`
    in level color → task name in faction coat → message `#c9b184` (ellipsized). Header
    carries a live chip: 7px glowing dot + label — `#5fd08a` "Live · Follow" or
    `#8a6f4d` "Paused". Shows the last ~7 merged lines across all tasks.
13. **Structured report panel** — green plate; header (name, mono branch, outcome
    badge), summary prose `#cde6d5`, "KEY CHANGES" micro-label + `▸`-bulleted list,
    footer stats (`files N`, `+adds` green, `−dels` red) above a `#24463599` hairline.
    Shows latest completed task; empty copy "No completed voyages yet."
14. **Daemon health panel** — header with gold anchor chip + HEALTHY chip (glowing green
    dot, beacon 1.8s); 2×2 label/value grid (HOST, PORT, PID, UPTIME — labels
    `#8a6f4d`, values mono `#e8c88a`); two stat wells (`#100a06`, border `#2a1c10`):
    ACTIVE AGENTS `x / y` green, DURABLE SESSIONS blue.
15. **Inbox (attention) card** — ember or slate variant (§2.8). Header row: emblem,
    name, mono id, state chip. Question block: `⌐` marker `#d99a5a` + Outfit italic
    13px `#ffe6c2` (functional — must be readable to answer). *Awaiting* variant adds suggestion chips (dark buttons, border
    `#6b4a2c`, hover `#33240f`/gold border), an answer input (bg `#0e0a06`, placeholder
    "Your answer…") + gold `➤` send button, and "Markdown supported" hint. *Stalled*
    variant shows "Adrift <duration> — nudge to resume." + blue `⛵ RESUME` button.
    Sorted awaiting-first. Panel header shows 🚩 (beacon) + red "N NEEDS YOU" pill.
    Empty state: 🧭 + "All hands accounted for. No flags flying."
16. **Inbox count pill** — red gradient pill (`#e23b2e→#9c1c14`), `#ffe6a8` text, 10px 700.
17. **Active inspector** — premium plate; header (faction emblem, "ACTIVE INSPECTOR"
    kicker, task name + mono id, state badge); tab bar (BRIEF | LOGS | REPORT | Q&A —
    Cinzel 10.5px ls 1px, active `#f0c25a` with 2px gold underline, inactive `#8a6f4d`,
    bottom border `#3a2716`); scrollable body per tab:
    - **Brief**: 64px/1fr key-value grid (Branch/Worktree mono green `#9fe0bf`,
      Model/Elapsed mono `#d8c39a`; elapsed shows `duration · in ▸ out tok`); "📜 GOAL"
      well; "CONSTRAINTS" `◆`-bulleted list (`#d9a441` markers); italic footnote
      *"parley never merges — the branch waits for yer review."*
    - **Logs**: dark green-black terminal well (`#08120f`, border `#1c2c24`), raw JSON
      lines colored by kind (§2.8), last 60.
    - **Report**: OUTCOME badge, summary well (`#10241a`), "FILES CHANGED" mono list
      (`+ path`), full-width CTA `🏁 Review & plant the branch` (green: border
      `#5fd08a`, bg `#123a2a`, text `#aef0c8`). Empty: *"No report yet — this soul is
      still at sea."*
    - **Q&A**: chat transcript — agent question bubble left (faction avatar, parchment
      well `#1a1209`, Outfit italic body, radius `8 8 8 2`) vs. your answer right-aligned
      (⚓ avatar `#1c3a2a`, green well `#10241a`, radius `8 8 2 8`), centered timestamp
      `#5f4a2c`. Empty: *"No parley yet — this soul hasn't raised a flag."*
18. **Buttons (chrome kit)** — *Primary*: gold gradient `#e6b34a→#a8681f`, border
    `#f0c25a`, dark text, Cinzel 700, 3D shadow. *Secondary*: bg `#241812`, border
    `#7a5c2e`, text `#e8c88a`. *Tertiary*: transparent, border `#3a2c18`, text `#9c8154`.
    Plus *success* (review CTA), *info/blue* (resume), *chip* (suggestions).
19. **Stat readout** — big mono numeral (17–21px, semantic color) over 9–9.5px tracked
    caps label `#8a6f4d`.
20. **Gold divider rule** — see §2.10; used under panel headers and vertically in the
    kit band.
21. **State legend entry** — 24px glowing state-dot circle + label `#e0cfa4` + IM Fell
    italic hint `#7a6242` (kit band; decorative atmosphere, not operational copy).
22. **Faction legend entry** — emblem chip + label `#e8d3a6` + IM Fell italic tagline
    `#8a6f4d` (kit band; decorative — pure atmosphere).
23. **Corner flourish SVG** — §2.11; decorative, toggleable.

---

## 5. State visual language

| State | Treatment |
|---|---|
| **awaiting_answer** | Loudest. Gold `#ffcf4d`; card gets gold border + `glowPulse` halo + rotated red PARLEY! banner (`bannerBounce`); roster row shows beacon-pulsing 🚩; task pinned first in roster and card sort; ember inbox card with inline answer UI; red NEEDS-YOU counter; card line = the question in cream italic. |
| **stalled** | Cool slate-blue `#7fa8bf`, 🧭. Slate inbox card, "Adrift <t>" copy, blue RESUME action. Ranked below awaiting in inbox, but still surfaced. |
| **running** | Green `#5fd08a`, ⛵. Live: card line streams latest activity in green, ctx bar and token counters tick, log lines flow. No glow — calm competence. |
| **pending** | Tan `#c9a87a`, ⏳. Quiet; ctx readout hidden (`showPct` false). |
| **completed** | Sky blue `#7fd0ff`, 🏁. Card dimmed to 0.9; report panel + review CTA carry the payoff. |
| **failed** | Coral `#ff7a6b`, ✖. Dimmed to 0.62. |
| **cancelled** | Grey-tan `#9a8a72`, ⊘. Dimmed to 0.62. |

Attention ordering is enforced structurally, not just chromatically: roster groups,
card sort (`awaiting 0 → running 1 → pending 2 → stalled 3 → completed 4 → failed 5 →
cancelled 6`), and inbox sort all put blocked-on-question first.

---

## 6. Motion & animation

| Keyframe | Timing | Purpose |
|---|---|---|
| `beacon` | 1.2–1.8s ease-in-out infinite, opacity 0.55↔1 | 🚩 flags, live dots, HEALTHY dot |
| `glowPulse` | inset ring + `0 0 14px→26px rgba(255,207,77,0.35→0.7)` | Awaiting card halo |
| `bannerBounce` | 1.4s, translateY 0↔−3px keeping rotate(2°) | PARLEY! ribbon bob |
| `seaMove` | 16s linear infinite, background-position drift | Sea texture current |
| `cursorBlink` | 50/50 opacity | (defined; terminal cursor) |
| `spinRose` | 140s linear infinite, full rotation | Compass watermark |

Interaction transitions in the design are instant (no CSS transitions declared); hover
states exist on links (`#e6b34a→#ffcf4d`), scrollbar thumb, and suggestion chips
(bg `#33240f`, border `#f0c25a`). Recommend adding ~120ms ease transitions on hover/
selection in implementation. Simulation cadence in the prototype: log tick ~950ms,
clock 1s; ambient loops (sea, rose) are slow enough to be subliminal.

## 7. Implementation notes

- **Fonts**: load Cinzel (500/700/900), IM Fell English (regular + italic; decorative
  flavor only — see §2.9), Outfit (300–700; all functional prose), JetBrains Mono
  (400/500) — Google Fonts in the design; consider self-hosting for the localhost
  cockpit (offline-friendly). Fallbacks: `serif` for Cinzel/IM Fell,
  `system-ui, sans-serif` for Outfit, `monospace` for JBM.
- **Assets**: none external. All decoration is inline SVG (compass rose, corner
  flourishes) and CSS gradients; glyphs are Unicode/emoji (⚓ ⚔ ☾ ⛵ 🚩 🧭 🏁 ⏳ ✖ ⊘ ⑂
  ◆ ▸ ⌐ ✦ 🌤️ 📜 ➤). Emoji rendering varies by platform — consider an SVG icon set for
  the emblems/state glyphs in production.
- **Canvas**: designed fixed 1600×1000. Implementation should treat the flex/grid
  proportions (300px / flex / 344px, 194px log band, 12px gaps) as the reference and
  make the center region fluid.
- **Prototype-only behaviors** (from the embedded `DCLogic` script — reference logic,
  not ship code): support.js runtime, `sc-for`/`sc-if` templating, seeded demo tasks,
  simulated log/token ticking, a scripted parley raise, and `style-hover` attributes.
  Real data comes from the parley daemon. Keep from that logic: the derived-view
  shapes (groups/cards/attention/stream/report/sel), state ordering maps, ctx pressure
  formula (`(usageIn+usageOut)/ctxWindow`, thresholds 75/90), duration/number
  formatters (`1.2k`, `3m 41s`), and the log-line classifier (kind → level/color and
  raw-JSON → friendly text).
- **Toggles**: `ornaments` (corner flourishes), `showKit` (bottom style-guide band —
  likely dev-only), `liveLogs` (pause/follow the stream) — all worth keeping as
  settings.
- **Accessibility**: several text colors (`#7a6242`, `#6f5a3c`, 9–10px micro-labels)
  are decorative-contrast; keep critical data (names, questions, state labels, log
  text) at the brighter ink tokens. Respect `prefers-reduced-motion` by disabling
  beacon/glow/banner/sea/rose animations.
