/**
 * Layer 4 (hooks) — poll the run query surface for the roster + inspector
 * (#254 / #255 / ADR-0021 / #241). Uses `ParleyClient.listRuns` / `getRun` /
 * `getDeliverable` only — no parallel fetch shape.
 *
 * Deliverables (#255 F1): fetched only for the *selected* run when its detail
 * is available, not for every live run on every poll tick (#262).
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type {
  DeliverableValue,
  NodeProjection,
  ParleyClient,
  RunDetailResponse,
  RunSummary,
} from "@useparley/core";
import type { InspectorRun, RosterRun } from "../../hud/types.js";
import { projectInspectorRun, projectRosterRun } from "./runs.js";

const DEFAULT_POLL_MS = 3000;

export interface RunsView {
  /** Projected roster run rows (full fleet; session filter is applied in projectRoster). */
  runs: RosterRun[];
  /** Wire list, identity-stable between polls when content is unchanged. */
  summaries: RunSummary[];
  /** Detail cache keyed by run id (for pip fidelity + inspector). */
  details: ReadonlyMap<string, RunDetailResponse>;
}

const EMPTY_DETAILS: ReadonlyMap<string, RunDetailResponse> = new Map();

// ── Selected-run deliverable cache (#255 F1) ────────────────────────────────
// Shared between useRuns (writer) and useInspectorRun (reader) so Cockpit.tsx
// need not change (sibling quarantine). Only the selected run's ids are fetched.

type SelectedDlvCache = {
  runId: string | null;
  /** Sorted unique id key for the fetch we last started. */
  idKey: string;
  /**
   * `undefined` — not yet resolved for this run/idKey.
   * array — resolved (empty = none).
   */
  values: DeliverableValue[] | undefined;
};

let selectedDlv: SelectedDlvCache = {
  runId: null,
  idKey: "",
  values: undefined,
};
const selectedDlvListeners = new Set<() => void>();

function subscribeSelectedDlv(onStoreChange: () => void): () => void {
  selectedDlvListeners.add(onStoreChange);
  return () => {
    selectedDlvListeners.delete(onStoreChange);
  };
}

function getSelectedDlvSnapshot(): SelectedDlvCache {
  return selectedDlv;
}

function setSelectedDlv(next: SelectedDlvCache): void {
  selectedDlv = next;
  for (const l of selectedDlvListeners) l();
}

/** Test helper — reset the selected-deliverable cache between suites. */
export function __resetSelectedDeliverableCacheForTests(): void {
  selectedDlv = { runId: null, idKey: "", values: undefined };
}

function deliverableIdKey(detail: RunDetailResponse): string {
  const ids = new Set<string>();
  for (const node of detail.nodes) {
    for (const id of node.deliverables) {
      if (id) ids.add(id);
    }
  }
  return [...ids].sort().join("\0");
}

/**
 * Poll `GET /runs` and warm `GET /runs/:ref` for each live run so the roster
 * pip track and the inspector share one projection source.
 */
