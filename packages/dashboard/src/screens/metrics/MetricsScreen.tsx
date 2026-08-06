import type { ScreenMountProps } from "../types.js";

/** Metrics mount — #358 owns the full screen. */
export function MetricsScreen(_props: ScreenMountProps) {
  return (
    <div className="pc-screen" data-testid="screen-metrics" data-screen="metrics">
      <div className="pc-screen__head">
        <span className="pc-screen__eyebrow">center screen</span>
        <h1 className="pc-screen__title">Metrics</h1>
      </div>
      <p className="pc-screen__note">
        Group-by table, distribution, and criterion heatmap land in the metrics
        ticket.
      </p>
    </div>
  );
}
