/**
 * Test helper: wrap screens with a shell-owned ConsoleDataProvider.
 */
import type { ReactElement, ReactNode } from "react";
import type { ParleyClient } from "@useparley/core";
import {
  ConsoleDataProvider,
  type ConsoleData,
  type HealthView,
  type RunsView,
  type SnapshotView,
} from "../../src/data/index.js";

export const EMPTY_SNAPSHOT: SnapshotView = {
  tasks: [],
  seq: 0,
  connected: true,
  ready: true,
  streamLostSince: null,
  totalTasks: 0,
  activeTasks: 0,
};

export const EMPTY_HEALTH: HealthView = {
  status: "online",
  online: true,
  version: "test",
  pid: 1,
  startedAt: Date.now(),
  uptimeMs: 1000,
};

export const EMPTY_RUNS: RunsView = {
  summaries: [],
  details: new Map(),
  status: "online",
  error: null,
};

export function mockClient(partial: Partial<ParleyClient> = {}): ParleyClient {
  return {
    listSessions: async () => ({ sessions: [] }),
    ...partial,
  } as unknown as ParleyClient;
}

export function withConsoleData(
  children: ReactNode,
  overrides: Partial<ConsoleData> = {},
): ReactElement {
  const value: ConsoleData = {
    client: overrides.client ?? mockClient(),
    snapshot: overrides.snapshot ?? EMPTY_SNAPSHOT,
    health: overrides.health ?? EMPTY_HEALTH,
    runs: overrides.runs ?? EMPTY_RUNS,
  };
  return <ConsoleDataProvider value={value}>{children}</ConsoleDataProvider>;
}
