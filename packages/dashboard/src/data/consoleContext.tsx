/**
 * Shell-owned ParleyClient + shared snapshot/health/runs (#367).
 * Exactly one client construction site (Shell); screens consume via hooks.
 */
import { createContext, useContext, type ReactNode } from "react";
import type { ParleyClient } from "@useparley/core";
import type { HealthView, RunsView, SnapshotView } from "./types.js";
import type { FleetSummary } from "@useparley/core";
import type { StateFilterKey } from "../chrome/LeftRail.js";

export interface ConsoleData {
  client: ParleyClient;
  snapshot: SnapshotView;
  health: HealthView;
  runs: RunsView;
  fleet?: { session: string; state: StateFilterKey; summary: FleetSummary | null; summaryError?: string | null };
}

const ConsoleDataContext = createContext<ConsoleData | null>(null);

export function ConsoleDataProvider({
  value,
  children,
}: {
  value: ConsoleData;
  children: ReactNode;
}) {
  return (
    <ConsoleDataContext.Provider value={value}>{children}</ConsoleDataContext.Provider>
  );
}

export function useConsoleData(): ConsoleData {
  const ctx = useContext(ConsoleDataContext);
  if (!ctx) {
    throw new Error(
      "useConsoleData requires ConsoleDataProvider — the shell owns the single ParleyClient",
    );
  }
  return ctx;
}

export function useParleyClient(): ParleyClient {
  return useConsoleData().client;
}
