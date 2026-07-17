/**
 * Task detail enrichment for status / GET /tasks/:ref (#164):
 * attempt lineage, session provenance, and structured eval detail.
 */
import type {
  AttemptLineageEntry,
  EvalCriterionDetail,
  EvalDetail,
  SessionProvenance,
} from "@useparley/core";
import { getShippedRubric } from "@useparley/core";
import type { TaskRow } from "./db.js";
import { isLegacyEval, isRubricEval } from "./metrics.js";
import { parseJsonColumn } from "./report.js";
import { loadRubric } from "./rubrics.js";

/** Derived cache-hit tri-state: true when >0, false when 0, null when unreported. */
function cacheHit(cached: number | null | undefined): boolean | null {
  if (cached === null || cached === undefined) return null;
  return cached > 0;
}

/** Map one task row into an attempt-lineage entry. */
export function toAttemptEntry(task: TaskRow): AttemptLineageEntry {
  const cached = task.cached_input_tokens ?? null;
  return {
    id: task.id,
    name: task.name,
    attempt: task.attempt ?? 1,
    parent_task_id: task.parent_task_id ?? null,
    state: task.state,
    resumed: task.resumed === 1,
    cached_input_tokens: cached,
    cache_hit: cacheHit(cached),
    eval_score: task.eval_score,
    eval_baseline: task.eval_baseline ?? null,
    eval_rubric: task.eval_rubric ?? null,
    eval_rubric_version: task.eval_rubric_version ?? null,
    eval_legacy: isLegacyEval(task),
  };
}

/**
 * Walk the parent_task_id chain to the root, then collect every task that
 * belongs to the same chain (root → latest by attempt, then id for stability).
 */
export function buildAttemptChain(
  task: TaskRow,
  allTasks: readonly TaskRow[],
): AttemptLineageEntry[] {
  const byId = new Map(allTasks.map((t) => [t.id, t]));

  // Walk up to the root of this chain.
  let root = task;
  const seen = new Set<string>([root.id]);
  while (root.parent_task_id !== null && root.parent_task_id !== undefined) {
    const parent = byId.get(root.parent_task_id);
    if (parent === undefined || seen.has(parent.id)) break;
    seen.add(parent.id);
    root = parent;
  }

  // Collect every task whose root (via parent walk) is this root.
  const members: TaskRow[] = [];
  for (const t of allTasks) {
    let cur: TaskRow | undefined = t;
    const walk = new Set<string>();
    while (cur !== undefined) {
      if (walk.has(cur.id)) break;
      walk.add(cur.id);
      if (cur.id === root.id) {
        members.push(t);
        break;
      }
      if (cur.parent_task_id === null || cur.parent_task_id === undefined) break;
      cur = byId.get(cur.parent_task_id);
    }
  }

  members.sort((a, b) => {
    const aa = a.attempt ?? 1;
    const ba = b.attempt ?? 1;
    if (aa !== ba) return aa - ba;
    return a.id.localeCompare(b.id);
  });

  return members.map(toAttemptEntry);
}

/** Spawn-time orchestrator provenance snapshot. */
export function buildSessionProvenance(task: TaskRow): SessionProvenance {
  return {
    session_id: task.orchestrator_session_id,
    harness: task.orch_harness ?? null,
    model: task.orch_model ?? null,
    effort: task.orch_effort ?? null,
  };
}

/**
 * Build eval detail for status/inspector. Returns null when never scored.
 * Criterion text/weights come from the current rubric definition when loadable;
 * answers alone still surface when the rubric document is unavailable.
 */
export function buildEvalDetail(task: TaskRow): EvalDetail | null {
  if (task.eval_score === null || !Number.isFinite(task.eval_score)) {
    return null;
  }

  const legacy = isLegacyEval(task);
  const baseline =
    task.eval_baseline !== null &&
    task.eval_baseline !== undefined &&
    Number.isFinite(task.eval_baseline)
      ? task.eval_baseline
      : null;
  const score = task.eval_score;
  const delta = baseline !== null ? score - baseline : null;
  const below_baseline = baseline !== null ? score < baseline : null;

  const judge =
    task.eval_session_id !== null ||
    task.eval_harness !== null ||
    task.eval_model !== null ||
    task.eval_effort !== null
      ? {
          session_id: task.eval_session_id ?? null,
          harness: task.eval_harness ?? null,
          model: task.eval_model ?? null,
          effort: task.eval_effort ?? null,
        }
      : null;

  let criteria: EvalCriterionDetail[] | null = null;
  if (isRubricEval(task)) {
    const answers = parseJsonColumn<Record<string, boolean>>(task.eval_answers ?? null);
    if (answers !== null && typeof answers === "object" && !Array.isArray(answers)) {
      // Prefer project override via task.repo; fall back to shipped.
      let rubricDoc = null as ReturnType<typeof getShippedRubric>;
      try {
        if (task.eval_rubric) {
          rubricDoc = loadRubric(task.repo, task.eval_rubric);
        }
      } catch {
        rubricDoc = task.eval_rubric ? getShippedRubric(task.eval_rubric) : null;
      }
      if (rubricDoc === null && task.eval_rubric) {
        rubricDoc = getShippedRubric(task.eval_rubric);
      }

      if (rubricDoc !== null) {
        criteria = rubricDoc.criteria.map((c) => {
          const answer = answers[c.id] ?? false;
          const pass = c.kind === "positive" ? answer === true : answer === false;
          return {
            id: c.id,
            kind: c.kind,
            weight: c.weight,
            text: c.text,
            answer,
            pass,
          };
        });
      } else {
        // No rubric document — still list answered criteria without kind/text.
        criteria = Object.entries(answers)
          .filter(([, a]) => typeof a === "boolean")
          .map(([id, answer]) => ({
            id,
            kind: "positive" as const,
            weight: 0,
            text: "",
            answer,
            pass: answer,
          }));
      }
    }
  }

  return {
    score,
    baseline,
    delta,
    below_baseline,
    legacy,
    rubric: task.eval_rubric ?? null,
    rubric_version: task.eval_rubric_version ?? null,
    feedback: task.eval_feedback,
    judge,
    criteria,
  };
}
