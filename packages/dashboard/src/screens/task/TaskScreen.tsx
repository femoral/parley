import type { ScreenMountProps } from "../types.js";

/** Task inspector mount — #357 owns the full screen. */
export function TaskScreen(props: ScreenMountProps) {
  return (
    <div className="pc-screen" data-testid="screen-task" data-screen="task">
      <div className="pc-screen__head">
        <span className="pc-screen__eyebrow">center screen</span>
        <h1 className="pc-screen__title">Task inspector</h1>
      </div>
      <p className="pc-screen__note">
        Brief, attempt chain, log tail, Q&amp;A, and report land in the task
        ticket.
        {props.selectedTaskId
          ? ` Selected task ${props.selectedTaskId}.`
          : " No task selected."}
      </p>
    </div>
  );
}
