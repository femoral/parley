import { useCallback, useEffect, useRef, useState } from "react";
import type { FleetPage, FleetPageOptions, ParleyClient, RunSummary, TaskEnvelope, FleetSummary } from "@useparley/core";
import { usePolling } from "./usePolling.js";

export function useFleetPage<K extends "tasks" | "runs">(client: ParleyClient, kind: K, options: FleetPageOptions = {}, enabled = true) {
  type Item = K extends "tasks" ? TaskEnvelope : RunSummary;
  const scope = JSON.stringify(options);
  const [navigation, setNavigation] = useState<{ scope: string; cursors: (string | undefined)[] }>({ scope, cursors: [undefined] });
  useEffect(() => { setNavigation({ scope, cursors: [undefined] }); }, [scope]);
  const cursors = navigation.scope === scope ? navigation.cursors : [undefined];
  const cursor = cursors.at(-1);
  const key = `${scope}:${cursor ?? ""}`;
  const keyRef = useRef(key);
  keyRef.current = key;
  const request = useRef(0);
  const [result, setResult] = useState<{ key: string; page: FleetPage<Item> } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [pending, setPending] = useState<string | null>(key);
  const tick = useCallback(async () => {
    const generation = ++request.current;
    setPending(key);
    try {
      const page = await client.fleetPage(kind, { ...JSON.parse(scope), cursor });
      if (keyRef.current !== key || request.current !== generation) return;
      setResult({ key, page });
      setFailure(null);
    } catch (error) {
      if (keyRef.current === key && request.current === generation) setFailure({ key, message: error instanceof Error ? error.message : "Page could not load" });
    } finally {
      if (keyRef.current === key && request.current === generation) setPending(null);
    }
  }, [client, kind, scope, cursor, key]);
  usePolling(tick, { intervalMs: 3000, resetKey: key, enabled });
  const page = result?.key === key ? result.page : null;
  return {
    items: page?.items ?? [], total: page?.total ?? null,
    number: cursors.length, loading: pending === key || (!page && failure?.key !== key),
    error: failure?.key === key ? failure.message : null,
    hasPrevious: cursors.length > 1, hasNext: !!page?.next_cursor,
    next: () => { if (page?.next_cursor) setNavigation({ scope, cursors: [...cursors, page.next_cursor] }); },
    previous: () => setNavigation({ scope, cursors: cursors.slice(0, -1).length ? cursors.slice(0, -1) : [undefined] }),
    newest: () => { setNavigation({ scope, cursors: [undefined] }); if (!cursor) void tick(); },
    refresh: tick,
  };
}

export function useFleetSummary(client: ParleyClient, session: string) {
  const current = useRef(session);
  current.current = session;
  const [result, setResult] = useState<{ session: string; data: FleetSummary } | null>(null);
  const [error, setError] = useState<{ session: string; message: string } | null>(null);
  const generation = useRef(0);
  const tick = useCallback(async () => {
    const request = ++generation.current;
    try {
      const data = await client.fleetSummary(session);
      if (current.current === session && generation.current === request) { setResult({ session, data }); setError(null); }
    } catch {
      if (current.current === session && generation.current === request) setError({ session, message: "Scope totals unavailable; retrying" });
    }
  }, [client, session]);
  usePolling(tick, { intervalMs: 3000, resetKey: session });
  return { summary: result?.session === session ? result.data : null, summaryError: error?.session === session ? error.message : null };
}
