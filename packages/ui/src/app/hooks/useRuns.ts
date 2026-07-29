/**
 * Layer 4 (hooks) — poll the run query surface for the roster + inspector
 * (#254 / #255 / ADR-0021 / #241 / #262). Uses `ParleyClient.listRuns` /
 * `getRun` / `getDeliverable` only — no parallel fetch shape.
 *
 * Roster pips come from the list projection's bounded `track` slice (#262) —
 * no per-live-run detail fan-out. Detail is fetched only for the *selected*
 * run (inspector + deliverables).
 *
 * Deliverables (#255 F1): fetched only for the selected run when its detail
 * is available.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type {
  DeliverableValue,
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
  /** Detail cache keyed by run id (selected run only — inspector source). */
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
   * `undefined` — not yet resolved for this run/idKey (includes in-flight).
   * array — batch settled (empty = genuine none *only* when failedIds is empty).
   */
  values: DeliverableValue[] | undefined;
  /** Ids whose GET failed; non-empty means the surface must not claim absence. */
  failedIds: string[];
};

let selectedDlv: SelectedDlvCache = {
  runId: null,
  idKey: "",
  values: undefined,
  failedIds: [],
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
  selectedDlv = { runId: null, idKey: "", values: undefined, failedIds: [] };
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
 * Poll `GET /runs` for the roster; fetch `GET /runs/:ref` only for the
 * selected run (inspector). Live runs do not fan out detail fetches (#262).
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

        // Detail only for the selected run — roster pips use list `track` (#262).
        if (selectedRunId) {
          const prior = detailsRef.current;
          try {
            const detail = await client.getRun(selectedRunId);
            if (!cancelled) {
              setDetails(new Map([[selectedRunId, detail]]));
            }
          } catch {
            const kept = prior.get(selectedRunId);
            if (!cancelled) {
              setDetails(kept ? new Map([[selectedRunId, kept]]) : new Map());
            }
          }
        } else if (!cancelled) {
          setDetails(new Map());
        }
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
  // Depend on a stable id key + a boolean "detail ready" flag — not the
  // detail object identity. A poll tick that replaces `details` with a fresh
  // object of the *same* id set must not cancel an in-flight batch (livelock
  // when the batch is slower than pollMs).
  const selectedDetail = selectedRunId ? details.get(selectedRunId) : undefined;
  const selectedDetailReady = Boolean(
    selectedRunId &&
      selectedDetail &&
      selectedDetail.run.run_id === selectedRunId,
  );
  const selectedIdKey = selectedDetailReady
    ? deliverableIdKey(selectedDetail!)
    : "";

  useEffect(() => {
    if (!enabled || !selectedRunId) {
      setSelectedDlv({
        runId: null,
        idKey: "",
        values: undefined,
        failedIds: [],
      });
      return;
    }
    if (!selectedDetailReady) {
      // Detail not yet warm — stay not_fetched for this selection.
      setSelectedDlv({
        runId: selectedRunId,
        idKey: "",
        values: undefined,
        failedIds: [],
      });
      return;
    }

    const idKey = selectedIdKey;
    const ids = idKey === "" ? [] : idKey.split("\0").filter(Boolean);

    // Already resolved for this run + id set — do not re-fetch.
    // In-flight batches are protected by depending on `selectedIdKey` and
    // `selectedDetailReady` (not detail object identity), so a poll tick with
    // the same ids does not re-enter this effect and cancel the batch.
    if (
      selectedDlv.runId === selectedRunId &&
      selectedDlv.idKey === idKey &&
      selectedDlv.values !== undefined
    ) {
      return;
    }

    // Mark in-flight so the inspector does not flash a stale prior run's cards.
    setSelectedDlv({
      runId: selectedRunId,
      idKey,
      values: undefined,
      failedIds: [],
    });

    if (ids.length === 0) {
      setSelectedDlv({
        runId: selectedRunId,
        idKey,
        values: [],
        failedIds: [],
      });
      return;
    }

    let cancelled = false;
    void (async () => {
      const settled = await Promise.all(
        ids.map(async (id) => {
          try {
            const value = await client.getDeliverable(id);
            return { id, value };
          } catch {
            return { id, value: null as DeliverableValue | null };
          }
        }),
      );
      if (cancelled) return;
      const values: DeliverableValue[] = [];
      const failedIds: string[] = [];
      for (const row of settled) {
        if (row.value != null) values.push(row.value);
        else failedIds.push(row.id);
      }
      // Never collapse failures into []. A full-batch failure is error, not none.
      setSelectedDlv({ runId: selectedRunId, idKey, values, failedIds });
    })();

    return () => {
      cancelled = true;
    };
  }, [client, enabled, selectedRunId, selectedIdKey, selectedDetailReady]);

  // Roster rows from the list envelope alone — `track` paints the pip track
  // without waiting on (or issuing) a detail fetch (#262).
  const runs: RosterRun[] = useMemo(
    () => summaries.map((summary) => projectRosterRun(summary)),
    [summaries],
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
    const resolved =
      dlv.runId === selectedRunId && dlv.values !== undefined;
    const deliverableValues = resolved ? dlv.values : undefined;
    const failedCount = resolved ? dlv.failedIds.length : 0;
    return projectInspectorRun(detail, nowMs, deliverableValues, failedCount);
  }, [details, selectedRunId, nowMs, dlv]);
}
