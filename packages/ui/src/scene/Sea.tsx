/**
 * Layer 3 — the scene's water within the viewport. Sits behind the camera plane
 * (so it doesn't pan with the fleet — a parallax cue), adding dual moonlight
 * glint layers and a horizon darkening over the cockpit's global sea texture.
 * Pure CSS; both sparkle drifts are compositor keyframes (counter-drifting for
 * depth). Base transforms are identity so reduced-motion stills legibly.
 */
export function Sea() {
  return (
    <div className="pc-scene-sea" aria-hidden="true">
      <span className="pc-scene-sea__glint" />
      <span className="pc-scene-sea__glint pc-scene-sea__glint--deep" />
    </div>
  );
}
