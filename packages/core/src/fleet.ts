/** Bounded Console read model. Legacy complete-snapshot consumers are unchanged. */
export interface FleetPageOptions {
  session?: string;
  state?: string;
  run?: string;
  cursor?: string;
  limit?: number;
  attention?: boolean;
}

export interface FleetPage<T> {
  items: T[];
  total: number;
  next_cursor: string | null;
  seq: number;
}

export interface FleetSummary {
  tasks: Record<string, number>;
  runs: Record<string, number>;
  task_total: number;
  run_total: number;
  attention: number;
  held: number;
  settled: { completed: number; failed: number };
  fresh_failed: number;
  p95_ms: number | null;
  burn: {
    buckets: { hourStartMs: number; input: number; output: number; cached: number; tasks: number }[];
    totals: { input: number; output: number; cached: number; tasks: number };
    retentionDays: number;
    retentionSource: "default-assumed";
    windowMs: number;
    asOfMs: number;
  };
}
