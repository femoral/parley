/**
 * Layer 4 (hooks) — poll the run query surface for the roster + inspector
 * (#254 / ADR-0021 / #241). Uses `ParleyClient.listRuns` / `getRun` only —
 * no parallel fetch shape.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type {
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

/** Project the selected run's detail into the inspector payload. */
export function useInspectorRun(
  details: ReadonlyMap<string, RunDetailResponse>,
  selectedRunId: string | null,
  nowMs: number,
): InspectorRun | null {
  return useMemo(() => {
    if (!selectedRunId) return null;
    const detail = details.get(selectedRunId);
    if (!detail || detail.run.run_id !== selectedRunId) return null;
    return projectInspectorRun(detail, nowMs);
  }, [details, selectedRunId, nowMs]);
}
