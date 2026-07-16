/**
 * Layer 4 (hooks) — pure scene projection (#69). Groups the same plain task list
 * the roster and inbox read into one region per orchestrator session (the spec's
 * "big ship"), each carrying its tasks with the faction tint and the canonical
 * state string the scene renders islands from.
 *
 * State agreement is structural, not coincidental: this reads each task's `state`
 * verbatim — the very string `projectRoster`/`projectInbox` group and badge by —
 * so an island's `data-state`, its roster badge, and its inbox card can never
 * disagree (they are three views of one projected value, per component-system
 * spec contract 6).
 *
 * Islands are keyed and ordered by task id, never by state: a task keeps its
 * place in the cove as it transitions, so `pending → running → awaiting` reads as
 * one island changing rather than islands leaping between slots.
 *
 * Per-session attention rollup (edge-of-frame alerts): the loudest
 * operator-notice state among a region's tasks, ranked only by core's
 * `attentionRank` — never re-derived here (contract 6 / PRODUCT.md "attention
 * hierarchy is law"). Membership is core's `isAttentionState` (awaiting +
 * stalled) plus `failed`, so a single glance at the cove answers "is anything
 * wrong?" even when the trouble sits off-camera.
 */
import { attentionRank, isAttentionState } from "@useparley/core";
import { factionFor, type EmblemMark } from "../../tokens/factions.js";
import { shortId, type RosterTaskInput } from "./roster.js";

/** One task as the scene renders it — an island (+ its sloop and effects). */
export interface SceneTask {
  id: string;
  name: string;
  /** Canonical task state — the single value driving `data-state` on the island
   * (and, via the same string, the roster badge and inbox card). */
  state: string;
  /** Faction coat colour (hex) — set as `--coat` on the sloop wrapper. */
  coat: string;
  /** Darker coat (hex) — set as `--coat-dark` for hulls/waterlines/pennants. */
  coatDark: string;
  /** Faction emblem mark, flown on the sloop's sail. */
  emblem: EmblemMark;
}

/**
 * Loudest operator-notice state on a session region — drives the edge-of-frame
 * attention chip when that region sits outside the camera frame. `null` means
 * the region is calm (no awaiting / stalled / failed islands).
 */
export interface SceneSessionAttention {
  /** Loudest state string among the session's edge-attention tasks. */
  state: string;
  /** Count of tasks in that loudest state (aria label + chip density). */
  count: number;
  /** Core `attentionRank(state)` — lower is louder. The scene sorts stacked
   * edge chips by this number so it never re-derives the hierarchy. */
  rank: number;
}

/** One orchestrator session's water region — its galleon and task-islands. */
export interface SceneSession {
  /** Orchestrator session id, or null for session-less (e.g. CLI-delegated)
   * tasks that still deserve an island in open water. */
  id: string | null;
  /** Short display label for the region banner. */
  label: string;
  tasks: SceneTask[];
  /** Per-session attention rollup for edge-of-frame indicators; null = calm. */
  attention: SceneSessionAttention | null;
}

/** The full scene projection — every session region in one continuous sea. */
export interface SceneView {
  sessions: SceneSession[];
}

/** Sentinel key for the open-water region (session-less tasks) — NUL-prefixed
 * and kept out of the public `id` (which stays null) so it can never collide
 * with a real session id. */
const OPEN_WATER = "\0open-water";

/**
 * True when a task state should surface as an edge-of-frame alert. Membership
 * comes from core: `isAttentionState` (awaiting_answer, stalled) plus failed
 * (terminal failure still demands notice for PRODUCT.md "is anything wrong?").
 * Rank among these is always `attentionRank` — this only decides membership.
 */
export function isSceneAttentionState(state: string): boolean {
  return isAttentionState(state) || state === "failed";
}

/**
 * Roll a session's tasks into its loudest edge-attention signal. Ranking is
 * solely `@useparley/core`'s `attentionRank` (lower = louder); calm sessions
 * return null so the scene renders nothing on that side.
 */
export function rollupSessionAttention(
  tasks: Iterable<{ state: string }>,
): SceneSessionAttention | null {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    if (!isSceneAttentionState(task.state)) continue;
    counts.set(task.state, (counts.get(task.state) ?? 0) + 1);
  }
  if (counts.size === 0) return null;

  let loudest: string | null = null;
  let loudestRank = Infinity;
  for (const state of counts.keys()) {
    const rank = attentionRank(state);
    if (rank < loudestRank) {
      loudest = state;
      loudestRank = rank;
    }
  }
  if (loudest === null) return null;
  return {
    state: loudest,
    count: counts.get(loudest)!,
    rank: loudestRank,
  };
}

function toSceneTask(task: RosterTaskInput): SceneTask {
  const faction = factionFor(task.vendor);
  return {
    id: task.id,
    name: task.name,
    state: task.state,
    coat: faction.coat,
    coatDark: faction.coatDark,
    emblem: faction.emblem,
  };
}

/**
 * Project a flat task list into per-session regions. Sessions sort by id (open
 * water last) and each region's islands sort by task id — both stable, so the
 * cove's geography holds still across transitions and reloads. Each region also
 * carries its attention rollup for the edge-of-frame chips.
 */
export function projectScene(tasks: Iterable<RosterTaskInput>): SceneView {
  const bySession = new Map<string, SceneTask[]>();
  for (const task of tasks) {
    const key = task.orchestratorSession ?? OPEN_WATER;
    if (!bySession.has(key)) bySession.set(key, []);
    bySession.get(key)!.push(toSceneTask(task));
  }

  const sessions: SceneSession[] = [...bySession.entries()]
    .sort(([a], [b]) => {
      // Named sessions sort by id; the open-water region always brings up the rear.
      if (a === OPEN_WATER) return 1;
      if (b === OPEN_WATER) return -1;
      return a.localeCompare(b);
    })
    .map(([key, sceneTasks]) => {
      const sorted = sceneTasks.sort((a, b) => a.id.localeCompare(b.id));
      return {
        id: key === OPEN_WATER ? null : key,
        label: key === OPEN_WATER ? "Open water" : shortId(key),
        tasks: sorted,
        attention: rollupSessionAttention(sorted),
      };
    });

  return { sessions };
}
