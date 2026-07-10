/**
 * Vendor adapter abstraction (ADR-0004, spec §9). Adapters are TypeScript
 * modules; `SpawnPlan.files` absorbs the flags-vs-files asymmetry between
 * vendors. Event normalization is deliberately thin — raw JSONL is the record.
 */

/**
 * Filesystem sandbox posture (spec §8, ADR-0006). Normalized across vendors;
 * each adapter maps it to the vendor's own mechanism (codex flags, grok env).
 */
export type SandboxMode = "read-only" | "workspace" | "full";

/** The valid `--sandbox` values, in the order the CLI advertises them. */
export const SANDBOX_MODES: readonly SandboxMode[] = ["read-only", "workspace", "full"];

/** ADR-0006 defaults: write access to the worktree, network on. */
export const DEFAULT_SANDBOX: SandboxMode = "workspace";
export const DEFAULT_NETWORK = true;

/** True when `value` is one of the three normalized sandbox modes. */
export function isSandboxMode(value: string): value is SandboxMode {
  return (SANDBOX_MODES as readonly string[]).includes(value);
}

/**
 * The child's sandbox posture — the caller's normalized answer to "what may
 * this child touch" (spec §8). Delivered to adapters via `TaskSpec`; vendor
 * mapping (ADR-0006 matrix) belongs to each adapter.
 */
export interface Posture {
  sandbox: SandboxMode;
  /** Whether the child may reach the network (ADR-0006 default: on). */
  network: boolean;
}

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
  /** Normalized sandbox posture (spec §8); adapters map it to vendor mechanisms. */
  sandbox: SandboxMode;
  /** Whether the child may reach the network (ADR-0006 default: on). */
  network: boolean;
  /**
   * The task's `--answer-timeout` in ms (the daemon default when unset). Adapters
   * that route `ask_orchestrator` through the vendor's MCP client must raise the
   * vendor's per-tool timeout above this, or a blocking question is killed before
   * the orchestrator can answer (codex's `tool_timeout_sec` defaults to 60s).
   */
  answerTimeoutMs: number;
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
  /**
   * On `error` events: true when the vendor reported a run-terminal failure
   * (codex `turn.failed` / top-level `error`), as opposed to a recoverable
   * mid-run error item the agent may work past. Only fatal errors are surfaced
   * as task failure detail — vendor exit codes are often opaque (codex: 0/1).
   */
  fatal?: boolean;
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
