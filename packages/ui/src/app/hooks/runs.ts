/**
 * Layer 4 (hooks) — run roster + inspector projection (#254 / #255 / ADR-0021).
 *
 * Pure helpers over the query-surface shapes (`RunSummary`, `RunDetailResponse`,
 * `NodeProjection`, `DeliverableValue`) already served by #241. No parallel
 * fetch shape: the wire is `GET /runs` + `GET /runs/:ref` (+ deliverable gets
 * for the value/path fields the node table does not carry).
 */
import type {
  DeliverableSize,
  DeliverableValue,
  NodeProjection,
  RunBlock,
  RunDetailResponse,
  RunSummary,
} from "@useparley/core";
import { formatStepAddress } from "@useparley/core";
import type {
  InspectorDeliverable,
  InspectorDeliverables,
  InspectorRun,
  InspectorRunNode,
  RosterPip,
  RosterPipKind,
  RosterRun,
} from "../../hud/types.js";
import { stateMetaFor } from "../../tokens/state-meta.js";
import { formatDurationMs, formatTokenCount } from "./format.js";
import { shortId } from "./roster.js";

/**
 * Map a wire run lifecycle state onto the roster's attention vocabulary.
 * `blocked` (gate or otherwise) sits with the awaiting tier per #254 —
 * the brief is the contract even though the inbox folds blocked with stalled.
 *
 * Unknown wire states pass through so `stateMetaFor` can give them the
 * neutral/unknown treatment rather than silently painting them as running
 * (#261).
 */
export function runAttentionState(runState: string): string {
  switch (runState) {
    case "blocked":
      return "awaiting_answer";
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
    case "purged":
      return "cancelled";
    default:
      return runState;
  }
}

/** True when the run is blocked on a held gate (reason === gate). */
export function isHeldGate(block: RunBlock | null | undefined): boolean {
  return block != null && block.reason === "gate";
}

/**
 * Run chip text for a run-owned task: `7f3a · review.2.tests`.
 * Returns null when the task is not run-owned or the address is incomplete.
 */
export function formatRunChip(opts: {
  runId: string | null | undefined;
  node: string | null | undefined;
  iteration: number | null | undefined;
  slot?: string | null;
}): string | null {
  const runId = opts.runId;
  if (runId == null || runId === "") return null;
  if (opts.node == null || opts.node === "") return null;
  if (opts.iteration == null || !Number.isFinite(opts.iteration)) return null;
  try {
    const address = formatStepAddress({
      node: opts.node,
      iteration: opts.iteration,
      slot: opts.slot ?? null,
    });
    return `${shortId(runId)} · ${address}`;
  } catch {
    return `${shortId(runId)} · ${opts.node}`;
  }
}

/** Map a node projection STATE onto a pip kind. */
export function pipKindForNode(node: NodeProjection): RosterPipKind {
  if (node.kind === "gate") {
    if (node.state === "waiting") return "gate";
    if (node.state === "skipped") return "done";
    return "done";
  }
  if (node.state === "failed") return "fail";
  if (node.state === "completed" || node.state === "inherited" || node.state === "purged") {
    return "done";
  }
  if (
    node.state === "running" ||
    node.state === "awaiting_answer" ||
    node.state === "stalled" ||
    node.state === "queued" ||
    node.state === "pending"
  ) {
    return "live";
  }
  // Partial step progress: "5 of 6" style settles to live when not fully done.
  if (node.tasks_total > 0 && node.tasks_settled < node.tasks_total) return "live";
  if (node.tasks_total > 0 && node.tasks_settled >= node.tasks_total) return "done";
  return "empty";
}

/**
 * Build a static-length pip track. Length is `track_bound` (nodes × loop.max)
 * when known; otherwise the entered node count. Never grows with fan-out width.
 */
export function buildPipTrack(
  nodes: readonly NodeProjection[],
  trackBound: number | null | undefined,
): RosterPip[] {
  const bound =
    typeof trackBound === "number" && Number.isFinite(trackBound) && trackBound > 0
      ? Math.floor(trackBound)
      : Math.max(nodes.length, 1);
  const pips: RosterPip[] = [];
  for (let i = 0; i < bound; i++) {
    const node = nodes[i];
    pips.push({ kind: node ? pipKindForNode(node) : "empty" });
  }
  return pips;
}

