import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Reduced-motion regression guard (#70's accessibility pass).
 *
 * CSS still owns the ambient/attention loops, while the sailing driver owns
 * ship travel, orbit, and swell. The wildcard CSS rule stills the former; the
 * companion `reduced-motion-scene.test.tsx` proves the latter reads matchMedia
 * and freezes its sim clock at the on-station pose.
 *
 * Happy DOM does not paint canvas pixels or interpolate CSS keyframes, so
 * canvas compositing remains a browser visual check. What is testable and
 * load-bearing is (a) the override rule actually exists
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
