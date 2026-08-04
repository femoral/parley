/**
 * Layer 4 (hooks) — pure roster projection (#66). Groups a plain task list by
 * state in attention order and derives the distinct orchestrator sessions,
 * without touching React or the wire types directly: `useSnapshot` adapts the
 * SDK's envelopes/rows into {@link RosterTaskInput} and calls this. Kept pure
 * and side-effect free so it is unit-testable with hand-written fixtures
 * (component-system spec contract 6 — attention ordering comes from core
 * constants; this is the one place that reads them for the roster).
 *
 * Failed-state freshness is a *display-layer* concern layered on top of core's
 * `attentionRank`: a fresh wreck arrives loud (undimmed, coral beacon, sorted
 * just under stalled) and decays to the archive treatment once selected or
 * after {@link FAILED_FRESHNESS_MS}. The kit band's legend stays pinned to
 * core's `ATTENTION_ORDER` — only the live roster list uses this window.
 */
import { attentionRank, isTerminalState } from "@useparley/core";
import type {
  RosterGroup,
  RosterRun,
  RosterSessionOption,
  RosterTask,
} from "../../hud/types.js";
import { toDisplayTask } from "./displayTask.js";
import { formatExecutorLabel } from "./executors.js";
import { formatRunChip } from "./runs.js";

/**
 * How many most-recently-active session chips the roster shows before the
 * search affordance covers the rest (#88). Named so the cap is one place.
 */
export const RECENT_SESSION_CHIP_CAP = 5;

/**
 * How long a failure stays "fresh" (loud) before decaying to the quiet archive
 * treatment, unless the operator acknowledges it sooner by selecting the task
 * (demotion applies on deselection — see {@link isFreshFailure}).
 * Five minutes — long enough to notice on an ambient second monitor, short
 * enough that yesterday's wrecks don't keep shouting.
 */
export const FAILED_FRESHNESS_MS = 5 * 60 * 1000;

/** The plain per-task slice {@link projectRoster} groups and sorts. */
export interface RosterTaskInput {
  id: string;
  name: string;
  vendor: string | null;
  /** Concrete model id; supplies the model-maker emblem. */
  model?: string | null;
  /** Adapter running the orchestrator model; supplies task identity colour. */
  orchHarness?: string | null;
  state: string;
  branch: string | null;
  /** The orchestrator session this task belongs to (spec's "big ship"), or
   * null when unbound. Carried on the wire envelope (#208). */
  orchestratorSession: string | null;
  /** The outstanding question text while `awaiting_answer` (else null) — the
   * `useSnapshot`-maintained map this feeds both the roster and inbox
   * projections (#67), so it lives on the shared input shape. */
  question: string | null;
  /**
   * ISO-8601 last-activity timestamp from the envelope's `updated_at` (#208).
   * Used to order session chips by recency (#88); absent values sort last.
   * Also seeds failed-freshness on first observation when `completedAt` is
   * missing (terminal transition time fallback).
   */
  updatedAt?: string | null;
  /**
   * ISO-8601 when the task reached a terminal state (`completed_at` on the
   * wire). Seeds the failed-observation stamp on cold load so archive wrecks
   * do not re-flare as "fresh" after a hard reload.
   */
  completedAt?: string | null;
  /**
   * Owning run id when this task is run-owned (#254 / ADR-0019). Null for
   * plain tasks — drives the roster run chip.
   */
  runId?: string | null;
  /** Run address node id. */
  node?: string | null;
  /** Run address iteration. */
  iteration?: number | null;
  /** Run address slot. */
  slot?: string | null;
  /**
   * Remote runner affinity / claim name from wire `runner` (#324).
   * Null/absent = daemon-local execution.
   */
  runner?: string | null;
}

/**
 * Display-layer inputs for the failed-state freshness window. Tracked in the
 * roster/selection hook layer (`useCockpit`) — not wall-clock inside render
 * components. Absent / undefined = every failure is treated as archive (the
 * quiet terminal treatment), matching callers that only need core order.
 */
