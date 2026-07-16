import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Reduced-motion regression guard (#70's accessibility pass).
 *
 * Every ambient/attention animation in the package (sea drift, compass spin,
 * beacon pulse, galleon/sloop bob, island rise/sink, shore foam, voyage, wake,
 * flare, fog drift, flag wave, sail-off, camera travel, PARLEY! bounce) is
 * driven by plain CSS `animation`/`transition` declarations — there is no
 * JS-side motion logic in the package (grepped: no `requestAnimationFrame`,
 * no `setTimeout`-driven visual tweening; `useLogTail`'s poll timer and the
 * one-second clock in `useCockpit` are data refreshes, not animation). A
 * single wildcard rule in tokens.css (`*, *::before, *::after` under
 * `@media (prefers-reduced-motion: reduce)`) is therefore sufficient to still
 * every one of them, rather than each needing its own override — see that
 * rule's own comment for the audit.
 *
 * `window.matchMedia` mocking (the task's "test with matchMedia mocking where
 * practical") isn't practical *here*: nothing in this package's JS reads
 * `matchMedia` (the mechanism is pure CSS), and happy-dom/jsdom don't
 * evaluate `@media` blocks or interpolate `@keyframes` against computed
 * style, so a mocked-media component test would assert nothing real. What
 * *is* testable and load-bearing is (a) the override rule actually exists
 * with the right shape (this file, via source inspection) and (b) that
 * disabling animation timing can never make a state ambiguous, because every
 * state is already encoded structurally via `data-state` and distinct child
 * elements/markers, not only through motion — see `tests/scene.test.tsx`'s
 * per-state assertions (flare + PARLEY! ribbon for awaiting, fog for stalled,
 * planted flag for completed, wreck for failed, sail-off pose for cancelled,
 * etc.), which hold with or without any animation running at all.
 */

const TOKENS_CSS = fs.readFileSync(
  fileURLToPath(new URL("../src/tokens/tokens.css", import.meta.url)),
  "utf8",
);

describe("the global prefers-reduced-motion rule (tokens.css)", () => {
  it("exists, scoped to the reduced-motion media query", () => {
    expect(TOKENS_CSS).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("targets every element, including pseudo-elements", () => {
    expect(TOKENS_CSS).toMatch(/\*,\s*\n\s*\*::before,\s*\n\s*\*::after\s*\{/);
  });

  it("forces animation duration, delay, and iteration count to their still-frame values", () => {
    // Duration ~0 and iteration-count 1 land every keyframe on its resting
    // frame (each animated rule's own comment documents that frame as the
    // legible base state); animation-delay 0 kills the wake trail's staggered
    // 0.2s/0.4s per-dash delays so nothing visibly trickles in.
    expect(TOKENS_CSS).toContain("animation-duration: 0.001ms !important");
    expect(TOKENS_CSS).toContain("animation-delay: 0s !important");
    expect(TOKENS_CSS).toContain("animation-iteration-count: 1 !important");
  });

  it("forces transition duration and delay too (the camera-travel transform transition)", () => {
    expect(TOKENS_CSS).toContain("transition-duration: 0.001ms !important");
    expect(TOKENS_CSS).toContain("transition-delay: 0s !important");
  });
});
