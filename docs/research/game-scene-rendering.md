# Research: game scene rendering & asset approach (#56)

**Question**: what rendering technology and asset production approach should the
Parley Cove game scene use? The scene: one continuous sea, one region per
orchestrator session (big anchored ship), islands rising/sinking per task,
small vendor-agent ships circling islands with wake trails, state effects
(flare + PARLEY! ribbon, fog bank, flag/dock, shipwreck, sail-away), and a
camera that shows one session at a time and "sails over" on session switch.

**Grounding**: `docs/spec/ui-v1-scope.md` (scene grammar & state mapping),
`docs/design/design-manifest.md` (tokens; *all* existing decoration is inline
SVG + CSS gradients + Unicode glyphs, zero external assets beyond Google
Fonts), `docs/spec/ui-interface-contract.md` (React + Vite bundle served by the
daemon). Verified web facts as of 2026-07-12.

**Scale reality check**: the camera frames one session at a time; a session has
tens of tasks at most. On-screen entity count is ~1 big ship + ≤ a few dozen
islands/small ships/effects. Every option below can render this at 60fps; the
decisive axes are **idle cost** (a HUD left open on a second monitor), bundle
size, React ergonomics, and fit with the manifest's cozy hand-drawn language.

---

## Options

### 1. PixiJS v8 (WebGL/WebGPU sprites)

