/**
 * Layer 3 — night sky ambience (Lantern Watch). A thin crescent moon and a
 * sparse handful of faint stars, plus a soft cool moonlight column on the water
 * below. Pure CSS/inline-SVG; optional slow twinkle on a few stars. Viewport-
 * space (sibling of the camera) so it does not pan with the fleet.
 *
 * Environmental only — never imitates state visuals (flare gold, stalled fog).
 */
export function Sky() {
  return (
    <div className="pc-scene-sky" aria-hidden="true">
      <span className="pc-scene-sky__moonpath" />
      <svg className="pc-scene-sky__moon" viewBox="0 0 24 24">
        {/* Outer disc minus offset disc → thin cool crescent. */}
        <path
          fillRule="evenodd"
          d="M14.2 3.2A9 9 0 1 0 20.5 14.5 7.2 7.2 0 0 1 14.2 3.2z"
        />
      </svg>
      {/* Sparse field — positions are deliberate, not random noise. */}
      <span className="pc-scene-sky__star" style={{ left: "12%", top: "8%" }} />
      <span className="pc-scene-sky__star" style={{ left: "22%", top: "18%" }} />
      <span className="pc-scene-sky__star pc-scene-sky__star--twinkle" style={{ left: "38%", top: "6%" }} />
      <span className="pc-scene-sky__star" style={{ left: "55%", top: "14%" }} />
      <span className="pc-scene-sky__star pc-scene-sky__star--twinkle" style={{ left: "68%", top: "9%" }} />
      <span className="pc-scene-sky__star" style={{ left: "78%", top: "20%" }} />
      <span className="pc-scene-sky__star pc-scene-sky__star--twinkle-slow" style={{ left: "88%", top: "11%" }} />
      <span className="pc-scene-sky__star" style={{ left: "8%", top: "22%" }} />
    </div>
  );
}
