/**
 * #208 — status/list presentation against envelope fixtures (no daemon db import).
 */
import { describe, expect, it } from "vitest";
import type { TaskEnvelope } from "@useparley/core";

/** Mirror of CLI table helpers' encoding expectations against a wire envelope. */
function formatUsage(usage: Record<string, number> | null): string {
  if (usage === null) return "n/r";
  const { input_tokens, output_tokens } = usage;
  if (input_tokens === undefined && output_tokens === undefined) return "n/r";
  const k = (n: number): string => {
    const v = Math.round((n / 1000) * 10) / 10;
    return `${v}k`;
  };
  return `${k(input_tokens ?? 0)} in/${k(output_tokens ?? 0)} out`;
}

function formatState(task: TaskEnvelope): string {
  if (task.state !== "queued") return task.state;
  const pos = typeof task.queue_position === "number" ? task.queue_position : null;
  const cap = task.blocking_cap ?? null;
  const parts: string[] = ["queued"];
  if (pos !== null) parts.push(`#${pos}`);
  if (cap) parts.push(`(${cap})`);
  return parts.join(" ");
}

function presentEnvelope(task: TaskEnvelope): Record<string, unknown> {
  const cached = task.cached_input_tokens === undefined ? null : task.cached_input_tokens;
  return {
    ...task,
    attempt: task.attempt ?? 1,
    parent_task_id: task.parent_task_id ?? null,
    cached_input_tokens: cached,
    cache_hit: cached === null ? null : cached > 0,
  };
}

function envelope(partial: Partial<TaskEnvelope> & Pick<TaskEnvelope, "task_id" | "state">): TaskEnvelope {
  return {
    name: null,
    repo: null,
    worktree: null,
    branch: null,
    vendor: "fake",
    model: null,
    effort: null,
    profile: null,
    posture: { sandbox: "workspace", network: true },
    session_id: null,
    orchestrator_session_id: "sess-1",
    updated_at: "2026-01-01T00:00:00.000Z",
    created_at: "2026-01-01T00:00:00.000Z",
    started_at: null,
    completed_at: null,
    orch_harness: null,
    orch_model: null,
    orch_effort: null,
    usage: null,
    duration_ms: null,
    report: null,
    report_schema: {},
    error: null,
    logs_dir: null,
    question_id: null,
    question: null,
    seq: 1,
    eval_expected: false,
    size: null,
    difficulty: null,
    type: "other",
    parent_task_id: null,
    attempt: 1,
    resumed: false,
    cached_input_tokens: null,
    ...partial,
  };
}

describe("list presentation over TaskEnvelope (#208)", () => {
  it("formats usage and queue state from decoded fields", () => {
    expect(formatUsage(null)).toBe("n/r");
    expect(formatUsage({ input_tokens: 1200, output_tokens: 3400 })).toBe("1.2k in/3.4k out");
    expect(
      formatState(
        envelope({
          task_id: "t1",
          state: "queued",
          queue_position: 2,
          blocking_cap: "vendor:fake",
        }),
      ),
    ).toBe("queued #2 (vendor:fake)");
  });

  it("presents JSON without storage encodings", () => {
    const out = presentEnvelope(
      envelope({
        task_id: "t1",
        state: "completed",
        usage: { input_tokens: 1 },
        cached_input_tokens: 5,
        posture: { sandbox: "workspace", network: false },
      }),
    );
    expect(out.task_id).toBe("t1");
    expect(out.usage).toEqual({ input_tokens: 1 });
    expect(out.cache_hit).toBe(true);
    expect(out.posture).toEqual({ sandbox: "workspace", network: false });
    expect(out).not.toHaveProperty("network");
    expect(out).not.toHaveProperty("id");
  });
});
