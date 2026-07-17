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
  /** Faction/vendor display name for the emblem's accessible label + tooltip. */
  faction: string;
  /** `branch · id` style meta line. */
  meta: string;
  /**
   * Display-layer freshness for `failed` rows only (hooks-projected). When
   * true, the row is undimmed with a coral beacon and the failed group sorts
   * just under stalled. When false/undefined, archive treatment from
   * STATE_META applies (dim, no beacon, quiet rank).
   */
  freshFailure?: boolean;
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
  /** Faction/vendor display name for the emblem's accessible label + tooltip. */
  faction: string;
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

/** One file the report says it touched (path only — no add/del counts on the wire). */
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
  /** ISO-8601 when the question was recorded (wire `asked_at`). */
  askedAt: string;
  /** ISO-8601 when answered; null while outstanding (wire `answered_at`). */
  answeredAt: string | null;
}

/** The full inspector payload for the selected task (design-manifest §4.17). */
export interface InspectorTask {
  id: string;
  name: string;
  coat: string;
  emblem: EmblemMark;
  /** Faction/vendor display name for the emblem's accessible label + tooltip. */
  faction: string;
  /** Task state string (matches a `StateKey`) — drives the header's state badge. */
  state: string;
  /** Terminal failure cause from the task detail payload, or null when none. */
  error: string | null;
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
  /** Distinct orchestrator sessions with live tasks. */
  durableSessions: number;
}

/** One size/difficulty eval bucket under a Soundings group (#119). */
export interface SoundingsEvalBucket {
  key: string;
  /** Pre-formatted average with sample count, e.g. `4.2 · n=3`. */
  avg: string;
  count: number;
}

/** One metrics group as the Soundings plate renders it (#119). */
export interface SoundingsGroupView {
  /** Wire group key (null when the dimension was unset for that bucket). */
  key: string | null;
  /** Display label (`(none)` when key is null). */
  label: string;
  tasks: {
    total: number;
    done: number;
    failed: number;
    running: number;
  };
  /** Pre-formatted success rate (`87.5%` or `—`). */
  successRate: string;
  /** Raw 0–1 rate for the micro-bar; null when no decided tasks. */
  successRateValue: number | null;
  /** Pre-formatted eval average (`4.2 · n=12` or `—`). */
  evals: string;
  tokens: {
    input: string;
    output: string;
    cached: string;
  };
  duration: {
    avg: string;
    p95: string;
  };
  /** Size breakdown — empty when no size-tagged evals. */
  evalsBySize: SoundingsEvalBucket[];
  /** Difficulty breakdown — empty when no difficulty-tagged evals. */
  evalsByDifficulty: SoundingsEvalBucket[];
}

/**
 * Plain Soundings dashboard props (#119). Status is fully projected so the
 * plate never interprets wire shapes or loading policy.
 */
export interface SoundingsView {
  /**
   * `loading` — taking soundings (first fetch or idle before enable).
   * `ready` — groups present.
   * `empty` — successful fetch with no groups.
   * `error` — last fetch failed (may still show prior groups).
   */
  status: "loading" | "ready" | "empty" | "error";
  error: string | null;
  groups: SoundingsGroupView[];
  /** Active group-by dimension string (vendor|model|profile|size|difficulty|type). */
  groupBy: string;
  /** Session scope label (`All hands` or short session id). */
  sessionLabel: string;
  /** ISO timestamp from the response, or null before first success. */
  generatedAt: string | null;
}
