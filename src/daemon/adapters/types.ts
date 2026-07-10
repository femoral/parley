/**
 * Vendor adapter abstraction (ADR-0004, spec §9). Adapters are TypeScript
 * modules; `SpawnPlan.files` absorbs the flags-vs-files asymmetry between
 * vendors. Event normalization is deliberately thin — raw JSONL is the record.
 */

/** What the daemon knows about a task when asking an adapter to spawn it. */
export interface TaskSpec {
  id: string;
  name: string | null;
  prompt: string;
  vendor: string;
  /** Opaque model string, passed through to the vendor unchanged. */
  model: string | null;
  /** Working directory the child runs in (worktrees arrive in a later ticket). */
  cwd: string;
  /** Persisted vendor session id — set when resuming a stalled task. */
  sessionId?: string;
}

/** How a child reaches back to the daemon: the MCP endpoint + correlation headers. */
export interface HubInfo {
  /** Streamable-HTTP MCP endpoint URL (daemon's localhost port). */
  url: string;
  /** Correlation headers the child must send on every MCP request. */
  headers: Record<string, string>;
}

/** A vendor-specific file written into the task's cwd before spawning. */
export interface MaterializedFile {
  /** Path relative to `SpawnPlan.cwd`. */
  path: string;
  contents: string;
}

/** Everything needed to spawn a vendor child process. */
export interface SpawnPlan {
  argv: string[];
  env: Record<string, string>;
  /** Vendor-specific files, written pre-spawn (e.g. grok's `.grok/config.toml`). */
  files: MaterializedFile[];
  cwd: string;
}

/**
 * Thin normalized vendor event — used only for status/logs display and
 * session-id/usage extraction. Unknown vendor lines normalize to nothing;
 * the raw JSONL log is the durable record.
 */
export interface VendorEvent {
  kind: "message" | "command" | "file_change" | "error" | "session_meta";
  text?: string;
  session_id?: string;
  usage?: Record<string, number>;
}

/** A vendor integration: how to spawn it and how to read its event stream. */
export interface VendorAdapter {
  id: string;
  /** Build the spawn plan for a fresh run. */
  prepare(task: TaskSpec, hub: HubInfo): Promise<SpawnPlan>;
  /** Build the spawn plan for resuming a stalled task (vendor session resume). */
  resume(task: TaskSpec, hub: HubInfo): Promise<SpawnPlan>;
  /** Normalize one raw stream line; unknown lines yield `[]` (opaque pass-through). */
  parseEvent(line: string): VendorEvent[];
  /** Extract the vendor session id from the events seen so far, if any. */
  sessionId(events: VendorEvent[]): string | undefined;
}
