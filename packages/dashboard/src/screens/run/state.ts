/**
 * Run-detail state vocabulary — maps wire states to display labels, CSS state
 * tokens, and fork cues. State is never hue-only (DESIGN.md / PRODUCT.md).
 *
 * Gate verbs (approve · reject · redirect · finish) belong to the orchestrating
 * agent — this module only labels; it never posts.
 */
import type { NodeProjection, RunBlock, RunBlockReason, RunSummary } from "@useparley/core";

/** Exact gate verb list from the design register (read-only surface). */
export const GATE_VERBS = ["approve", "reject", "redirect", "finish"] as const;
export type GateVerb = (typeof GATE_VERBS)[number];

/** Block-reason vocabulary (wire RunBlockReason → display parenthetical). */
export const BLOCK_REASON_LABELS: Record<RunBlockReason, string> = {
  gate: "gate",
  loop_exhausted: "loop",
  success_policy: "slots",
  spawn_error: "spawn",
  unfilled_inputs: "inputs",
  unknown: "blocked",
};

/** CSS custom-property token for a task/run lifecycle state. */
export type StateToken =
  | "pending"
  | "queued"
  | "running"
  | "awaiting"
  | "stalled"
  | "completed"
  | "failed"
  | "cancelled";

export interface NodeDisplayState {
  /** Uppercase mono chip label. */
  label: string;
  /** State color token (paired with label — never hue alone). */
  token: StateToken;
  /** Live pulse on the state dot. */
  live: boolean;
  /**
   * Fork vocabulary (coverage audit):
   * - `inherited` — struck/quiet step marker from a parent run
   * - `skipped` — loud gate cue when fork re-entry past the gate
   * - null — ordinary node
   */
  forkKind: "inherited" | "skipped" | null;
  /** Loud text cue (not hue-only) for skipped / failed. */
  cue: string | null;
  /** Whether the node name is struck through (inherited). */
  struck: boolean;
  /** Quiet secondary ink for inherited names. */
  quiet: boolean;
  /** Row / card ground emphasis (held gate). */
  emphasis: "none" | "held" | "failed" | "pending";
}

/** Map a wire node projection to display state. */
export function projectNodeDisplay(node: NodeProjection): NodeDisplayState {
  const state = node.state;

  // Fork markers — shape/label/weight distinct, not hue-only.
  if (state === "inherited") {
    return {
      label: "INHERITED",
      token: "pending",
      live: false,
      forkKind: "inherited",
      cue: null,
      struck: true,
      quiet: true,
      emphasis: "pending",
    };
  }
  if (state === "skipped") {
    return {
      label: "SKIPPED",
      token: "cancelled",
      live: false,
      forkKind: "skipped",
      cue: " ⊘ fork",
      struck: false,
      quiet: false,
      emphasis: "none",
    };
  }

  if (node.kind === "gate") {
    if (state === "waiting") {
      return {
        label: "HELD",
        token: "awaiting",
        live: true,
        forkKind: null,
        cue: null,
        struck: false,
        quiet: false,
        emphasis: "held",
      };
    }
    if (
      state === "approved" ||
      state === "rejected" ||
      state === "redirected" ||
      state === "finished"
    ) {
      return {
        label: state.toUpperCase(),
        token: "completed",
        live: false,
        forkKind: null,
        cue: null,
        struck: false,
        quiet: false,
        emphasis: "none",
      };
    }
    if (state === "actioned") {
      return {
        label: "ACTIONED",
        token: "completed",
        live: false,
        forkKind: null,
        cue: null,
        struck: false,
        quiet: false,
        emphasis: "none",
      };
    }
  }

  switch (state) {
    case "running":
      return base("RUNNING", "running", true);
    case "queued":
      return base("QUEUED", "queued", false);
    case "pending":
      return { ...base("PENDING", "pending", false), quiet: true, emphasis: "pending" };
    case "completed":
      return base("COMPLETED", "completed", false);
    case "failed":
      return { ...base("FAILED", "failed", false), cue: " !", emphasis: "failed" };
    case "cancelled":
      return base("CANCELLED", "cancelled", false);
    case "stalled":
      return base("STALLED", "stalled", true);
    case "awaiting_answer":
      return base("AWAITING", "awaiting", true);
    case "waiting":
      // Non-gate blocked (e.g. loop budget).
      return {
        label: "BLOCKED",
        token: "stalled",
        live: true,
        forkKind: null,
        cue: null,
        struck: false,
        quiet: false,
        emphasis: "held",
      };
    case "purged":
      return base("PURGED", "cancelled", false);
    default:
      return base(state.toUpperCase() || "—", "pending", false);
  }
}

