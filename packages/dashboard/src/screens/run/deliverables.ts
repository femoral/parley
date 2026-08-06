/**
 * Deliverable fetch-state honesty (coverage audit §2A #9).
 *
 * Wire: `GET /deliverables/:id` returns inline value or path ref with live
 * `exists` + optional `note` / `purged_at`. Console never invents a value.
 */
import type { DeliverableRef, DeliverableValue } from "@useparley/core";

export type DeliverableFetchState =
  | "not_fetched"
  | "none"
  | "ready"
  | "error"
  | "purged"
  | "missing-worktree";

export interface DeliverableRow {
  ref: DeliverableRef;
  /** Per-row honesty after optional value fetch. */
  fetchState: DeliverableFetchState;
  value: DeliverableValue | null;
  error: string | null;
  /** Primary body text for the row. */
  body: string;
  /** Secondary meta (kind · size · presence). */
  meta: string;
  address: string;
}

export function deliverableAddress(ref: DeliverableRef): string {
  const slot = ref.slot ? `[${ref.slot}]` : "";
  const iter = ref.iteration > 0 ? `.${ref.iteration}` : "";
  return `${ref.node}${iter}${slot}/${ref.port}`;
}

/**
 * Project one deliverable ref + optional value into a display row.
 * When `value` is undefined the row is still `not_fetched` (list-only).
 */
export function projectDeliverableRow(
  ref: DeliverableRef,
  value: DeliverableValue | null | undefined,
  error: string | null = null,
): DeliverableRow {
  // Prefer full value fields when the list ref is an id-only stub.
  const address =
    value && value.node
      ? deliverableAddress(value)
      : ref.node
        ? deliverableAddress(ref)
        : (value?.deliverable_id ?? ref.deliverable_id);

  if (error) {
    return {
      ref,
      fetchState: "error",
      value: null,
      error,
      body: error,
      meta: `${ref.kind} · error`,
      address,
    };
  }

  // Ref itself can carry purge even without a value fetch.
  if (ref.purged_at) {
    return {
      ref,
      fetchState: "purged",
      value: value ?? null,
      error: null,
      body: value?.path ?? value?.absolute_path ?? "purged",
      meta: `purged · ${ref.purged_at.slice(0, 10)} · retention`,
      address,
    };
  }

  if (value === undefined) {
    return {
      ref,
      fetchState: "not_fetched",
      value: null,
      error: null,
      body: "not fetched",
      meta: `${ref.kind} · list only`,
      address,
    };
  }

  if (value === null) {
    return {
      ref,
      fetchState: "error",
      value: null,
      error: "missing value",
      body: "missing value",
      meta: `${ref.kind} · error`,
      address,
    };
  }

  if (value.purged_at) {
    return {
      ref,
      fetchState: "purged",
      value,
      error: null,
      body: value.path ?? value.absolute_path ?? "purged",
      meta: `purged · ${value.purged_at.slice(0, 10)} · retention`,
      address,
    };
  }

  // Path kinds with exists === false → missing worktree / path.
  if (
    (value.kind === "file" || value.kind === "dir") &&
    value.exists === false
  ) {
    const note = value.note ?? "path missing (worktree gone or not materialised)";
    return {
      ref,
      fetchState: "missing-worktree",
      value,
      error: null,
      body: value.path ?? value.absolute_path ?? note,
      meta: `${value.kind} · missing · ${note}`,
      address,
    };
  }

  // Ready — inline value or present path.
  if (value.kind === "inline") {
    const body =
      value.value === null || value.value === undefined
        ? "(null)"
        : typeof value.value === "string"
          ? value.value
          : JSON.stringify(value.value, null, 2);
    const size = sizeMeta(value);
    return {
      ref,
      fetchState: "ready",
      value,
      error: null,
      body,
      meta: size ? `inline · ${size}` : "inline",
      address,
    };
  }

  const path = value.path ?? value.absolute_path ?? "—";
  const size = sizeMeta(value);
  const presence = value.exists === true ? "present" : value.exists === false ? "absent" : "unknown";
  return {
    ref,
    fetchState: "ready",
    value,
    error: null,
    body: path,
    meta: [value.kind, size, presence].filter(Boolean).join(" · "),
    address,
  };
}

function sizeMeta(value: DeliverableValue): string | null {
  const s = value.size;
  if (!s) return null;
  if (typeof s.bytes === "number") {
    if (s.bytes < 1024) return `${s.bytes} B`;
    if (s.bytes < 1024 * 1024) return `${(s.bytes / 1024).toFixed(1)} kB`;
    return `${(s.bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (typeof s.elements === "number") return `${s.elements} el`;
  if (typeof s.keys === "number") return `${s.keys} keys`;
  return null;
}

/** Panel-level status from a set of rows + loading flag. */
export function projectDeliverablesPanelState(input: {
  refs: readonly DeliverableRef[];
  rows: readonly DeliverableRow[];
  loading: boolean;
  listError: string | null;
}): {
  status: DeliverableFetchState | "loading" | "error";
  label: string;
} {
  if (input.listError) {
    return { status: "error", label: `error · ${input.listError}` };
  }
  if (input.loading && input.rows.length === 0) {
    return { status: "loading", label: "fetching…" };
  }
  if (input.refs.length === 0) {
    return { status: "none", label: "none" };
  }
  const states = new Set(input.rows.map((r) => r.fetchState));
  if (states.has("error") && states.size === 1) {
    return { status: "error", label: "error" };
  }
  if (states.has("not_fetched") && !states.has("ready") && !states.has("purged")) {
    return { status: "not_fetched", label: `not fetched · ${input.refs.length} refs` };
  }
  const ready = input.rows.filter((r) => r.fetchState === "ready").length;
  const purged = input.rows.filter((r) => r.fetchState === "purged").length;
  const missing = input.rows.filter((r) => r.fetchState === "missing-worktree").length;
  const parts = [`ready · ${ready} row${ready === 1 ? "" : "s"}`];
  if (purged) parts.push(`${purged} purged`);
  if (missing) parts.push(`${missing} missing`);
  return { status: "ready", label: parts.join(" · ") };
}
