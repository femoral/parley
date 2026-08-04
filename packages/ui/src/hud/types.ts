/**
 * Layer 2 — the plain data shapes hud composites consume. Deliberately free of
 * `@useparley/core` types: the hooks layer projects the SDK envelopes into these
 * (contract 2 — hud takes plain props), so every hud component stays testable
 * with hand-written fixtures.
 */

import type { EmblemMark } from "../tokens/factions.js";

/** Shared visual identity produced once by hooks and sliced into each Cove view. */
export interface DisplayIdentity {
  /** Faction coat colour (hex) for emblem chips and scene vessels. */
  coat: string;
  /** Darker coat (hex) for scene hulls, waterlines, and pennants. */
  coatDark: string;
  /** Model-maker emblem mark (glyph or original SVG path data). */
  emblem: EmblemMark;
  /** Model-maker/harness display name for accessible labels and tooltips. */
  faction: string;
  /** `branch · id` style meta line. */
  meta: string;
}

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
   * ISO-8601 last-activity timestamp from the wire (`updated_at`). Used for
   * quiet relative age on attention-state rows (awaiting / stalled / fresh
   * failed). Absent when the projection has no clock for this row.
   */
  updatedAt?: string | null;
  /**
   * Display-layer freshness for `failed` rows only (hooks-projected). When
   * true, the row is undimmed with a coral beacon and the failed group sorts
   * just under stalled. When false/undefined, archive treatment from
   * STATE_META applies (dim, no beacon, quiet rank).
   */
  freshFailure?: boolean;
  /**
   * Run chip for run-owned tasks (`7f3a · review.2.tests`). Null/absent for
   * plain tasks (#254).
   */
  runChip?: string | null;
  /**
   * Executor attribution label when informative: runner name always, or
   * `local` only in a multi-executor fleet. Null/absent → hide the line
   * (zero-runner installs must not stamp every row "on local") (#324 F4).
   */
  executor?: string | null;
}

/**
 * One pip on a run row's static track (`nodes × loop.max`). Kind carries
 * state without depending on fan-out width (#254).
 */
export type RosterPipKind = "done" | "live" | "gate" | "fail" | "empty";

export interface RosterPip {
  kind: RosterPipKind;
}

/**
 * One run as the roster renders it — a **peer row** beside tasks, never a
 * collapsible group over them (ADR-0021 / #254).
 */
export interface RosterRun {
  id: string;
  /** Workflow id (primary name). */
  name: string;
  /**
   * Attention group this run sits in (task StateKey vocabulary). `blocked`
   * maps to `awaiting_answer` so a held gate rides the awaiting tier.
   */
  attentionState: string;
  /** Wire run lifecycle state (`running` | `blocked` | …). */
  runState: string;
  /** Quiet subline under the name (current node / held gate). */
  subtitle: string;
  /** Meta rollup (`pass 2 · 6 tasks · 11m`). */
  meta: string;
  /** True when the run is blocked on a held gate. */
  heldGate: boolean;
  /** Static-length pip track (`nodes × loop.max`). */
  pips: RosterPip[];
  /** ISO-8601 last activity. */
  updatedAt?: string | null;
  /** Orchestrator session for chip filtering; null when unbound. */
  orchestratorSession: string | null;
}

/** A roster state group — already ordered by attention rank in the hooks layer. */
export interface RosterGroup {
  /** Task state string (matches a `StateKey`). */
  state: string;
  tasks: RosterTask[];
  /**
   * Run peers in this attention group. Flat list — never nested under
   * tasks (#254). Absent or empty when the group has no runs.
   */
  runs?: RosterRun[];
}

/** One entry in the roster's session selector — an orchestrator session and
 * how many tasks it currently has in the roster (live and historical). */