export interface FailedFreshness {
  /**
   * Epoch ms when each currently-failed task first entered `failed` for this
   * spell (cleared when the task leaves failed so a re-failure is loud again).
   */
  observedAt: ReadonlyMap<string, number>;
  /**
   * Task ids the operator has selected at least once while failed. Demotion
   * still waits until the task is no longer selected (see
   * {@link selectedTaskId}) so a click does not reshuffle the list under the
   * pointer / keyboard focus.
   */
  acknowledged: ReadonlySet<string>;
  /**
   * Currently selected task id. An acknowledged failure keeps its elevated
   * rank and loud treatment while it remains selected; demotion applies on
   * deselection (Esc/clear or selecting another task).
   */
  selectedTaskId?: string | null;
  /** Clock used for timeout decay (cockpit one-second tick). */
  now: number;
}

/** The full roster projection a `RosterPanel` renders. */
export interface RosterProjection {
  groups: RosterGroup[];
  sessions: RosterSessionOption[];
  totalTasks: number;
  activeTasks: number;
  /** Distinct orchestrator sessions with at least one non-terminal task. */
  durableSessions: number;
}

/** Truncate a task id to its short display form (`branch · id` rows, session
 * chips). Exported so `inbox.ts`'s projection uses the same truncation rather
 * than re-declaring it. */
export function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

/** Count with unit for session chips / search hits ("7 tasks", never bare "7"). */
export function formatTaskCount(count: number): string {
  return count === 1 ? "1 task" : `${count} tasks`;
}

/**
 * Human session identity derived from already-projected fleet data. Lead with
 * the first task's name (stable id order); keep the 8-hex short ref as the mono
 * secondary; compose a single-string `label` for tight surfaces.
 */
export interface SessionIdentity {
  handle: string;
  shortRef: string;
  count: number;
  /** `"handle · N tasks"` — Soundings scope, edge chips, scene banners. */
  label: string;
}

/**
 * Derive a humane session label from tasks already known for that session.
 * No invented ship-name table: first task name by stable id order, else shortRef.
 *
 * Pure per call — does not consult the sticky handle cache. Prefer
 * {@link collectSessionIdentities} for live fleet projections so handles stay
 * stable for the page lifetime when the deriving task is cleaned.
 */
export function deriveSessionIdentity(
  sessionId: string,
  tasks: readonly { id: string; name: string }[],
): SessionIdentity {
  const shortRef = shortId(sessionId);
  const count = tasks.length;
  const sorted = [...tasks].sort((a, b) => a.id.localeCompare(b.id));
  const handle = sorted[0]?.name?.trim() || shortRef;
  return {
    handle,
    shortRef,
    count,
    label: `${handle} · ${formatTaskCount(count)}`,
  };
}

/**
 * Client-side sticky handles: once a session id receives a handle, keep it for
 * the lifetime of the page even if the lexically-first task that produced it is
 * cleaned or removed. Module-scoped so every `collectSessionIdentities` caller
 * (roster, scene, inbox, search) stays consistent.
 */
const stickySessionHandles = new Map<string, string>();

/** Test-only: clear sticky handles between cases so page-lifetime cache does not leak. */
export function resetStickySessionHandles(): void {
  stickySessionHandles.clear();
}

/**
 * Build session identities for every orchestrator session present in the fleet.
 * Used by roster chips, scene regions, inbox ropes, and search enrichment so
 * every surface shares one handle.
 *
 * Handles are sticky for the page lifetime: the first derived handle for a
 * session id is retained even when the deriving task disappears mid-watch.
 */
