/**
 * Layer 2 — the plain data shapes hud composites consume. Deliberately free of
 * `@useparley/core` types: the hooks layer projects the SDK envelopes into these
 * (contract 2 — hud takes plain props), so every hud component stays testable
 * with hand-written fixtures.
 */

import type { EmblemMark } from "../tokens/factions.js";

/** One task as the roster renders it. */
export interface RosterTask {
  id: string;
  name: string;
  /** Faction coat colour (hex) for the emblem chip. */
  coat: string;
  /** Faction emblem mark (glyph or original SVG path data). */
  emblem: EmblemMark;
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

/**
 * One hit from the roster's historical session search (#88). Plain hud shape —
 * the hooks layer maps the wire `OrchestratorSession` into this.
 */
export interface RosterSessionSearchHit {
  id: string;
  /** Short display label (truncated id). */
  label: string;
  taskCount: number;
  /** ISO-8601 last activity; used for ordering results, not displayed. */
  lastActivityAt: string;
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
  /** Faction emblem mark (glyph or original SVG path data). */
  emblem: EmblemMark;
  /** `branch · id` style meta line, same shape as the roster row's. */
  meta: string;
  /** The outstanding question text. */
  question: string;
  /** Orchestrator session this task belongs to, or null when unknown. */
  sessionId: string | null;
}

/** One raw log line as the Logs tab renders it (design-manifest §4.17/§2.8). */
export interface LogLine {
  /** Stable key for the list (source order — a line never changes once tailed). */
  key: number;
  /** Classified kind driving the line's colour (falls back to the muted tan). */
  kind: "reasoning" | "tool" | "shell" | "stdout" | "error" | "question" | "fallback";
  /** Friendly rendered text (the raw line, unwrapped from its JSON envelope where possible). */
  text: string;
}

/** The Logs tab's plain props (design-manifest §4.17 "Logs"). */
export interface LogsView {
  lines: LogLine[];
  /** Whether the tail is still following (task not yet at `eof`). */
  live: boolean;
}

/** The Brief tab's plain props (design-manifest §4.17 "Brief"). */
export interface BriefView {
  goal: string | null;
  branch: string | null;
  worktree: string | null;
  model: string | null;
  effort: string | null;
  sandbox: string | null;
  network: boolean | null;
  /** Pre-formatted duration, e.g. "3m 41s", or null before the task has one. */
  duration: string | null;
  /** Pre-formatted token usage, e.g. "1.2k ▸ 340", or null when unknown. */
  usage: string | null;
}

/** One file the report says it touched (design-manifest §4.17 "Report" — "+ path"). */
export interface ReportFile {
  path: string;
}

/** The Report tab's plain props; `null` renders the manifest's empty state. */
export interface ReportView {
  outcome: "success" | "partial" | "blocked";
  summary: string;
  files: ReportFile[];
}

/** One turn of the Q&A transcript (design-manifest §4.17 "Q&A"). `answer` is
 * `null` while the question is still outstanding. */
export interface QaTurn {
  /** Stable turn identity (wire `question_id`); safe React key across rehydrate. */
  id: string;
  question: string;
  answer: string | null;
}

/** The full inspector payload for the selected task (design-manifest §4.17). */
export interface InspectorTask {
  id: string;
  name: string;
  coat: string;
  emblem: EmblemMark;
  /** Task state string (matches a `StateKey`) — drives the header's state badge. */
  state: string;
  /** Eval score out of 10, when the task has been eval'd (else null). */
  evalScore: number | null;
  evalFeedback: string | null;
  brief: BriefView;
  logs: LogsView;
  report: ReportView | null;
  qa: QaTurn[];
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
