/**
 * Wire types for the run query surface (ADR-0021 / #241).
 *
 * CLI + daemon HTTP only — never the child MCP/HTTP channel. No storage
 * shapes: decoded values only, no `row` field.
 */

/** Why a run is blocked — drives verb set and list STATE parentheses. */
export type RunBlockReason =
  | "gate"
  | "loop_exhausted"
  | "success_policy"
  | "spawn_error"
  | "unfilled_inputs"
  | "unknown";

/** Orchestrator verbs offered for a block (ADR-0017). */
export type RunBlockVerb = "approve" | "reject" | "redirect" | "finish";

/**
 * Block detail on a run envelope / detail response.
 * Null on the envelope when `state !== "blocked"`.
 */
export interface RunBlock {
  reason: RunBlockReason;
  node: string | null;
  iteration: number | null;
  /** Author-declared loop.max when reason is loop_exhausted. */
  max?: number | null;
  detail: string | null;
  verbs: RunBlockVerb[];
}

/** Aggregated token usage on a run or node projection. */
export interface RunUsage {
  input_tokens: number;
  output_tokens: number;
}

/**
 * One run on the list and as the header of a detail view (ADR-0021).
 * Mirrors TaskEnvelope discipline: decoded values, no storage shapes.
 */
export interface RunSummary {
  run_id: string;
  workflow: string;
  workflow_version: number;
  orchestrator_session_id: string | null;
  /**
   * Run lifecycle state, or `purged` when retention has decayed the run
   * (`purged_at` set) — a first-class decayed render state (ADR-0021).
   */
  state: string;
  /** Non-null only when the underlying run is `blocked`. */
  block: RunBlock | null;
  current_node: string | null;
  iteration: number;
  parent_run_id: string | null;
  attempt: number;
  tasks_settled: number;
  tasks_total: number;
  usage: RunUsage;
  duration_ms: number | null;
  branch: string | null;
  worktree: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  /** When retention purged scaffolding; null while live. */
  purged_at: string | null;
  /** Global transition seq snapshot at query time (list only). */
  seq?: number;
  /** Workspace mode from the run row. */
  workspace: string;
  type: string;
  repo: string | null;
  error: string | null;
}

/** Fan-out description on a node projection (null when single-task). */
export interface NodeFanout {
  kind: "data" | "slots";
  /** Upstream port for data fan-out; null for authored slots. */
  over: string | null;
  width: number;
  failed: string[];
  /** Policy summary when available (e.g. `min 1 — MET, 2 of 3`). */
  success?: string | null;
}

/** Gate `shows` entry — id + address, never the value. */
export interface GateShowRef {
  name: string;
  from: string;
  deliverable_id: string | null;
  kind: "inline" | "file" | "dir" | null;
  type: string | null;
  /** Size string or enum value (gates print enum values in place of sizes). */
  size: string | null;
}

/**
 * One (node, iteration) row — the unit of the summary table.
 * Computed per request from tasks + deliverables; never stored.
 */
export interface NodeProjection {
  node: string;
  kind: "step" | "gate";
  iteration: number;
  /**
   * Polymorphic STATE: task projection for a step; for a gate one of:
   * - real verb when known: `approved` | `rejected` | `redirected` | `finished`
   * - `waiting` while held
   * - `skipped` (fork re-entry past the gate)
   * - `actioned` when left but the verb is unknown (no decision log yet)
   * - step fork marker: `inherited`
   */
  state: string;
  tasks_settled: number;
  tasks_total: number;
  usage: RunUsage | null;
  duration_ms: number | null;
  fanout: NodeFanout | null;
  /** Top-level enum out-ports tallied: port → value → count. */
  tallies: Record<string, Record<string, number>>;
  /** Plural out-ports counted: port → element count. */
  counts: Record<string, number>;
  /** Child summary only when the node has exactly one task. */
  summary: string | null;
  /** Deliverable ids only — never values. */
  deliverables: string[];
  /** Assembled GIST line (deterministic; same rules as CLI). */
  gist: string;
  // Gate-only fields (null/absent on steps)
  question?: string | null;
  on_reject?: string | null;
  answer?: string | null;
  note?: string | null;
  shows?: GateShowRef[];
}

/** Deliverable listing without a value (node detail tables). */
export interface DeliverableRef {
  deliverable_id: string;
  run_id: string;
  node: string;
  port: string;
  iteration: number;
  slot: string | null;
  /**
   * Producing task id, or null after retention deleted the task while the
   * address row survived (#244).
   */
  task_id: string | null;
  kind: "inline" | "file" | "dir";
  type: string | null;
  size: DeliverableSize | null;
  created_at: string;
  purged_at: string | null;
}

/** Size of a deliverable value for display. */
export interface DeliverableSize {
  bytes?: number;
  elements?: number;
  keys?: number;
}

/**
 * Full deliverable fetch (ADR-0021). Inline values under `value`; path
 * references under `path` / `absolute_path` with live `exists`.
 */
export interface DeliverableValue extends DeliverableRef {
  /** Inline JSON value; null when purged or path-kind. */
  value: unknown;
  /** Relative or stored path for file/dir kinds. */
  path: string | null;
  absolute_path: string | null;
  /** Stat'd at read time for file/dir; null for inline. */
  exists: boolean | null;
  /** Operator note for decayed / missing path cases. */
  note: string | null;
  /**
   * True when this response is a *collected* fan-out (dict/array over
   * siblings) with no single deliverable row of its own.
   */
  collected?: boolean;
}

/** One sibling row in node-detail zoom. */
export interface NodeTaskRow {
  slot: string | null;
  task_id: string;
  state: string;
  usage: RunUsage | null;
  duration_ms: number | null;
  /** Child summary verbatim (one task per row at this resolution). */
  summary: string | null;
  gist: string;
}

/** `GET /runs` body. */
export interface RunsResponse {
  runs: RunSummary[];
  seq: number;
}

/** `GET /runs/:ref` body. */
export interface RunDetailResponse {
  run: RunSummary;
  nodes: NodeProjection[];
  block: RunBlock | null;
}

/** `GET /runs/:ref/nodes/:node` body. */
export interface NodeDetailResponse {
  run_id: string;
  node: NodeProjection;
  tasks: NodeTaskRow[];
  deliverables: DeliverableRef[];
}
