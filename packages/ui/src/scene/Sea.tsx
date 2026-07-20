/**
 * Layer 3 — scene water slot within the viewport. Sits behind the camera plane
 * (so it doesn't pan with the fleet — a parallax cue). The room paints one
 * continuous sea + vignette; the sailing canvas continues that math when
 * mounted. No ambient motion here (glint/stripes removed with #124 / #189).
 */
export function Sea() {
  return <div className="pc-scene-sea" aria-hidden="true" />;
}
