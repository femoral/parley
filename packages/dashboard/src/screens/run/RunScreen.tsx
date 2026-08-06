import type { ScreenMountProps } from "../types.js";

/** Run detail mount — #356 owns the full screen. */
export function RunScreen(props: ScreenMountProps) {
  return (
    <div className="pc-screen" data-testid="screen-run" data-screen="run">
      <div className="pc-screen__head">
        <span className="pc-screen__eyebrow">center screen</span>
        <h1 className="pc-screen__title">Run detail</h1>
      </div>
      <p className="pc-screen__note">
        Pipeline / iteration grid / node table land in the run ticket.
        {props.selectedRunId
          ? ` Selected run ${props.selectedRunId}.`
          : " No run selected."}
      </p>
    </div>
  );
}
