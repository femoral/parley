/**
 * Layer 3 — the scene's water within the viewport. Sits behind the camera plane
 * (so it doesn't pan with the fleet — a parallax cue), adding a soft moonlit
 * vignette wash, a moonlight glint, and horizon darkening over the cockpit's
 * global sea texture. Pure CSS; the drift is a compositor keyframe. No moon
 * disc, no clouds — uncluttered night sea only.
 */
export function Sea() {
  return (
    <div className="pc-scene-sea" aria-hidden="true">
      <span className="pc-scene-sea__glint" />
    </div>
  );
}
