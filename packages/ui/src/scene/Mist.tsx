/**
 * Layer 3 — horizon mist bands (Lantern Watch). Very subtle horizontal haze
 * drifting slowly between the far-horizon silhouettes and the world. Kept near
 * the horizon only and at low opacity so it never reads as the stalled-state
 * fog bank (state-honesty law) and never obscures islands or ships.
 */
export function Mist() {
  return (
    <div className="pc-scene-mist" aria-hidden="true">
      <span className="pc-scene-mist__band" />
      <span className="pc-scene-mist__band pc-scene-mist__band--far" />
    </div>
  );
}
