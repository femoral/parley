import type { ScreenMountProps } from "../types.js";

/**
 * Fleet board mount — #355 owns the full screen.
 * Shell leaves a documented placeholder so geometry and a11y proofs run today.
 */
export function FleetScreen(_props: ScreenMountProps) {
  return (
    <div className="pc-screen" data-testid="screen-fleet" data-screen="fleet">
      <div className="pc-screen__head">
        <span className="pc-screen__eyebrow">center screen</span>
        <h1 className="pc-screen__title">Fleet board</h1>
      </div>
      <p className="pc-screen__note">
        KPI strip, runs table, and tasks table land in the fleet ticket. Shell
        chrome (nav, find, settings, honesty) is live.
      </p>
    </div>
  );
}
