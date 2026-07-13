/** Layer 3 effect — the stalled fog bank (design-manifest §5): a cool slate haze
 * that rolls over the island while the ship sits adrift. Tinted with the
 * `--state-stalled` token; drifts sideways on a compositor keyframe, holding as a
 * static bank under reduced motion. */
export function Fog() {
  return (
    <span className="pc-fog" aria-hidden="true">
      <span className="pc-fog__bank" />
      <span className="pc-fog__bank pc-fog__bank--far" />
    </span>
  );
}