export function useRuns(
  client: ParleyClient,
  options: {
    /** Currently selected run — always kept fresh even when terminal. */
    selectedRunId?: string | null;
    pollMs?: number;
    /** When false, stop polling (e.g. tab hidden — caller may omit). */
    enabled?: boolean;
  } = {},
): RunsView {
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const enabled = options.enabled !== false;
  const selectedRunId = options.selectedRunId ?? null;

  const [summaries, setSummaries] = useState<RunSummary[]>([]);
  const [details, setDetails] = useState<Map<string, RunDetailResponse>>(
    () => new Map(),
  );
  const detailsRef = useRef(details);
  detailsRef.current = details;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async (): Promise<void> => {
      try {
        const list = await client.listRuns();
        if (cancelled) return;
        setSummaries(list.runs);

        // Warm details for non-terminal runs + the current selection so the
        // pip track is fan-out-accurate and the inspector has a node table.
        const needDetail = new Set<string>();
        for (const run of list.runs) {
          if (
            run.state === "running" ||
            run.state === "blocked" ||
            run.run_id === selectedRunId
          ) {
            needDetail.add(run.run_id);
          }
        }
        if (selectedRunId) needDetail.add(selectedRunId);

        const prior = detailsRef.current;
        const nextDetails = new Map<string, RunDetailResponse>();

        await Promise.all(
          [...needDetail].map(async (id) => {
            try {
              const detail = await client.getRun(id);
              if (!cancelled) nextDetails.set(id, detail);
            } catch {
              const kept = prior.get(id);
              if (kept) nextDetails.set(id, kept);
            }
          }),
        );
        if (!cancelled) setDetails(nextDetails);
      } catch {
        /* daemon blip — retry */
      }
      if (!cancelled) timer = setTimeout(() => void tick(), pollMs);
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [client, enabled, pollMs, selectedRunId]);

  // ── Selected-run deliverables only (#255 F1 / #262) ─────────────────────
  // Depend on a stable id key so a detail re-poll with the same ids does not
  // re-fire GET /deliverables/:id for every live tick.
  const selectedDetail = selectedRunId ? details.get(selectedRunId) : undefined;
  const selectedIdKey =
    selectedRunId && selectedDetail ? deliverableIdKey(selectedDetail) : "";

  useEffect(() => {
    if (!enabled || !selectedRunId) {
      setSelectedDlv({ runId: null, idKey: "", values: undefined });
      return;
    }
    if (!selectedDetail || selectedDetail.run.run_id !== selectedRunId) {
      // Detail not yet warm — stay not_fetched for this selection.
      setSelectedDlv({ runId: selectedRunId, idKey: "", values: undefined });
      return;
    }

    const idKey = selectedIdKey;
    const ids = idKey === "" ? [] : idKey.split("\0").filter(Boolean);

    // Already resolved for this run + id set — do not re-fetch.
    if (
      selectedDlv.runId === selectedRunId &&
      selectedDlv.idKey === idKey &&
      selectedDlv.values !== undefined
    ) {
      return;
    }

    // Mark in-flight so the inspector does not flash a stale prior run's cards.
    setSelectedDlv({ runId: selectedRunId, idKey, values: undefined });

    if (ids.length === 0) {
      setSelectedDlv({ runId: selectedRunId, idKey, values: [] });
      return;
    }

    let cancelled = false;
    void (async () => {
      const settled = await Promise.all(
        ids.map(async (id) => {
          try {
            return await client.getDeliverable(id);
          } catch {
            return null;
          }
        }),
      );
      if (cancelled) return;
      const values = settled.filter((v): v is DeliverableValue => v != null);
      setSelectedDlv({ runId: selectedRunId, idKey, values });
    })();

    return () => {
      cancelled = true;
    };
  }, [client, enabled, selectedRunId, selectedIdKey, selectedDetail]);

  const runs: RosterRun[] = useMemo(
    () =>
      summaries.map((summary) => {
        const detail = details.get(summary.run_id);
        const nodes: readonly NodeProjection[] | null = detail?.nodes ?? null;
        // Prefer detail's envelope track_bound when present (same projection).
        const enriched =
          detail?.run != null
            ? {
                ...summary,
                track_bound: detail.run.track_bound ?? summary.track_bound,
              }
            : summary;
        return projectRosterRun(enriched, nodes);
      }),
    [summaries, details],
  );

  return useMemo(
    () => ({
      runs,
      summaries,
      details: details.size === 0 ? EMPTY_DETAILS : details,
    }),
    [runs, summaries, details],
  );
}

/**
 * Project the selected run's detail into the inspector payload, including
 * deliverables fetched for that selection by {@link useRuns}.
 */
export function useInspectorRun(
  details: ReadonlyMap<string, RunDetailResponse>,
  selectedRunId: string | null,
  nowMs: number,
): InspectorRun | null {
  const dlv = useSyncExternalStore(
    subscribeSelectedDlv,
    getSelectedDlvSnapshot,
    getSelectedDlvSnapshot,
  );

  return useMemo(() => {
    if (!selectedRunId) return null;
    const detail = details.get(selectedRunId);
    if (!detail || detail.run.run_id !== selectedRunId) return null;
    // Only pass values when the cache is for this selection and resolved.
    const deliverableValues =
      dlv.runId === selectedRunId && dlv.values !== undefined
        ? dlv.values
        : undefined;
    return projectInspectorRun(detail, nowMs, deliverableValues);
  }, [details, selectedRunId, nowMs, dlv]);
}
