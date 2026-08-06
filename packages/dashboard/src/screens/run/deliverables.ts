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

export type DeliverableKindDisplay = "inline" | "file" | "dir" | "unknown";

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
  /** Display kind — "unknown" for id-only stubs that never invent INLINE. */
  kindDisplay: DeliverableKindDisplay;
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

  // Id-only stubs (empty node) must not claim kind:"inline".
  const kindDisplay: DeliverableKindDisplay =
    value && value.kind
      ? value.kind
      : ref.node
        ? ref.kind
        : "unknown";

  if (error) {
    return {
      ref,
      fetchState: "error",
      value: null,
      error,
      body: error,
      meta: `${kindDisplay} · error`,
      address,
      kindDisplay,
    };
  }

  if (ref.purged_at) {
    return {
      ref,
      fetchState: "purged",
      value: value ?? null,
      error: null,
      body: value?.path ?? value?.absolute_path ?? "purged",
      meta: `purged · ${ref.purged_at.slice(0, 10)} · retention`,
      address,
      kindDisplay,
    };
  }

  if (value === undefined) {
    return {
      ref,
      fetchState: "not_fetched",
      value: null,
      error: null,
      body: "not fetched",
      meta: `${kindDisplay} · list only`,
      address,
      kindDisplay,
    };
  }

  if (value === null) {
    return {
      ref,
      fetchState: "error",
      value: null,
      error: "missing value",
      body: "missing value",
      meta: `${kindDisplay} · error`,
      address,
      kindDisplay,
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
      kindDisplay: value.kind,
    };
  }

  if ((value.kind === "file" || value.kind === "dir") && value.exists === false) {
    const note = value.note ?? "path missing (worktree gone or not materialised)";
    return {
      ref,
      fetchState: "missing-worktree",
      value,
      error: null,
      body: value.path ?? value.absolute_path ?? note,
      meta: `${value.kind} · missing · ${note}`,
      address,
      kindDisplay: value.kind,
    };
  }

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
      kindDisplay: "inline",
    };
  }

  const path = value.path ?? value.absolute_path ?? "—";
  const size = sizeMeta(value);
  const presence =
    value.exists === true ? "present" : value.exists === false ? "absent" : "unknown";
  return {
    ref,
    fetchState: "ready",
    value,
    error: null,
    body: path,
    meta: [value.kind, size, presence].filter(Boolean).join(" · "),
    address,
    kindDisplay: value.kind,
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

/** Panel-level status — lead with the dominant state, never "ready" for zero ready. */
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

  const ready = input.rows.filter((r) => r.fetchState === "ready").length;
  const purged = input.rows.filter((r) => r.fetchState === "purged").length;
  const missing = input.rows.filter((r) => r.fetchState === "missing-worktree").length;
  const errored = input.rows.filter((r) => r.fetchState === "error").length;
  const notFetched = input.rows.filter((r) => r.fetchState === "not_fetched").length;

  // Dominant state by count (priority: error > purged > missing > not_fetched > ready).
  type Count = { key: DeliverableFetchState; n: number; priority: number };
  const counts: Count[] = [
    { key: "error", n: errored, priority: 0 },
    { key: "purged", n: purged, priority: 1 },
    { key: "missing-worktree", n: missing, priority: 2 },
    { key: "not_fetched", n: notFetched, priority: 3 },
    { key: "ready", n: ready, priority: 4 },
  ].filter((c) => c.n > 0) as Count[];

  counts.sort((a, b) => b.n - a.n || a.priority - b.priority);
  const dominant = counts[0]?.key ?? "none";

  if (dominant === "error" && ready === 0 && purged === 0 && missing === 0) {
    return { status: "error", label: `error · ${errored}` };
  }
  if (dominant === "not_fetched" && ready === 0 && purged === 0) {
    return {
      status: "not_fetched",
      label: `not fetched · ${input.refs.length} ref${input.refs.length === 1 ? "" : "s"}`,
    };
  }

  const parts: string[] = [];
  // Lead with dominant.
  if (dominant === "purged") {
    parts.push(`${purged} purged`);
    if (ready) parts.push(`${ready} ready`);
    if (missing) parts.push(`${missing} missing`);
    if (errored) parts.push(`${errored} error`);
    return { status: "purged", label: parts.join(" · ") };
  }
  if (dominant === "missing-worktree") {
    parts.push(`${missing} missing`);
    if (ready) parts.push(`${ready} ready`);
    if (purged) parts.push(`${purged} purged`);
    return { status: "missing-worktree", label: parts.join(" · ") };
  }
  if (dominant === "error") {
    parts.push(`error · ${errored}`);
    if (ready) parts.push(`${ready} ready`);
    if (purged) parts.push(`${purged} purged`);
    return { status: "error", label: parts.join(" · ") };
  }

  // Ready (or mixed with ready leading).
  parts.push(`${ready} row${ready === 1 ? "" : "s"}`);
  if (purged) parts.push(`${purged} purged`);
  if (missing) parts.push(`${missing} missing`);
  if (errored) parts.push(`${errored} error`);
  return {
    status: ready > 0 ? "ready" : "none",
    label: ready > 0 ? `ready · ${parts.join(" · ")}` : parts.join(" · ") || "none",
  };
}
