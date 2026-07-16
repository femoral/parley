/**
 * Layer 3 — far-horizon parallax strip (Lantern Watch). Renders the lantern
 * `horizon.svg` silhouettes as a viewport-space layer behind the panning world
 * (sibling of the camera, like the Sea). Recoloured via CSS mask + fill to a
 * misty deep-sea hue; drifts very slowly sideways and shifts a small parallax
 * amount when the camera sails (via `--cam-x` / `--cam-y` set once per sail).
 *
 * Nested shells keep camera parallax (transition) and ambient drift (animation)
 * on separate transform owners — zero JS per frame.
 */
export function Horizon() {
  return (
    <div className="pc-scene-horizon" aria-hidden="true">
      <div className="pc-scene-horizon__parallax">
        <div className="pc-scene-horizon__drift">
          <span className="pc-scene-horizon__sil" />
        </div>
      </div>
    </div>
  );
}