export function collectSessionIdentities(
  tasks: Iterable<RosterTaskInput>,
): Map<string, SessionIdentity> {
  const bySession = new Map<string, { id: string; name: string }[]>();
  for (const task of tasks) {
    const sid = task.orchestratorSession;
    if (!sid) continue;
    let list = bySession.get(sid);
    if (!list) {
      list = [];
      bySession.set(sid, list);
    }
    list.push({ id: task.id, name: task.name });
  }
  const out = new Map<string, SessionIdentity>();
  for (const [sid, members] of bySession) {
    const derived = deriveSessionIdentity(sid, members);
    const sticky = stickySessionHandles.get(sid);
    if (sticky === undefined) {
      stickySessionHandles.set(sid, derived.handle);
      out.set(sid, derived);
    } else {
      out.set(sid, {
        ...derived,
        handle: sticky,
        label: `${sticky} · ${formatTaskCount(derived.count)}`,
      });
    }
  }
  return out;
}

/**
 * Epoch ms of the task's terminal transition from wire fields, or `undefined`
 * when neither timestamp is parseable. Prefers `completed_at` (true terminal
 * time) and falls back to `updated_at`.
 */
export function terminalTransitionMs(task: RosterTaskInput): number | undefined {
  const raw = task.completedAt ?? task.updatedAt;
  if (!raw) return undefined;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * True when a failed task is still inside its freshness window: observed less
 * than {@link FAILED_FRESHNESS_MS} ago, and either not yet acknowledged or
 * still selected (so acknowledging on click does not demote the FAILED group
 * under the user's pointer / keyboard spatial model). Non-failed states are
 * never fresh. The 5-minute timeout always wins, even while selected.
 *
 * Observation stamps come from {@link advanceFailedObservations}: wire
 * terminal time on first sight of an already-failed task (cold load / reload),
 * or `now` when a live non-failed→failed transition is observed.
 */
export function isFreshFailure(
  taskId: string,
  state: string,
  freshness: FailedFreshness | null | undefined,
): boolean {
  if (state !== "failed" || !freshness) return false;
  const observedAt = freshness.observedAt.get(taskId);
  // No stamp yet: not loud. Callers seed via advanceFailedObservations before
  // projecting; treating missing as fresh would re-flare archive wrecks.
  if (observedAt === undefined) return false;
  if (freshness.now - observedAt >= FAILED_FRESHNESS_MS) {
    return false;
  }
  // Keep elevated rank while the operator still has this wreck selected, even
  // after selection has marked it acknowledged. Demotion lands on deselection.
  if (freshness.selectedTaskId === taskId) return true;
  if (freshness.acknowledged.has(taskId)) return false;
  return true;
}

/**
 * Display attention rank for grouping/sorting. Mirrors core's
 * {@link attentionRank} except that a *fresh* failure slots just under
 * `stalled` (and above `running`) so a new wreck outranks calm work. Archive
 * failures keep core's quiet rank. The kit legend does not use this.
 */
export function displayAttentionRank(
  state: string,
  freshFailure: boolean,
): number {
  if (state === "failed" && freshFailure) {
    // stalled is 1, running is 2 — insert between them.
    return attentionRank("stalled") + 0.5;
  }
  return attentionRank(state);
}

/**
 * Advance the failed-observation map for the current task list. Pure: callers
 * (useCockpit) keep the previous map across renders so a failure's clock starts
 * once per spell, not on every re-project. Tasks that leave `failed` drop out;
 * re-entry gets a new stamp.
 *
 * **Seeding rule** (first observation of a failed spell, no prior stamp):
 * 1. Live transition — task was previously known in a non-failed state
 *    (`prevKnownStates` has a non-`failed` entry) → stamp `now` so the beacon
 *    flares from the moment the operator saw it fail over SSE.
 * 2. Otherwise (cold load / hard reload / first paint of an already-failed
 *    task) → seed from the wire terminal time (`completed_at`, falling back
 *    to `updated_at`). A wreck is loud only when that time is still within
 *    {@link FAILED_FRESHNESS_MS} of `now`. Missing/unparseable wire time
 *    falls back to `now` (same as a just-failed spell with no clock).
 *
 * Returns `prev` itself when nothing changed, so downstream memos (the roster
 * projection) keep their identity across the cockpit's one-second clock
 * re-render instead of recomputing every tick.
 */
export function advanceFailedObservations(
  tasks: Iterable<RosterTaskInput>,
  prev: ReadonlyMap<string, number>,
  now: number,
  prevKnownStates?: ReadonlyMap<string, string>,
): ReadonlyMap<string, number> {
  const next = new Map<string, number>();
  let changed = false;
  for (const task of tasks) {
    if (task.state !== "failed") continue;
    const stamp = prev.get(task.id);
    if (stamp !== undefined) {
      next.set(task.id, stamp);
      continue;
    }
    changed = true;
    const priorState = prevKnownStates?.get(task.id);
    // Live non-failed → failed: clock starts at the transition moment.
    if (priorState !== undefined && priorState !== "failed") {
      next.set(task.id, now);
      continue;
    }
    // Cold load / first sight already failed: honesty from the wire clock.
    next.set(task.id, terminalTransitionMs(task) ?? now);
  }
  if (!changed && next.size === prev.size) return prev;
  return next;
}

function toRosterTask(
  task: RosterTaskInput,
  freshness: FailedFreshness | null | undefined,
): RosterTask {
  const identity = toDisplayTask(task);
  const freshFailure = isFreshFailure(task.id, task.state, freshness);
  return {
    id: task.id,
    name: task.name,
    coat: identity.coat,
    emblem: identity.emblem,
    faction: identity.faction,
    meta: identity.meta,
    // Quiet relative age on attention rows (RosterPanel); null/absent = hide.
    updatedAt: task.updatedAt ?? null,
    // Only meaningful for failed rows; the panel treats undefined as archive
    // defaults from STATE_META.
    freshFailure: task.state === "failed" ? freshFailure : undefined,
    // Run chip for run-owned tasks; plain tasks leave it null (#254).
    runChip: formatRunChip({
      runId: task.runId,
      node: task.node,
      iteration: task.iteration,
      slot: task.slot,
    }),
    // Executor host name for task-card attribution (#324).
    executor: formatExecutorLabel(task.runner),
  };
}

/**
 * Project a flat task list (and optional run peers) into state groups
 * (attention order, empty groups dropped) and the distinct orchestrator
 * sessions among them. The only *core* ordering authority is
 * `@useparley/core`'s `attentionRank`; the optional {@link FailedFreshness}
 * window may lift fresh failures just under stalled (display-layer only —
 * legend / core order stay put).
 *
 * Runs are **peer rows** in the attention group matching each run's own
 * state — never nested under their tasks (#254). A run's tasks stay in their
 * own groups with a run chip.
 *
 * When `selectedSessionId` is set, groups/totals include only that session's
 * tasks and runs (session-less items appear only under "All hands" / null).
 * Session chips always reflect the full unfiltered fleet so the selector and
 * the future scene camera cue stay in sync with every known session (#76) —
 * but only the {@link RECENT_SESSION_CHIP_CAP} most-recently-active ones are
 * returned; older sessions are reached via search (#88). A selected session
 * that falls outside the cap is pinned onto the chip list so the active state
 * stays visible.
 */
export function projectRoster(
  tasks: Iterable<RosterTaskInput>,
  selectedSessionId: string | null = null,
  freshness: FailedFreshness | null = null,
  runs: Iterable<RosterRun> = [],
): RosterProjection {
  const all = [...tasks];
  const allRuns = [...runs];
  const sessionCounts = new Map<string, number>();
  const sessionLastActivity = new Map<string, string>();
  const durableSessions = new Set<string>();

  // Session chips + durable count always come from the full fleet so selecting
  // a chip never collapses the selector to a single option.
  for (const task of all) {
    if (task.orchestratorSession) {
      sessionCounts.set(task.orchestratorSession, (sessionCounts.get(task.orchestratorSession) ?? 0) + 1);
      const at = task.updatedAt ?? "";
      const prev = sessionLastActivity.get(task.orchestratorSession) ?? "";
      if (at > prev) sessionLastActivity.set(task.orchestratorSession, at);
      if (!isTerminalState(task.state)) durableSessions.add(task.orchestratorSession);
    }
  }
  // Runs also keep a session durable while non-terminal.
  for (const run of allRuns) {
    if (run.orchestratorSession) {
      const at = run.updatedAt ?? "";
      const prev = sessionLastActivity.get(run.orchestratorSession) ?? "";
      if (at > prev) sessionLastActivity.set(run.orchestratorSession, at);
      if (
        run.runState === "running" ||
        run.runState === "blocked"
      ) {
        durableSessions.add(run.orchestratorSession);
      }
    }
  }

  const visible =
    selectedSessionId === null
      ? all
      : all.filter((task) => task.orchestratorSession === selectedSessionId);

  const visibleRuns =
    selectedSessionId === null
      ? allRuns
      : allRuns.filter((run) => run.orchestratorSession === selectedSessionId);

  const byState = new Map<string, { tasks: RosterTask[]; runs: RosterRun[] }>();
  let totalTasks = 0;
  let activeTasks = 0;

  for (const task of visible) {
    totalTasks += 1;
    if (!byState.has(task.state)) byState.set(task.state, { tasks: [], runs: [] });
    byState.get(task.state)!.tasks.push(toRosterTask(task, freshness));
    if (!isTerminalState(task.state)) activeTasks += 1;
  }

  for (const run of visibleRuns) {
    const state = run.attentionState;
    if (!byState.has(state)) byState.set(state, { tasks: [], runs: [] });
    byState.get(state)!.runs.push(run);
  }

  // Within a failed group, fresh wrecks float above archived ones so the eye
  // hits the loud row first when both share a header.
  for (const [state, bucket] of byState) {
    if (state !== "failed") continue;
    bucket.tasks.sort((a, b) => {
      const aFresh = a.freshFailure ? 1 : 0;
      const bFresh = b.freshFailure ? 1 : 0;
      if (aFresh !== bFresh) return bFresh - aFresh;
      return a.id.localeCompare(b.id);
    });
  }

  const groups: RosterGroup[] = [...byState.entries()]
    .map(([state, bucket]) => ({
      state,
      tasks: bucket.tasks,
      runs: bucket.runs,
    }))
    .sort((a, b) => {
      const aFresh = a.state === "failed" && a.tasks.some((t) => t.freshFailure);
      const bFresh = b.state === "failed" && b.tasks.some((t) => t.freshFailure);
      const rankDiff = displayAttentionRank(a.state, aFresh) - displayAttentionRank(b.state, bFresh);
      if (rankDiff !== 0) return rankDiff;
      return a.state.localeCompare(b.state);
    });

  // Humane handles from first task name; shortRef stays the mono secondary.
  const identities = collectSessionIdentities(all);

  // Most-recently-active first; id tie-break for stable ordering.
  const allSessions: RosterSessionOption[] = [...sessionCounts.entries()]
    .map(([id, count]) => {
      const identity = identities.get(id) ?? deriveSessionIdentity(id, []);
      // count from sessionCounts is authoritative (identity.count matches).
      return {
        id,
        handle: identity.handle,
        shortRef: identity.shortRef,
        label: identity.label,
        count,
      };
    })
    .sort((a, b) => {
      const aAt = sessionLastActivity.get(a.id) ?? "";
      const bAt = sessionLastActivity.get(b.id) ?? "";
      if (aAt !== bAt) return bAt.localeCompare(aAt);
      return a.id.localeCompare(b.id);
    });

  let sessions = allSessions.slice(0, RECENT_SESSION_CHIP_CAP);
  // Pin a selected session that fell outside the recent cap (search pick, or
  // an older chip the user still has active) so the active state stays visible.
  // Only pin when the session still has tasks in the fleet — a gone selection
  // is cleared by useCockpit, not kept as a ghost chip.
  if (selectedSessionId !== null && !sessions.some((s) => s.id === selectedSessionId)) {
    const fromFleet = allSessions.find((s) => s.id === selectedSessionId);
    if (fromFleet) sessions = [...sessions, fromFleet];
  }

  return { groups, sessions, totalTasks, activeTasks, durableSessions: durableSessions.size };
}
