/** Layer 3 effect — the awaiting-answer signal flare (design-manifest §5, the
 * loudest thing on screen). A beacon fired over the island: a gold glow halo, a
 * bright core, and a four-point spark, all in the `--state-awaiting_answer`
 * token so the scene, roster flag, and inbox share one gold. Ambient pulse is a
 * compositor keyframe; under reduced motion it holds as a steady beacon. */
export function Flare() {
  return (
    <span className="pc-flare" aria-hidden="true">
      <span className="pc-flare__glow" />
      <svg className="pc-flare__spark" viewBox="0 0 24 24">
        <path
          d="M12 0 L14 10 L24 12 L14 14 L12 24 L10 14 L0 12 L10 10 Z"
          fill="var(--state-awaiting_answer)"
        />
        <circle cx="12" cy="12" r="3.2" fill="var(--alert-cream)" />
      </svg>
    </span>
  );
}