/** Fallback track when only the list envelope is known (no node table yet). */
export function buildListPipTrack(summary: RunSummary): RosterPip[] {
  const bound =
    typeof summary.track_bound === "number" &&
    Number.isFinite(summary.track_bound) &&
    summary.track_bound > 0
      ? Math.floor(summary.track_bound)
      : 1;
  const pips: RosterPip[] = Array.from({ length: bound }, () => ({
    kind: "empty" as const,
  }));
  if (pips.length === 0) return [{ kind: "empty" }];
  // Rough progress marker so a list-only row is not a blank track.
  if (summary.state === "completed" || summary.state === "purged") {
    return pips.map(() => ({ kind: "done" as const }));
  }
  if (summary.state === "failed" || summary.state === "cancelled") {
    // Fail/cancel mark sits at min(len-1, tasks_settled). Paint *prior* slots
    // done — never the mark index itself. When tasks_settled >= pips.length
    // (fan-out wider than the track bound) the old `i < tasks_settled` loop
    // overwrote the fail pip and the track read as complete.
    const markIdx = Math.min(pips.length - 1, Math.max(0, summary.tasks_settled));
    for (let i = 0; i < markIdx; i++) {
      pips[i] = { kind: "done" };
    }
    pips[markIdx] = {
      kind: summary.state === "failed" ? "fail" : "done",
    };
    return pips;
  }
  if (summary.state === "blocked" && isHeldGate(summary.block)) {
    // Paint prior slots done; current is the gate.
    const idx = Math.min(pips.length - 1, Math.max(0, summary.iteration - 1));
    for (let i = 0; i < idx; i++) pips[i] = { kind: "done" };
    pips[idx] = { kind: "gate" };
    return pips;
  }
  if (summary.state === "blocked") {
    const idx = Math.min(pips.length - 1, Math.max(0, summary.iteration - 1));
    for (let i = 0; i < idx; i++) pips[i] = { kind: "done" };
    pips[idx] = { kind: "live" };
    return pips;
  }
  // running
  const idx = Math.min(pips.length - 1, Math.max(0, summary.iteration - 1));
  for (let i = 0; i < idx; i++) pips[i] = { kind: "done" };
  pips[idx] = { kind: "live" };
  return pips;
}

function runSubtitle(summary: RunSummary): string {
  if (summary.state === "blocked" && summary.block) {
    if (summary.block.reason === "gate" && summary.block.node) {
      return `${summary.block.node} — held`;
    }
    if (summary.block.detail) return summary.block.detail;
    if (summary.current_node) return summary.current_node;
    return "blocked";
  }
  if (summary.current_node) {
    const fan =
      summary.tasks_total > 1
        ? ` — ${summary.tasks_settled} of ${summary.tasks_total}`
        : "";
    return `${summary.current_node}${fan}`;
  }
  return summary.workflow;
}

function runMetaLine(summary: RunSummary): string {
  const parts: string[] = [];
  if (summary.iteration > 0) {
    const max =
      summary.block?.reason === "loop_exhausted" && summary.block.max
        ? summary.block.max
        : null;
    parts.push(max != null ? `pass ${summary.iteration} of ${max}` : `pass ${summary.iteration}`);
  }
  if (summary.tasks_total > 0) {
    parts.push(
      summary.tasks_total === 1 ? "1 task" : `${summary.tasks_total} tasks`,
    );
  }
  const dur = formatDurationMs(summary.duration_ms);
  if (dur !== "—") parts.push(dur);
  return parts.join(" · ");
}

/**
 * Project a list envelope (+ optional detail nodes) into a roster run row.
 * `pips` come from the detail node table when present so length stays fan-out free.
 */
export function projectRosterRun(
  summary: RunSummary,
  detailNodes?: readonly NodeProjection[] | null,
): RosterRun {
  const heldGate = summary.state === "blocked" && isHeldGate(summary.block);
  const pips =
    detailNodes != null
      ? buildPipTrack(detailNodes, summary.track_bound)
      : buildListPipTrack(summary);
  return {
    id: summary.run_id,
    name: summary.workflow,
    attentionState: runAttentionState(summary.state),
    runState: summary.state,
    subtitle: runSubtitle(summary),
    meta: runMetaLine(summary),
    heldGate,
    pips,
    updatedAt: summary.updated_at,
    orchestratorSession: summary.orchestrator_session_id,
  };
}

/** Map a node STATE onto a spine / STATE-column colour key. */
export function spineStateForNode(node: NodeProjection): string {
  if (node.kind === "gate") {
    if (node.state === "waiting") return "awaiting_answer";
    if (node.state === "skipped") return "cancelled";
    return "completed";
  }
  if (node.state === "inherited") return "cancelled";
  if (node.state === "purged") return "cancelled";
  // Partial fan-out: still running when not fully settled.
  if (
    node.tasks_total > 1 &&
    node.tasks_settled < node.tasks_total &&
    node.state !== "failed" &&
    node.state !== "completed"
  ) {
    return "running";
  }
  return node.state;
}

