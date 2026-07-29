# Chart measurement lab

A dev-only harness that renders the **real** `RunChart` inside the **real**
cockpit column geometry in a headless browser, and reports where ink actually
landed.

Nothing here ships. Vite builds `packages/ui/index.html` alone, so this page
never reaches `www`, and `package.json` publishes `www` only.

## Why it exists

The unit suite runs under **happy-dom, which performs no layout**. Every box is
zero-sized, no text is shaped, nothing is painted. For any question about where
ink lands it is not evidence — it passed green in both the defective and the
fixed state of #267 and #268.

That gap has cost real work:

- #267's original report had every number wrong in the same direction. The
  issue said the chart key was below the fold at 1920×1200 in all cases;
  rendered measurement showed 14 of 16 cells fine, and turned up a **larger
  unfiled defect the issue did not know about** — 60,641 px² of key-on-mark
  overprint at narrow columns.
- Two implementation attempts on it failed because their reserves were derived
  from an **assumed** sheet scale.
- #271 was filed against the wrong victim entirely: it reported legend ink
  painting under the compass rose, which measures **0 px² at every viewport**.
  The real defect was silent clipping at the sheet's edge.

**The sheet's scale is not a constant.** It runs about 0.385 px per viewBox
unit at the narrowest desktop triptych, 1.224 at 1920, and the stacked layout
below the 1080px breakpoint reaches higher still. A claim measured at one scale
says nothing about the others.

So: recompute or re-render any number in a chart issue before acting on it.

## Running it

```sh
node lab/sweep.mjs --probe geometry
node lab/sweep.mjs --probe overprint --viewports 320x800,1081x800 --nodes 2,3,5
node lab/sweep.mjs --probe clipped --workflow onelongunbrokentokenname
node lab/sweep.mjs --probe belowFold --nodes 12,16,20 --json out.json
node lab/sweep.mjs --help
```

It starts its own Vite dev server on an ephemeral port and shuts it down after,
so parallel runs never collide. `--shots <dir>` saves a PNG per cell — worth
doing whenever a number surprises you, because some of them are artifacts and a
screenshot settles it in seconds.

To open the page by hand instead: `pnpm dev`, then `/lab/?n=8&held=0`. Query
params are `n` (node count), `held` (`0`/`1`), `workflow` (the run's name).

### Chromium

Needs a Chromium binary; `playwright-core` ships none. Resolution order is
`$PARLEY_LAB_CHROMIUM`, then a Playwright-managed browser in the local cache,
then a system Chrome/Chromium. If none is found:

```sh
npx playwright install chromium
```

## The probes

| probe | answers |
| --- | --- |
| `geometry` | sheet/plot/rail widths, and the px-per-viewBox scale each viewport resolves to |
| `overprint` | painted area where one ink group lands on another |
| `clipped` | title ink cut off by the sheet's `overflow: hidden` |
| `belowFold` | marks and labels below the initial viewport fold |

## Reading the numbers honestly

**Measure ink, not boxes.** `getBoundingClientRect()` on a text container reads
clean while the glyphs overflow it. Text is measured with
`Range.getClientRects()`, which returns painted line boxes. This is not a
detail: it is why #267's overprint survived three review passes and why #271
named the wrong victim.

**Wait for fonts.** The lab sets `data-lab-ready` on `<html>` after
`document.fonts.ready`. Cinzel and IM Fell shape very differently from the
fallback stack, so any ink measured before that is wrong. The sweep waits.

**Not every overlap is a defect.** The `overprint` probe encodes three
exclusions, each found by asking why it reported thousands of px² on charts
that render perfectly clean:

- a mark's label against **its own** ring is the design, not a collision (and
  the destination's ✗ against its own caption likewise);
- the **compass rose** is a watermark painted *under* the route at half
  opacity — only marginalia must avoid it;
- mark rings are compared as their **painted disc**, not their border box,
  whose empty corners are about 21% of its area.

Before filing anything this probe reports, take a `--shots` screenshot and look
at it. A measurement you have not seen is a claim, not a finding.

**Below 1081px the rails collapse** and the triptych's column geometry no
longer applies — but the stacked layout still renders a real sheet, and real
defects live there (#272 tracks overprint measured at 320–370px). Sweep that
range separately rather than assuming it is meaningless.

## Keeping it honest

The fixture is typechecked with the rest of `src`, so if `RunChart`'s props or
the inspector types change, it fails `pnpm typecheck` rather than silently
drifting into measuring a fiction.

What it cannot tell you: whether a chart is *good*. It measures collisions,
clipping and geometry. Everything about hierarchy, rhythm and legibility is
still a matter for looking at it.
