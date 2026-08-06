/**
 * State chip — square dot + uppercase mono label (DESIGN.md).
 * Pulse is reserved for running only (not awaiting/stalled).
 */

const LABEL: Record<string, string> = {
  pending: "PENDING",
  queued: "QUEUED",
  running: "RUNNING",
  awaiting_answer: "AWAITING",
  stalled: "STALLED",
  completed: "DONE",
  failed: "FAILED",
  cancelled: "CANCEL",
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
  // DESIGN.md: animation only means live data — running-state dots, not all chips.
  const pulse = live || state === "running";
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
