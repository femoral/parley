# UI component system spec

Decided on wayfinder map #47 (ticket #53), locked against an interactive
prototype (linked from the ticket). Companion to
`docs/design/design-manifest.md` (tokens), `docs/spec/ui-v1-scope.md`
(features/scene grammar), and `docs/research/game-scene-rendering.md`
(SVG/CSS rendering).

## Layers

Five layers inside `packages/ui/src`, strictly downward-depending:

```
tokens/       # layer 0 — no components
├── tokens.css    # every manifest token as a CSS custom property
└── factions.ts   # faction registry {label, coat, coatDark, emblem, tagline}
primitives/   # layer 1 — dumb, styled, zero domain knowledge
├── Plate (variants: standard | premium | ember | report), PlateHeader,
├── Divider, Badge, Emblem, ParchmentChip, Button (primary|secondary|tertiary),
└── Meter, Stat, Flourish
hud/          # layer 2 — domain composites (know what a task is)
├── RosterGroup, RosterRow, InboxCard, HealthPanel,
├── Inspector/ (tabs: Brief | Logs | Report | QA),
└── LogStream, ReportPanel, Cartouche
scene/        # layer 3 — the living view
├── Sea, Camera, SessionRegion, Island, Ship, Flagship
└── effects/  # Flare, Fog, Wake, Wreck — state-driven, compositor-animated
app/          # layer 4 — layout + data wiring
├── Cockpit (the 300 / fluid / 344 layout)
└── hooks/    # useSnapshot, useEventStream, useLogsTail (wrap the core SDK)
```

## Contracts (locked)

1. **Tokens only via CSS vars.** No hex literals below layer 0. Faction tint
   is always the `--coat` / `--coat-dark` pair set on a wrapper; emblems are
   glyphs, so a new vendor is one `factions.ts` record and zero new art.
2. **HUD composites take plain data props** (a slice of the task envelope).
   They never fetch and never know about SSE.
3. **Scene entities are state-driven.** One `data-state` attribute per entity;
   CSS renders the state (ambient motion = compositor keyframes on
   transform/opacity, zero JS per frame). JS animates only finite transitions:
   island rise/sink, flare launch, sail-off, camera travel.
4. **`app/hooks` is the only layer importing `@useparley/core`.** Everything
   below is testable with plain props.
5. **Settings toggles from day one**: ornaments (corner flourishes), kit band
   (dev style-guide strip), live-log follow, and `prefers-reduced-motion`
   honored globally (ambient animation off; states stay legible as still
   imagery).
6. **Attention hierarchy comes from core constants** — roster grouping, inbox
   sort, and scene emphasis all read the same ordering; no layer re-derives it.

## Scene art direction (locked at prototype)

Procedural inline-SVG pirate style — no sprite sheets, no external assets:

- **Agent ship**: small sloop — planked hull with faction-dark waterline,
  parchment mainsail + jib subtly tinted by coat, faction pennant at masthead;
  bobs while sailing, orbits its island with a wake trail.
- **Orchestrator**: two-masted galleon with gold standard, anchored in the
  session's region.
- **Island**: rocky slopes, sand beach, palm tree, driftwood; animated shore
  foam; a hung wooden name plank labels the task.
- **State effects**: awaiting = anchored + repeating signal flare + PARLEY!
  ribbon; stalled = fog layer, wake stops; completed = green flag hoisted on a
  pole; failed = broken-masted wreck on the beach; cancelled = ship sails off,
  island sinks.
- **Atmosphere**: sea texture drift, slow compass-rose watermark, moonlight
  glint — all CSS keyframes.

Execution refines silhouettes and detail; the style, grammar, and tinting
mechanics above are fixed.
