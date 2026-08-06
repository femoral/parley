/**
 * Fetch full deliverable values for a run's deliverable refs.
 * Honesty: each id independently → ready / error / purged / missing-worktree.
 */
import { useEffect, useMemo, useState } from "react";
import type { DeliverableRef, DeliverableValue, ParleyClient } from "@useparley/core";
import {
  projectDeliverableRow,
  projectDeliverablesPanelState,
  type DeliverableRow,
} from "./deliverables.js";

export function useDeliverableValues(
  client: ParleyClient,
  refs: readonly DeliverableRef[],
  options: { enabled?: boolean } = {},
): {
  rows: DeliverableRow[];
  loading: boolean;
  panelLabel: string;
  panelStatus: string;
} {
  const enabled = options.enabled !== false;
  const idsKey = refs.map((r) => r.deliverable_id).join("|");
  const [values, setValues] = useState<Map<string, DeliverableValue | null>>(() => new Map());
  const [errors, setErrors] = useState<Map<string, string>>(() => new Map());
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled || refs.length === 0) {
      setValues(new Map());
      setErrors(new Map());
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const nextVals = new Map<string, DeliverableValue | null>();
    const nextErrs = new Map<string, string>();

    void Promise.all(
      refs.map(async (ref) => {
        try {
          const v = await client.getDeliverable(ref.deliverable_id);
          if (!cancelled) nextVals.set(ref.deliverable_id, v);
        } catch (err) {
          if (!cancelled) {
            nextErrs.set(
              ref.deliverable_id,
              err instanceof Error ? err.message : "deliverable fetch failed",
            );
            nextVals.set(ref.deliverable_id, null);
          }
        }
      }),
    ).then(() => {
      if (cancelled) return;
      setValues(nextVals);
      setErrors(nextErrs);
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
    // idsKey captures ref identity; refs array may be new each render.
  }, [client, enabled, idsKey]);

  const rows = useMemo(() => {
    return refs.map((ref) => {
      const err = errors.get(ref.deliverable_id) ?? null;
      const has = values.has(ref.deliverable_id);
      const val = has ? values.get(ref.deliverable_id) : undefined;
      return projectDeliverableRow(ref, val, err);
    });
  }, [refs, values, errors]);

  const panel = projectDeliverablesPanelState({
    refs,
    rows,
    loading,
    listError: null,
  });

  return {
    rows,
    loading,
    panelLabel: panel.label,
    panelStatus: panel.status,
  };
}