export interface RosterSessionOption {
  id: string;
  /**
   * Human primary handle (first task name, or shortRef fallback). Outfit body
   * tier on chips; never a bare hex when a task name exists.
   */
  handle: string;
  /** 8-char short ref — mono meta secondary identifier. */
  shortRef: string;
  /**
   * Single-string display for tight surfaces (Soundings scope, edge chips,
   * scene banners): `"handle · N tasks"`.
   */
  label: string;
  count: number;
}

/**
 * One session hit from the roster Find surface (#88). Plain hud shape — the
 * hooks layer maps the wire `OrchestratorSession` (and live enrichment) into this.
 */
export interface RosterSessionSearchHit {
  kind: "session";
  id: string;
  /** Human handle when known from the live fleet; else shortRef. */
  handle: string;
  /** 8-char short ref — mono meta. */
  shortRef: string;
  /** Single-string display: `"handle · N tasks"`. */
  label: string;
  taskCount: number;
  /** ISO-8601 last activity; used for ordering results, not displayed. */
  lastActivityAt: string;
}

/**
 * One task hit from the roster Find surface — matches name or branch across
 * the live fleet. Selecting calls `onSelectTask` (scene frame follows).
 */
export interface RosterTaskSearchHit {
  kind: "task";
  taskId: string;
  sessionId: string | null;
  name: string;
  /** Branch (or empty) for the secondary meta line. */
  branch: string | null;
}

/** Discriminated Find result: task hits list above session hits. */
export type RosterSearchHit = RosterTaskSearchHit | RosterSessionSearchHit;

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
  /** ISO-8601 last activity; displayed as the card's quiet relative age. */
  updatedAt: string | null;
  /** Orchestrator session this task belongs to, or null when unknown. */
  sessionId: string | null;
  /**
   * Human session handle for the card's session rope (first task name of the
   * session when projected from the full fleet). Null when unbound.
   */
  sessionHandle: string | null;
  /** 8-char short session ref for mono meta on the rope; null when unbound. */
  sessionShortRef: string | null;
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

/**
 * Discriminated log-tail status. Honesty over charm: never map a temporary
 * pause or a fetch failure to "ended" / "live". `paused-by-scroll` is
 * composed in {@link LogStream} (stick-to-bottom); the hook emits the rest.
 */
export type LogTailStatus =
  | "connecting"
  | "tailing"
  | "paused-by-setting"
  | "paused-by-scroll"
  | "ended"
  | "unreachable";

/** Status values the hook can produce (scroll pause is display-only). */
export type LogTailHookStatus = Exclude<LogTailStatus, "paused-by-scroll">;