- **State of the art (verified)**: PixiJS v8 is current; it adds a WebGPU
  backend and much better tree-shaking than v7
  ([v8 launch post](https://pixijs.com/blog/pixi-v8-launches)). The React
  bindings were rewritten from scratch: [`@pixi/react`
  v8](https://pixijs.com/blog/pixi-react-v8-live) is a react-three-fiber-style
  reconciler, **requires React 19+**, actively maintained (8.0.5, Dec 2025)
  ([repo](https://github.com/pixijs/pixi-react),
  [docs](https://react.pixijs.io/)).
- **Perf**: spectacular — v8 benchmarks tout 100k sprites. That headroom is
  ~1000× beyond this scene's needs; it buys nothing here.
- **Idle cost**: Pixi's `Application` runs a continuous rAF ticker by default.
  Render-on-demand is possible (stop the ticker, render on dirty), but ambient
  motion (water drift, circling ships) means the ticker effectively never
  stops → continuous JS + GPU work while the HUD idles. WebGL contexts also
  hold GPU memory permanently.
- **Bundle**: the full `pixi.js` build has historically been the largest item
  in an app bundle (a long-standing issue thread shows even the trimmed legacy
  bundle struggling to get under 370 KB minified —
  [pixijs#6408](https://github.com/pixijs/pixijs/issues/6408)); v8's
  tree-shaking helps but a sprite+graphics+text subset is still on the order of
  a few hundred KB minified. `@pixi/react` adds a second reconciler beside
  react-dom.
- **Text/emoji**: rasterized to textures (Canvas-backed `Text` / `BitmapText`).
  Cinzel/IM Fell chrome, the PARLEY! ribbon, and emoji glyphs all lose the
  crispness and free font handling of DOM text; DPR changes need re-rasterize.
- **Accessibility/inspectability**: a black-box canvas; Pixi's accessibility
  layer bolts invisible DOM nodes on top. Nothing is inspectable in devtools.

### 2. Plain Canvas 2D

- **Bundle**: zero dependencies — the best possible score.
- **Control**: full render-on-demand is easy (only draw when state or an
  animation is active). OffscreenCanvas + worker is now viable everywhere
  (Chrome 69+, Firefox 105+, Safari 16.4+; Safari shipped 2D-in-worker first,
  WebGL contexts in later releases —
  [caniuse](https://caniuse.com/offscreencanvas),
  [MDN](https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas)) —
  but it's over-engineering at this entity count.
- **Cost**: you hand-roll everything Pixi or the DOM gives free — scene graph,
  hit-testing (click island → select task in inspector), z-ordering, DPR
  handling, text layout, and an accessibility mirror. Ambient motion means a
  persistent rAF loop on the main thread, all of it JS-driven.
- **Ergonomics**: imperative escape from React; scene state must be manually
  synced from the store into draw calls.

### 3. Animated SVG/CSS in the DOM

- **Fit**: this is the manifest's native dialect. The sea texture, compass
  rose, corner flourishes, glow pulses, and ribbon bounce are *already*
  specified as inline SVG + CSS keyframes. The scene extends the same system
  instead of introducing a second one.
- **Idle cost**: the best realistic profile. Declarative CSS animations on
  `transform`/`opacity` run on the compositor thread — zero main-thread JS per
  frame — and browsers throttle/pause them (and rAF) entirely in hidden tabs.
  Ambient motion (water drift, ship circling, flare pulse) can be 100% CSS
  keyframes; JS runs only on discrete events (SSE transition → class change;
  session switch → camera travel). Idle JS ≈ 0.
- **React ergonomics**: perfect — the scene is a component tree keyed by task
  id. `pending → running` is a prop change; enter/exit animations are mount
  classes. No reconciler bridge, no imperative sync layer.
- **Bundle**: zero additional dependencies.
- **Text/emoji**: real DOM text — Google Fonts, emoji, selection, ellipsis all
  free. The PARLEY! ribbon component from the HUD is reused verbatim over an
  island.
- **Accessibility**: the scene *is* the DOM — islands are focusable elements
  with `aria-label`s; `prefers-reduced-motion` is a media query away, which is
  exactly the current practice for ambient loops: run them only under
  `(prefers-reduced-motion: no-preference)`, listen via `matchMedia` for live
  toggles, and honor WCAG's pause requirement for >5s animation
  ([Smashing on motion prefs](https://www.smashingmagazine.com/2021/10/respecting-users-motion-preferences/),
  [Smashing on ambient animation](https://www.smashingmagazine.com/2025/09/ambient-animations-web-design-principles-implementation/)).
- **Risk / mitigation**: too many simultaneously animating DOM nodes can cause
  paint churn. Mitigations: animate **only** `transform` and `opacity` (never
  layout properties, no animated `filter: blur`), keep per-entity animated
  nodes small (one wrapper per ship/island), and cap ambient layers. At tens
  of entities this is comfortably within budget; this approach would genuinely
  break down at hundreds+, which the scale check rules out.

### 4. Hybrid (DOM/SVG HUD + canvas/WebGL scene)

The standard answer for game-in-a-dashboard — but it earns its complexity only
when the scene needs per-pixel effects (real water shaders, thousands of
particles). Costs: two rendering systems to keep in sync (state colors, faction
tints, selection), duplicated animation timing, canvas text for anything inside
the scene, and the idle-ticker problem from option 1. The manifest already
fakes water beautifully with two drifting `repeating-linear-gradient`s; nothing
in the v1 effect list needs a shader.

---

## Asset production

### Procedural inline SVG components (recommended)

Each entity (island, big ship, small ship, flare, fog, flag, wreck) is a React
component emitting inline SVG — hand-drawn-feel paths with the manifest's brass
and parchment palette, wobbly strokes, 2–3 layered fills. Matches the existing
compass-rose/flourish approach exactly.

**Faction tinting**: pass the faction record down as CSS custom properties —
`style={{ '--coat': faction.coat, '--coat-dark': faction.coatDark }}` on the
ship wrapper; SVG fills use `fill="var(--coat)"` (or `currentColor` for
single-tint parts). The emblem is a `<text>` glyph in the sail/flag. A new
vendor = one new faction record `{ label, coat, coatDark, emblem, tagline }`,
zero new art — the design brief's extensibility rule holds structurally.

### Sprite sheets (raster)

Tinting means multiply-tint (washes out detail, needs white-base art) or one
sheet per faction (violates extensibility). Raster art needs 1×/2× DPR
variants, clashes with the crisp vector HUD, and creates the external-asset
pipeline the manifest deliberately avoids. Rejected.

### Lottie

`lottie-web` is a sizable runtime (~250 KB min) and, more fundamentally, an
After Effects export pipeline — binary-ish JSON blobs in the repo that only an
AE user can edit. Dynamic recoloring means traversing exported layer trees.
Wrong shape for a code-first, agent-maintained repo. Rejected.

### Rive

Best-in-class state-machine animation, but: WASM runtime, proprietary editor,
`.riv` binaries in the repo, runtime recoloring via named machine inputs that
must be pre-authored. Same editor-dependency objection as Lottie. Rejected.

---

## Recommendation

**Option 3: animated SVG/CSS in the DOM, with procedural inline-SVG assets
tinted via CSS custom properties.** One rendering system for HUD and scene, the
same token vocabulary end to end, zero new dependencies, real text, inspectable
and accessible by construction, and — the killer criterion for a
second-monitor HUD — near-zero idle burn because all ambient motion is
compositor-driven CSS.

Discipline that makes it hold:

1. Ambient loops = CSS keyframes on `transform`/`opacity` only.
2. JS animation (rAF or Web Animations API) only for *finite* transitions:
   island rise/sink, camera travel, flare launch. They start on an SSE event
   and end; idle JS stays zero.
3. All ambient loops gated behind `(prefers-reduced-motion: no-preference)`;
   reduced-motion mode keeps state legible statically (flag, wreck, ribbon,
   fog remain as still imagery; the flare becomes a steady beacon glow).
4. Escape hatch: keep the sea/ambient layer as its own component behind the
   entity layer. If a later version wants shader water, that one layer can
   become a canvas without touching entities, HUD, or camera.

Pixi is the right tool for a different problem (thousands of sprites); adopting
it here buys a second reconciler, a few hundred KB, canvas text, and a
perpetual ticker in exchange for headroom the scene will never use.

## Proof sketch (recommended stack)

Structure — a fixed viewport clipping an oversized "world" plane; the camera is
a transform on the world:

```
<SceneViewport>                      // overflow:hidden, position:relative
  <World style={--cam-x/--cam-y}>    // transform: translate3d(var(--cam-x), var(--cam-y), 0)
    <SeaLayer/>                      // gradient + seaMove drift (CSS, compositor)
    {sessions.map(s =>
      <SessionRegion key={s.id} origin={layout(s)}>   // absolute at its sea coords
        <BigShip faction=…/>                          // anchored, gentle bob keyframe
        {s.tasks.map(t =>
          <TaskIsland key={t.id} state={t.state} style={--coat:…}>
            <IslandSvg/>                              // rise/sink via mount class
            {active(t) && <SmallShip state={t.state}/>}
            {t.state==='awaiting_answer' && <><Flare/><ParleyRibbon/></>}
            {t.state==='stalled' && <FogBank/>}
            {t.state==='completed' && <PlantedFlag/>}
            {t.state==='failed' && <Shipwreck/>}
          </TaskIsland>)}
      </SessionRegion>)}
  </World>
  <HudOverlay/>                      // panels, unaffected by camera
</SceneViewport>
```

**Island rises** (finite, JS-triggered, CSS-executed): on task creation the
island mounts with class `rising`; a one-shot keyframe translates it up from
below a `clip-path` waterline with a small overshoot, plus an expanding-ring
ripple `<circle>` that fades. `sinking` mirrors it on clean/cancel, removing
the node on `animationend`.

**Ship circles** (ambient, pure CSS): the small ship sits in an orbit wrapper —
`.orbit { animation: orbit 14s linear infinite }` rotating the wrapper around
the island center; a counter-rotation on the hull keeps it tangent to the
path. The wake is 2–3 trailing SVG dashes on the orbit wrapper fading via an
opacity keyframe. `stalled` pauses the orbit (`animation-play-state: paused`)
and adds a slow drift; `awaiting_answer` stops the orbit and swaps in the
anchored pose.

**Flare fires** (event → finite + ambient): on `task.question` the flare
component mounts: a one-shot launch keyframe (translateY up, ease-out) into a
looping beacon pulse (scale/opacity, the manifest's `beacon` timing) at the
island's peak, plus the existing PARLEY! ribbon component with `bannerBounce`.
Gold glow uses the `#ffcf4d` token so scene and roster agree.

**Camera travel** (finite, JS-driven): each session region gets deterministic
world coordinates (e.g. hash of session id → slot on a spiral/grid, so
positions are stable across reloads). Selecting a session animates
`--cam-x/--cam-y` from current to `-target.origin` with an eased rAF tween or
WAAPI animation (~1.2 s, gentle S-curve — "sailing", not teleporting), slightly
speeding the sea-drift during travel for a motion cue. Under reduced motion the
camera cuts instantly. Sessions whose tasks are all terminal age out by fading
their region before unmount.

**Idle profile check**: steady state (one session, ships circling, water
drifting) = 0 JS/frame; compositor animates a handful of transform layers;
hidden tab = throttled to nothing by the browser.

## Sources

- [PixiJS v8 launch](https://pixijs.com/blog/pixi-v8-launches) — WebGPU, tree-shaking, perf numbers
- [Introducing PixiJS React v8](https://pixijs.com/blog/pixi-react-v8-live) / [react.pixijs.io](https://react.pixijs.io/) / [pixijs/pixi-react](https://github.com/pixijs/pixi-react) — rewrite, React 19 requirement
- [pixijs#6408](https://github.com/pixijs/pixijs/issues/6408) — bundle-size struggle datapoint
- [caniuse: OffscreenCanvas](https://caniuse.com/offscreencanvas) / [MDN](https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas) — Chrome 69+, Firefox 105+, Safari 16.4+ (2D first)
- [Smashing: respecting motion preferences](https://www.smashingmagazine.com/2021/10/respecting-users-motion-preferences/), [Smashing: ambient animations](https://www.smashingmagazine.com/2025/09/ambient-animations-web-design-principles-implementation/) — reduced-motion & ambient-loop practice
