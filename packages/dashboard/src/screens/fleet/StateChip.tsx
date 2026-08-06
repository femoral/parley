/** State chip — square dot + uppercase mono label (DESIGN.md). */

const LIVE_STATES = new Set(["running", "awaiting_answer", "stalled"]);

const LABEL: Record<string, string> = {
  pending: "PENDING",
  queued: "QUEUED",
  running: "RUNNING",
  awaiting_answer: "AWAITING",
  stalled: "STALLED",
  completed: "COMPLETED",
  failed: "FAILED",
  cancelled: "CANCELLED",
  purged: "PURGED",
};

export function stateLabel(state: string): string {
  return LABEL[state] ?? state.replace(/_/g, " ").toUpperCase();
}

export function StateChip({
  state,
  label,
  live = false,
}: {
  state: string;
  label?: string;
  live?: boolean;
}) {
  const pulse = live || LIVE_STATES.has(state);
  return (
    <span className={`pc-fleet-chip pc-fleet-chip--${state}`} data-state={state}>
      <span
        className={`pc-fleet-chip__dot${pulse ? " pc-fleet-chip__dot--live" : ""}`}
        aria-hidden="true"
      />
      <span className="pc-fleet-chip__label">{label ?? stateLabel(state)}</span>
    </span>
  );
}
