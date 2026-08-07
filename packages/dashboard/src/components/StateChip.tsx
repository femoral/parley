/**
 * State chip — square 7px dot + uppercase mono label (DESIGN.md).
 * One canonical implementation for fleet, run, task, and metrics (#367).
 * Pulse is reserved for running (or explicit live) — animation only means live.
 */

const LABEL: Record<string, string> = {
  pending: "PENDING",
  queued: "QUEUED",
  running: "RUNNING",
  awaiting_answer: "AWAITING",
  awaiting: "AWAITING",
  stalled: "STALLED",
  completed: "DONE",
  failed: "FAILED",
  cancelled: "CANCEL",
  purged: "PURGED",
};

/** Normalize wire/token aliases onto the CSS modifier set. */
export function chipStateKey(state: string): string {
  if (state === "awaiting") return "awaiting_answer";
  return state;
}

export function stateLabel(state: string): string {
  return LABEL[state] ?? state.replace(/_/g, " ").toUpperCase();
}

export interface StateChipProps {
  /** Wire state or run StateToken (e.g. awaiting_answer or awaiting). */
  state: string;
  label?: string;
  /** Force live pulse; otherwise running (and only running) pulses. */
  live?: boolean;
  testId?: string;
  className?: string;
}

export function StateChip({
  state,
  label,
  live = false,
  testId,
  className = "",
}: StateChipProps) {
  const key = chipStateKey(state);
  const pulse = live || key === "running";
  return (
    <span
      className={`pc-chip pc-chip--${key} ${className}`.trim()}
      data-state={key === "awaiting_answer" && state === "awaiting" ? "awaiting_answer" : key}
      data-state-token={state === "awaiting" || state === "awaiting_answer" ? "awaiting" : key}
      data-testid={testId}
    >
      <span
        className={`pc-chip__dot${pulse ? " pc-chip__dot--live" : ""}`}
        aria-hidden="true"
      />
      <span className="pc-chip__label">{label ?? stateLabel(key)}</span>
    </span>
  );
}