/**
 * STATE column label — polymorphic: task projection vs gate verb.
 * Known task states use the same `stateMetaFor` labels as the roster (#261)
 * so `awaiting_answer` reads AWAITING in both places, never AWAITING_ANSWER.
 */
export function formatNodeStateLabel(node: NodeProjection): string {
  if (node.kind === "gate") {
    if (node.state === "waiting") return "gate · held";
    return stateMetaFor(node.state).label;
  }
  // Partial fan-out progress is a quantity, not a lifecycle word.
  if (
    node.tasks_total > 1 &&
    node.tasks_settled < node.tasks_total &&
    node.state === "completed"
  ) {
    return `${node.tasks_settled} of ${node.tasks_total}`;
  }
  return stateMetaFor(node.state).label;
}

/**
 * Header state label for a run. Wire enums never reach the surface raw —
 * both the lifecycle word and a blocked reason go through `stateMetaFor`
 * (#261), matching how the rest of the cockpit names states.
 */
export function formatRunStateLabel(
  runState: string,
  block: RunBlock | null | undefined,
): string {
  if (runState === "blocked" && block) {
    return `${stateMetaFor("blocked").label} · ${stateMetaFor(block.reason).label}`;
  }
  return stateMetaFor(runState).label;
}

/**
 * Compact duration for the node table's Duration column (`18m`, `<1m`).
 * Duration only — no elapsed-since branch, so the header always names the
 * quantity under it (#261). Null when the wire has no duration_ms.
 */
export function formatNodeDuration(durationMs: number | null): string | null {
  if (durationMs != null && Number.isFinite(durationMs)) {
    const mins = Math.max(0, Math.floor(durationMs / 60_000));
    if (mins < 1) return "<1m";
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 48) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
  }
  return null;
}

function projectInspectorNode(
  node: NodeProjection,
  opts: { live: boolean },
): InspectorRunNode {
  const tasksLabel =
    node.kind === "gate" && node.tasks_total === 0
      ? "—"
      : String(node.tasks_total);
  return {
    key: `${node.node}\0${node.iteration}`,
    node: node.node,
    kind: node.kind,
    iteration: node.iteration,
    state: node.state,
    stateLabel: formatNodeStateLabel(node),
    tasksLabel,
    gist: node.gist || "—",
    age: formatNodeDuration(node.duration_ms),
    fanoutWidth: node.fanout && node.fanout.width > 1 ? node.fanout.width : null,
    spineState: spineStateForNode(node),
    live: opts.live,
    onReject: node.kind === "gate" && node.on_reject ? node.on_reject : null,
  };
}

/**
 * Human deliverable address matching the daemon/CLI form:
 * `node.iteration[slot]/port`.
 */
export function formatDeliverableAddress(d: {
  node: string;
  port: string;
  iteration: number;
  slot: string | null;
}): string {
  const slot = d.slot ? `[${d.slot}]` : "";
  return `${d.node}.${d.iteration}${slot}/${d.port}`;
}

/**
 * Compact size for the reference treatment (`14 kB`, `1.2 MB`, `6 keys`).
 * Directory inode bytes are not a useful size — omit unless `elements`/`keys`
 * is set on the wire (the daemon overrides file/dir size with `{bytes}`).
 */
