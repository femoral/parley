/**
 * Layer 2 — the plain data shapes hud composites consume. Deliberately free of
 * `@useparley/core` types: the hooks layer projects the SDK envelopes into these
 * (contract 2 — hud takes plain props), so every hud component stays testable
 * with hand-written fixtures.
 */

/** One task as the roster renders it. */
export interface RosterTask {
  id: string;
  name: string;
  /** Faction coat colour (hex) for the emblem chip. */
  coat: string;
  /** Faction emblem glyph. */
  emblem: string;
  /** `branch · id` style meta line. */
  meta: string;
}

/** A roster state group — already ordered by attention rank in the hooks layer. */
export interface RosterGroup {
  /** Task state string (matches a `StateKey`). */
  state: string;
  tasks: RosterTask[];
}

/** One entry in the roster's session selector — an orchestrator session and
 * how many tasks it currently has in the roster (live and historical). */
export interface RosterSessionOption {
  id: string;
  /** Short display label (truncated id). */
  label: string;
  count: number;
}

/** One task awaiting an answer, as the inbox renders it (design-manifest §4.15). */
export interface InboxTask {
  id: string;
  name: string;
  /** Task state string (matches a `StateKey`) — drives the card's badge via
   * `stateMetaFor`, the same lookup `RosterPanel` reads, so the label/glyph/
   * colour never drifts from the layer-0 state language. */
  state: string;
  /** Faction coat colour (hex) for the emblem chip. */
  coat: string;
  /** Faction emblem glyph. */
  emblem: string;
  /** `branch · id` style meta line, same shape as the roster row's. */
  meta: string;
  /** The outstanding question text. */
  question: string;
}

/** The daemon health readout, fully projected to display values by the hooks layer. */
export interface HealthView {
  /** Whether the daemon answered the last probe. */
  online: boolean;
  /** Daemon package version, or null before the first successful probe. */
  version: string | null;
  /** Daemon process id, or null before the first successful probe. */
  pid: number | null;
  /** Origin host the cockpit is served from. */
  host: string;
  /** Origin port the cockpit is served from. */
  port: string;
  /** Pre-formatted uptime, e.g. "3m 41s" (empty before the first probe). */
  uptime: string;
  /** Non-terminal task count (running/awaiting/pending/stalled). */
  activeAgents: number;
  /** Total tasks known to the daemon. */
  totalTasks: number;
  /** Distinct orchestrator sessions with live tasks. */
  durableSessions: number;
}