/** The Logs tab's plain props (design-manifest §4.17 "Logs"). */
export interface LogsView {
  lines: LogLine[];
  /**
   * Truthful tail lifecycle from {@link useLogTail}. Scroll pause is folded
   * in at the LogStream display layer, not here.
   */
  status: LogTailHookStatus;
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

/**
 * One attempt in the fix chain as the inspector timeline renders it (#166).
 * Mirrors enriched `parley status` attempt lines: badges + score.
 */
export interface AttemptLineageItem {
  id: string;
  /** 1-based attempt number in the chain. */
  attempt: number;
  /** Wire task state string. */
  state: string;
  /** Caps display label from state meta (e.g. COMPLETED). */
  stateLabel: string;
  /** CSS colour token for the state badge. */
  stateColor: string;
  resumed: boolean;
  /**
   * Cache honesty badge: hit when cached tokens > 0, miss when 0,
   * null when the vendor did not report cached tokens.
   */
  cacheBadge: "cache" | "no-cache" | null;
  /** Pre-formatted score (`9/5`, `8 · legacy`, or null when unscored). */
  score: string | null;
  scoreValue: number | null;
  baselineValue: number | null;
  legacy: boolean;
  /** True when this entry is the currently selected task. */
  current: boolean;
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
  /**
   * While `queued` (#171): 1-based FIFO position, or null. Shown on the
   * state chip so the operator can see how deep the wait is.
   */
  queuePosition: number | null;
  /**
   * While `queued` (#171): blocking cap label (`vendor:X` / `profile:Y`),
   * or null.
   */
  blockingCap: string | null;
  /** Terminal failure cause from the task detail payload, or null when none. */
  error: string | null;
  /** Eval score out of 10, when the task has been eval'd (else null). */
  evalScore: number | null;
  evalFeedback: string | null;
  brief: BriefView;
  logs: LogsView;
  report: ReportView | null;
  qa: QaTurn[];
  /** Full attempt chain root → latest (#166); always at least the current task. */
  attempts: AttemptLineageItem[];
}

/**
 * One (node, iteration) row in the inspector's run view — same columns as
 * `parley run status <run>`, plus a state-carrying spine (#254 / ADR-0021).
 */
export interface InspectorRunNode {
  /** Stable key: `node\\0iteration`. */
  key: string;
  node: string;
  kind: "step" | "gate";
  iteration: number;
  /** Wire STATE (task projection for a step; actioned verb / waiting for a gate). */
  state: string;
  /** Rendered STATE cell label. */
  stateLabel: string;
  /** TASKS column (`1`, `12`, or `—` for gates with no tasks). */
  tasksLabel: string;
  /** Three-part gist from the query surface (already assembled). */
  gist: string;
  /** Compact duration (`18m`), or null when unknown. Field name kept for wire stability. */
  age: string | null;
  /** Fan-out width chip beside the node name; null when single-task. */
  fanoutWidth: number | null;
  /** Spine knot colour key (task StateKey or gate-mapped). */
  spineState: string;
  /** Highlight the live / held row. */
  live: boolean;
  /** Gate branch badge (`on_reject → funnel`); null on steps. */
  onReject: string | null;
}

/**
 * Wire deliverable kind. `purged` is a *state* (treatment), not a fourth kind
 * (#255 / ADR-0021).
 */
export type InspectorDeliverableKind = "inline" | "file" | "dir";

/**
 * One deliverable as the inspector renders it (#255). Discriminated by
 * `treatment` so inline JSON, reference-only paths, and decayed rows cannot
 * be confused — three kinds, three treatments; purged is a rendered state.
 */
export type InspectorDeliverable =
  | {
      treatment: "inline";
      id: string;
      /** Human address (`node.iteration[slot]/port`). */
      address: string;
      /** Port type label when known (`dict<string, source[]>`). */
      typeLabel: string | null;
      /** Pretty-printed JSON for the report-tinted well. */
      json: string;
    }
  | {
      treatment: "reference";
      id: string;
      address: string;
      kind: "file" | "dir";
      /** Stored path; empty string when the wire had none. */
      path: string;
      /** Pre-formatted size (`14 kB`, `1.2 MB`), or null when unknown / not useful. */
      sizeLabel: string | null;
      /**
       * Live stat from the daemon: `true` present, `false` worktree gone,
       * `null` when the wire did not report existence.
       */
      exists: boolean | null;
      /** Operator note for missing-path cases (never invent one). */
      note: string | null;
    }
  | {
      treatment: "purged";
      id: string;
      address: string;
      /** Kind survives purge — purged is a *state* of the kind, not a fourth kind. */
      kind: InspectorDeliverableKind;
      /**
       * Decay note when the wire provided one (date / run). Never an error
       * string — purged is expected retention, not a fetch failure.
       */
      note: string | null;
      /** ISO stamp from the wire; used when `note` is absent. */
      purgedAt: string | null;
    };

/**
 * Honest deliverable list status on a run view (#255).
 *
 * Four distinguishable things — never three readings of the same empty array:
 * - `not_fetched` — detail exists but deliverable rows were not loaded
 * - `none` — loaded; the run produced no deliverables
 * - `ready` — loaded; `items` may be all-purged and still render (addresses survive)
 * - `error` — one or more GET /deliverables/:id calls failed. `items` holds any
 *   that did load (partial success); never collapse a failure into `none`.
 */
export type InspectorDeliverables =
  | { status: "not_fetched" }
  | { status: "none" }
  | { status: "ready"; items: InspectorDeliverable[] }
  | {
      status: "error";
      /** Successfully loaded rows (empty when the whole batch failed). */
      items: InspectorDeliverable[];
      /** How many ids failed; non-zero by construction. */
      failedCount: number;
    };

/**
 * Run selected in the roster but detail not yet fetched. Suppresses the
 * resting digest without inventing counts, states, or an empty node table
 * that would read as "none entered" (#254 QC #6). Issues #253 / #255 build
 * on this discriminant — never put placeholder values on a ready payload.
 */
export interface InspectorRunPending {
  status: "pending";
  id: string;
}

/**
 * Full inspector payload when a run is selected (#254 / #255). Mirrors the CLI
 * node table; deliverables are a first-class, honest status (not an empty
 * array standing in for "not loaded"). `nodes: []` means the run has been
 * fetched and no nodes have been entered.
 */
export interface InspectorRunReady {
  status: "ready";
  id: string;
  workflow: string;
  workflowVersion: number;
  /** Wire run state. */
  runState: string;
  /** Header state label from state-meta (includes presented block reason when blocked). */
  stateLabel: string;
  branch: string | null;
  currentNode: string | null;
  iteration: number;
  /** Pre-formatted duration, or null. */
  duration: string | null;
  tasksTotal: number;
  nodes: InspectorRunNode[];
  /**
   * Deliverable projection (#255). Default from run detail alone is
   * `not_fetched` — node tables only carry deliverable *ids*, never values.
   */
  deliverables: InspectorDeliverables;
  /** Block detail when the run is blocked; null otherwise. */
  block: {
    reason: string;
    detail: string | null;
    node: string | null;
  } | null;
  /** True when blocked on a held gate (surfaces the helm note; no verbs). */
  heldGate: boolean;
}

/** Inspector run view model — pending (not fetched) or ready (from GET /runs/:ref). */
export type InspectorRun = InspectorRunPending | InspectorRunReady;

/**
 * One quiet row on the resting LOGBOOK fleet digest (no task selected).
 * Identity + pre-formatted age only — pure informational, no handlers.
 */
export interface LogbookDigestItem {
  id: string;
  name: string;
  coat: string;
  emblem: EmblemMark;
  /** Faction/vendor display name for the emblem's accessible label. */
  faction: string;
  /** Compact relative age (`12m`, `4h`), or null when no clock. */
  age: string | null;
}

/**
 * Resting LOGBOOK plate content when nothing is selected. Projected from the
 * already-grouped roster snapshot so the empty plate can show a quiet fleet
 * digest without a second data path. `hasFleet: false` keeps the hint-centric
 * empty state (no tasks at all).
 */
export interface LogbookDigest {
  /** True when the live fleet has at least one task. */
  hasFleet: boolean;
  /** Completed task count in the current roster projection. */
  completed: number;
  /** Failed task count. */
  failed: number;
  /** Running task count. */
  running: number;
  /** Most recent completions, newest first (capped). */
  recentCompletions: LogbookDigestItem[];
  /** Freshest failure if any; quiet coral accent, no navigation. */
  latestFailure: LogbookDigestItem | null;
}

/** The daemon health readout, fully projected to display values by the hooks layer. */
export interface HealthView {
  /** Probe lifecycle; connecting is reserved for the unresolved first probe. */
  status?: "connecting" | "online" | "offline";
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
 * Composable quality filters for Soundings (#165). Shared shape so #166
 * heatmap/timeline can subscribe without redefining fields. Empty strings
 * mean "no constraint"; toggles are explicit booleans.
 */
export interface SoundingsFiltersView {
  type: string;
  vendor: string;
  model: string;
  orch_harness: string;
  orch_model: string;
  eval_harness: string;
  eval_model: string;
  /** Rubric id or `id@version`. */
  rubric: string;
  firstAttemptOnly: boolean;
  belowBaselineOnly: boolean;
  /** True when any text filter or toggle is active. */
  active: boolean;
}

/** Centre-board sub-view inside Soundings (#165 / #166). */
export type SoundingsViewTab = "groups" | "distribution" | "comparison" | "heatmap";

/**
 * One group on the score-vs-baseline distribution (#165). Positions are 0–1
 * along a 0–10 score axis so the plate can draw without knowing the scale.
 */
export interface SoundingsDistributionRow {
  key: string | null;
  label: string;
  count: number;
  /** Pre-formatted avg score. */
  score: string;
  /** Pre-formatted avg baseline. */
  baseline: string;
  /** 0–1 position of avg score on a 0–10 axis; null when unscored. */
  scorePos: number | null;
  /** 0–1 position of avg baseline; null when no baseline. */
  baselinePos: number | null;
  /** Pre-formatted avg delta. */
  delta: string;
  /** Raw delta for tint (negative → below baseline). */
  deltaValue: number | null;
}

/**
 * One group on the comparison board (#165): avg delta, below-baseline rate,
 * and first-attempt vs fix recovery split.
 */
export interface SoundingsComparisonRow {
  key: string | null;
  label: string;
  count: number;
  avgDelta: string;
  avgDeltaValue: number | null;
  belowBaselineRate: string;
  belowBaselineRateValue: number | null;
  /** Pre-formatted first-attempt eval avg · n. */
  firstAttempt: string;
  firstAttemptCount: number;
  /** Pre-formatted fix-attempt eval avg · n. */
  fix: string;
  fixCount: number;
}

/**
 * One cell on the criterion-failure heatmap (#166): failure rate of one
 * rubric criterion inside one group (type / vendor / orchestrator).
 */
export interface SoundingsHeatmapCell {
  criterionId: string;
  groupKey: string | null;
  groupLabel: string;
  failures: number;
  count: number;
  /** failures / count; null when this group never answered the criterion. */
  rate: number | null;
  /** Pre-formatted rate (`33%`) or `—` when missing. */
  rateLabel: string;
  /**
   * 0–1 shading intensity (failure rate). Null when no sample for the cell
   * so the plate can render a deliberate empty (not zero) tile. Floor-biased
   * display keeps 1–2 data points legible.
   */
  intensity: number | null;
}

/** Projected heatmap matrix for the Soundings criterion-failure view (#166). */
export interface SoundingsHeatmapView {
  /** Sorted criterion ids (row axis). */
  criteria: string[];
  /** Group columns for the active dimension. */
  groups: { key: string | null; label: string }[];
  /**
   * Row-major cells: `cells[criterionIndex][groupIndex]`.
   * Empty when no criterion answers exist under current filters.
   */
  cells: SoundingsHeatmapCell[][];
  /** Sum of rubric-eval counts across groups (sparse messaging). */
  sampleEvals: number;
}

/**
 * Plain Soundings dashboard props (#119 / #165 / #166). Status is fully
 * projected so the plate never interprets wire shapes or loading policy.
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
  /** Score-vs-baseline rows (same group order as {@link groups}). */
  distribution: SoundingsDistributionRow[];
  /** Comparison rows (same group order as {@link groups}). */
  comparison: SoundingsComparisonRow[];
  /** Criterion-failure heatmap matrix (#166). */
  heatmap: SoundingsHeatmapView;
  /** Active group-by dimension string. */
  groupBy: string;
  /** Session scope label (`All hands` or short session id). */
  sessionLabel: string;
  /** ISO timestamp from the response, or null before first success. */
  generatedAt: string | null;
  /** Active quality filters (shared heatmap / distribution / comparison). */
  filters: SoundingsFiltersView;
  /** Which Soundings sub-view is showing. */
  viewTab: SoundingsViewTab;
  /**
   * Rubric-eval presence for quality-view empty states:
   * `loading` | `ready` (has evals) | `off` (groups but no rubric scores —
   * eval disabled or not yet run) | `empty` (no groups).
   */
  evalPresence: "loading" | "ready" | "off" | "empty";
}