export function formatDeliverableSize(
  size: DeliverableSize | null | undefined,
  kind?: "inline" | "file" | "dir",
): string | null {
  if (size == null) return null;
  if (size.elements !== undefined) {
    return size.elements === 1 ? "1 item" : `${size.elements} items`;
  }
  if (size.keys !== undefined) {
    return size.keys === 1 ? "1 key" : `${size.keys} keys`;
  }
  // Dir inode size is not meaningful to an operator (#255 QC).
  if (kind === "dir") return null;
  if (size.bytes !== undefined && Number.isFinite(size.bytes)) {
    const b = size.bytes;
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) {
      const kb = b / 1024;
      return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} kB`;
    }
    const mb = b / (1024 * 1024);
    return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  }
  return null;
}

/**
 * Project one wire deliverable value into a kind-aware treatment (#255).
 * Purged is gated on `purged_at` (or a non-null decay `note` from the daemon
 * value-missing path) — never on bare `value === null`, which is legitimate
 * JSON null on an optional port (#255 F2).
 */
export function projectDeliverable(v: DeliverableValue): InspectorDeliverable {
  const address = formatDeliverableAddress(v);

  // Decay: stamp wins. Daemon value-missing path sets note without a stamp.
  // JSON `null` on a live port has purged_at=null and note=null — that is data.
  const isPurged =
    v.purged_at != null ||
    (v.kind === "inline" &&
      v.value === null &&
      !v.collected &&
      v.note != null &&
      v.note !== "");

  if (isPurged) {
    return {
      treatment: "purged",
      id: v.deliverable_id,
      address,
      kind: v.kind,
      note: v.note,
      purgedAt: v.purged_at,
    };
  }

  if (v.kind === "file" || v.kind === "dir") {
    return {
      treatment: "reference",
      id: v.deliverable_id,
      address,
      kind: v.kind,
      path: v.path ?? v.absolute_path ?? "",
      sizeLabel: formatDeliverableSize(v.size, v.kind),
      exists: v.exists,
      note: v.note,
    };
  }

  // inline / collected — browsable JSON in the report well (including `null`).
  let json: string;
  try {
    json = JSON.stringify(v.value, null, 2) ?? "null";
  } catch {
    json = String(v.value);
  }
  return {
    treatment: "inline",
    id: v.deliverable_id,
    address,
    typeLabel: v.type,
    json,
  };
}

/**
 * Project a list of wire deliverables into the honest list status.
 * - `undefined` → not fetched (caller has not loaded deliverable rows)
 * - empty array, no failures → none (loaded; run produced no deliverables)
 * - non-empty, no failures → ready (including all-purged lists)
 * - any failures → error (with partial `items` when some ids succeeded)
 */
export function projectDeliverables(
  values: readonly DeliverableValue[] | undefined,
  failedCount: number = 0,
): InspectorDeliverables {
  if (values === undefined) return { status: "not_fetched" };
  if (failedCount > 0) {
    return {
      status: "error",
      items: values.map(projectDeliverable),
      failedCount,
    };
  }
  if (values.length === 0) return { status: "none" };
  return { status: "ready", items: values.map(projectDeliverable) };
}

/**
 * Project `GET /runs/:ref` into the inspector run view. One row per
 * (node, iteration); STATE polymorphic; gist from the wire.
 *
 * Deliverable values are optional: the run detail envelope only carries
 * deliverable *ids* on each node. Pass the resolved `DeliverableValue[]`
 * from `GET /deliverables/:id` (or leave undefined for `not_fetched`).
 * Pass `failedCount` when any id in the batch failed so a blip cannot
 * read as genuine absence.
 */
export function projectInspectorRun(
  detail: RunDetailResponse,
  _nowMs: number = Date.now(),
  deliverableValues?: readonly DeliverableValue[],
  failedCount: number = 0,
): InspectorRun {
  const { run, nodes, block } = detail;
  const heldGate = run.state === "blocked" && isHeldGate(block);
  const stateLabel = formatRunStateLabel(run.state, block);

  const projected = nodes.map((node) => {
    const live =
      (run.state === "blocked" &&
        block?.node === node.node &&
        block.iteration === node.iteration) ||
      (run.state === "running" &&
        run.current_node === node.node &&
        run.iteration === node.iteration) ||
      node.state === "waiting" ||
      node.state === "running" ||
      node.state === "awaiting_answer";
    return projectInspectorNode(node, { live });
  });

  return {
    status: "ready",
    id: run.run_id,
    workflow: run.workflow,
    workflowVersion: run.workflow_version,
    runState: run.state,
    stateLabel,
    branch: run.branch,
    currentNode: run.current_node,
    iteration: run.iteration,
    duration: formatDurationMs(run.duration_ms) === "—"
      ? null
      : formatDurationMs(run.duration_ms),
    tasksTotal: run.tasks_total,
    nodes: projected,
    deliverables: projectDeliverables(deliverableValues, failedCount),
    block: block
      ? {
          reason: block.reason,
          detail: block.detail,
          node: block.node,
        }
      : null,
    heldGate,
  };
}

/** Header usage chip for a run (`1.2k ▸ 340`), matching task brief style. */
export function formatRunUsage(summary: RunSummary): string | null {
  const { input_tokens, output_tokens } = summary.usage;
  if (!input_tokens && !output_tokens) return null;
  return `${formatTokenCount(input_tokens)} ▸ ${formatTokenCount(output_tokens)}`;
}