function base(label: string, token: StateToken, live: boolean): NodeDisplayState {
  return {
    label,
    token,
    live,
    forkKind: null,
    cue: null,
    struck: false,
    quiet: false,
    emphasis: "none",
  };
}

/** Run-level state chip (header). */
export function projectRunStateLabel(
  run: RunSummary,
  block: RunBlock | null | undefined,
): { label: string; token: StateToken; live: boolean } {
  if (run.state === "blocked" && block) {
    const paren = formatBlockParenthetical(block);
    return {
      label: paren === "gate" ? "BLOCKED · GATE HELD" : `BLOCKED · ${paren.toUpperCase()}`,
      token: block.reason === "gate" ? "awaiting" : "stalled",
      live: true,
    };
  }
  switch (run.state) {
    case "running":
      return { label: "RUNNING", token: "running", live: true };
    case "completed":
      return { label: "COMPLETED", token: "completed", live: false };
    case "failed":
      return { label: "FAILED", token: "failed", live: false };
    case "cancelled":
      return { label: "CANCELLED", token: "cancelled", live: false };
    case "purged":
      return { label: "PURGED", token: "cancelled", live: false };
    default:
      return { label: run.state.toUpperCase(), token: "pending", live: false };
  }
}

/** Block reason → list/header parenthetical (matches daemon formatBlockParenthetical). */
export function formatBlockParenthetical(block: RunBlock): string {
  switch (block.reason) {
    case "gate":
      return "gate";
    case "loop_exhausted": {
      const cur = block.iteration ?? "?";
      const max = block.max ?? cur;
      return `loop ${cur}/${max}`;
    }
    case "success_policy": {
      const detail = block.detail ?? "";
      const m = detail.match(/(\d+)\s*\/\s*(\d+)\s*slots/i);
      if (m) return `${m[1]}/${m[2]} slots`;
      return "slots";
    }
    case "spawn_error":
      return "spawn";
    case "unfilled_inputs":
      return "inputs";
    default:
      return BLOCK_REASON_LABELS[block.reason] ?? "blocked";
  }
}

/** Helm notice copy — exact verb list, observation-only. */
export const GATE_READONLY_NOTICE =
  "gate verbs (approve · reject · redirect · finish) belong to the orchestrating agent — this surface is read-only";

/** Task lifecycle state → chip label/token (run-tasks panel). */
export function projectTaskStateChip(state: string): {
  label: string;
  token: StateToken;
  live: boolean;
} {
  switch (state) {
    case "running":
      return { label: "RUNNING", token: "running", live: true };
    case "queued":
      return { label: "QUEUED", token: "queued", live: false };
    case "pending":
      return { label: "PENDING", token: "pending", live: false };
    case "completed":
      return { label: "COMPLETED", token: "completed", live: false };
    case "failed":
      return { label: "FAILED", token: "failed", live: false };
    case "cancelled":
      return { label: "CANCELLED", token: "cancelled", live: false };
    case "stalled":
      return { label: "STALLED", token: "stalled", live: true };
    case "awaiting_answer":
      return { label: "AWAITING", token: "awaiting", live: true };
    default:
      return { label: (state || "—").toUpperCase(), token: "pending", live: false };
  }
}
