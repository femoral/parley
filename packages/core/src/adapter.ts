/**
 * Vendor adapter abstraction (ADR-0004, ADR-0009, spec §9). Adapters are
 * TypeScript modules; `SpawnPlan.files` absorbs the flags-vs-files asymmetry
 * between vendors. Event normalization is deliberately thin — raw JSONL is the
 * record.
 *
 * This is the public plugin contract: built-in and third-party adapters
 * implement {@link VendorAdapter}. See `docs/agents/adapter-authoring.md`.
 */
import type { ProbedModels, VendorModels } from "./models.js";

/**
 * Filesystem sandbox posture (ADR-0006 / #279). Normalized across vendors;
 * each adapter maps it to the vendor's own mechanism (codex flags, grok env).
 * Enforcement fidelity is declared on {@link VendorAdapter.enforcement} — the
 * flag surface is portable; real isolation is not.
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
 * How faithfully an adapter enforces one posture dimension (#279).
 *
 * - `enforced` — real OS/CLI mechanism (or intentional unrestricted `full`)
 * - `approximate` — soft affinity / best-effort lever (say which in `via`)
 * - `none` — flag accepted; nothing real happens
 * - `refused` — prepare throws rather than under-isolate (e.g. #107, #247 host probe)
 */
export type EnforcementLevel = "enforced" | "approximate" | "none" | "refused";

/** One cell of an adapter's posture-enforcement declaration. */
export interface EnforcementCell {
  level: EnforcementLevel;
  /**
   * Mechanism (`bubblewrap`, `--plan`, permission allowlist) or residual
   * explanation when the level is not a hard OS guarantee.
   */
  via?: string;
}

/**
 * Per-adapter declaration of what each posture request actually gets (#279).
 * Required on every {@link VendorAdapter} so a future adapter cannot skip it.
 * Dimensions: sandbox `read-only` / `workspace` / `full` and `network:false`.
 */
export interface AdapterEnforcement {
  "read-only": EnforcementCell;
  workspace: EnforcementCell;
  full: EnforcementCell;
  "network:false": EnforcementCell;
}

/** Dimensions of {@link AdapterEnforcement}, in matrix-column order. */
export const ENFORCEMENT_DIMENSIONS = [
  "read-only",
  "workspace",
  "full",
  "network:false",
] as const satisfies readonly (keyof AdapterEnforcement)[];

/** True when a posture request is accepted but not fully enforced. */
export function isWeakEnforcement(level: EnforcementLevel): boolean {
  return level === "approximate" || level === "none";
}

/** Compact cell text for docs / `parley info` (e.g. `approximate (--plan)`). */
export function formatEnforcementCell(cell: EnforcementCell): string {
  return cell.via ? `${cell.level} (${cell.via})` : cell.level;
}

/**
 * How a child is taught to reach the daemon (ADR-0011 / #155). Adapters declare
 * one; `vendors.<id>.childChannel` may override. The protocol preamble renders
 * exactly that channel's report/ask instructions — other transports stay
 * functional but untaught.
 */
export type ChildChannel = "mcp" | "cli" | "http";

/** The valid child channels, in the order docs advertise them. */
export const CHILD_CHANNELS: readonly ChildChannel[] = ["mcp", "cli", "http"];

/** True when `value` is one of the three child channels. */
export function isChildChannel(value: string): value is ChildChannel {
  return (CHILD_CHANNELS as readonly string[]).includes(value);
}

/**
 * The child's sandbox posture — the caller's normalized answer to "what may
 * this child touch" (ADR-0006 / #279). Delivered to adapters via `TaskSpec`;
 * vendor mapping and enforcement fidelity belong to each adapter's declaration.
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
  /** Opaque reasoning-effort string, passed through to the vendor unchanged. */
  effort: string | null;
  /** Working directory the child runs in (worktrees arrive in a later ticket). */
  cwd: string;
  /** Normalized sandbox posture (ADR-0006); adapters map it to vendor mechanisms. */
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
  /**
   * The parley worktree's private git directory (`git rev-parse
   * --absolute-git-dir`), when `cwd` is a parley-managed worktree. Always lives
   * outside `cwd` (under the source repo's common git dir) — adapters whose
   * sandbox mechanism scopes writes to `cwd` need this as an extra writable
   * root, or a plain `git commit` inside the worktree fails. Absent for
   * `--cwd`-bypassed tasks (no parley worktree to grant).
   */
  gitDir?: string;
  /**
   * The repo's *common* git directory (`git rev-parse --git-common-dir`,
   * resolved absolute), when `cwd` is a parley-managed worktree. This is where
   * `objects/` and `refs/` actually live — distinct from `gitDir` (the
   * worktree's private gitdir) and also required as a writable root, or
   * `git add`/`git commit` fails to write the object database even once
   * `gitDir` alone is granted. Absent for `--cwd`-bypassed tasks.
   */
  gitCommonDir?: string;
  /**
   * Extra argv flags from config (`vendors.<id>.args` then `profiles.<name>.args`).
   * Never undefined — default `[]`. Adapters MUST splice these into the flags
   * region of argv (after the subcommand head, before a positional prompt is
   * consumed ambiguously). Never append after the prompt; flag parsers that
   * stop at the first positional would swallow them as prompt text.
   */
  extraArgs: string[];
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
  /**
   * Spawn-time adapter diagnostics (#186) — `VENDOR_DIAG_PREFIX`-tagged lines
   * the engine appends to the task's `diag.log` before launch. For anomalies an
   * adapter detects while *preparing* the spawn (e.g. a preflight probe),
   * which have no stream event to ride on. Fail-open by contract: diagnostics
   * never block or fail the spawn.
   */
  diagnostics?: string[];
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
  /**
   * Vendor-reported model id on `session_meta` (#154). When present the engine
   * upgrades the task's model with `source=vendor`. Never invented by the
   * daemon — only recorded when the stream actually names one.
   */
  model?: string;
  /**
   * Vendor-reported reasoning effort on `session_meta` (#154). Same upgrade
   * rules as {@link model}.
   */
  effort?: string;
}

/**
 * Prefix adapters put on an `error` event's `text` to flag it as an
 * actionable, vendor-integration-level problem — e.g. a vendor's own
 * approval/guardian gate silently cancelling a `submit_report`/
 * `ask_orchestrator` call (headless children have no TTY to answer such
 * prompts). Non-fatal by nature (the agent may still recover the turn), so it
 * doesn't set `fatal`, but the engine tracks the most recent one per task and
 * surfaces it — tagged, so a human or the orchestrator can `grep` a task's
 * `diag.log` (or the failure `error` string) instead of re-reading the full
 * raw vendor stream to find why a task with no vendor-level fatal error still
 * never produced a report.
 */
export const VENDOR_DIAG_PREFIX = "PARLEY-DIAG";

/**
 * The operator's currently selected model in a vendor CLI (#284).
 *
 * Distinct from catalog discovery: at most one model (plus optional effort).
 * Never feeds `readModels()` / `models.json` — used only to pre-fill setup
 * allowlists and enrich allowlist rejections when the CLI selection is
 * outside the configured allowlist.
 */
export interface SelectedModel {
  model: string;
  /**
   * Reasoning effort the CLI has selected for this model, or `null` when the
   * reader does not surface one. goose/openhands return null here even when a
   * global effort may exist on disk — #284 surfaces model drift for those
   * vendors; cline returns the stored `reasoning.effort` when present.
   */
  effort: string | null;
}

/** A vendor integration: how to spawn it and how to read its event stream. */
export interface VendorAdapter {
  id: string;
  /**
   * Declared child→daemon channel this adapter sets up (ADR-0011 / #155).
   * The engine teaches exactly this channel in the protocol preamble unless
   * `vendors.<id>.childChannel` overrides it.
   */
  childChannel: ChildChannel;
  /**
   * Declared posture enforcement fidelity (#279). Required so every adapter
   * states honestly what `sandbox` / `network:false` requests actually get.
   * Sourced by `parley info`, the README matrix, and prepare-time diagnostics.
   */
  enforcement: AdapterEnforcement;
  /** Build the spawn plan for a fresh run. */
  prepare(task: TaskSpec, hub: HubInfo): Promise<SpawnPlan>;
  /** Build the spawn plan for resuming a stalled task (vendor session resume). */
  resume(task: TaskSpec, hub: HubInfo): Promise<SpawnPlan>;
  /** Normalize one raw stream line; unknown lines yield `[]` (opaque pass-through). */
  parseEvent(line: string): VendorEvent[];
  /** Extract the vendor session id from the events seen so far, if any. */
  sessionId(events: VendorEvent[]): string | undefined;
  /**
   * Optional on-disk discovery (#281): read the vendor's own config/state files
   * from the *operator* home (never a per-task isolated home). Same shape as
   * {@link listModels}. Must fail soft — absent/malformed/unexpected files
   * return empty models or reject; refresh never lets a bad file crash the
   * catalog. Precedence: `readModels` → `listModels` → shipped fallback, with
   * union / richest-wins merge across channels.
   *
   * Discovery stays advisory; spawn is gated by the vendor allowlist
   * (#185 / ADR-0014).
   */
  readModels?(existing: VendorModels | undefined): Promise<ProbedModels>;
  /**
   * Optional `parley models --refresh` probe: re-enumerate the vendor's models
   * by shelling out to its CLI. Receives the vendor's current catalog entry so a
   * text-only vendor (grok) can carry hand-patched efforts forward. Rejects (or
   * returns no models) when the probe is missing/unparseable — the catalog then
   * keeps the existing entry rather than clobbering manual patches with nothing.
   *
   * Model-catalog domain types (`ModelEntry`, `VendorModels`, `ProbedModels`, …)
   * live alongside this contract in `@useparley/core` — the catalog is advisory
   * for discovery; spawn is gated by the vendor allowlist (#185 / ADR-0014).
   */
  listModels?(existing: VendorModels | undefined): Promise<ProbedModels>;
  /**
   * Optional selected-model read (#284): the operator's currently configured
   * model in this vendor CLI (at most one). **Not a catalog channel** — never
   * feed this into `readModels` / `models.json`. Used to pre-fill setup
   * allowlists and enrich allowlist rejections.
   *
   * Sync by design: the allowlist choke point is synchronous. Fail soft always
   * — absent / malformed / unreadable means `null`, never throw.
   */
  readSelectedModel?(): SelectedModel | null;
}

/**
 * Prepare-time PARLEY-DIAG lines when the requested posture is only
 * approximate/none for this adapter (#279). Does not cover `refused` — those
 * hard-fail in prepare before spawn. Never throws; diagnostics never block.
 *
 * `sandbox: "full"` is structurally exempt from the sandbox-dimension
 * diagnostic: full requests *no* isolation, so it cannot be under-enforced
 * even if a declaration mis-labels the cell.
 */
export function formatPostureGapDiagnostics(
  adapterId: string,
  enforcement: AdapterEnforcement,
  posture: { sandbox: SandboxMode; network: boolean },
): string[] {
  const out: string[] = [];
  // full = unrestricted access requested; never warn on the sandbox axis.
  if (posture.sandbox !== "full") {
    const sand = enforcement[posture.sandbox];
    if (isWeakEnforcement(sand.level)) {
      const via = sand.via ? ` (${sand.via})` : "";
      out.push(
        `${VENDOR_DIAG_PREFIX} posture: ${adapterId} sandbox=${posture.sandbox} → ${sand.level}${via}; flag accepted but not fully enforced`,
      );
    }
  }
  if (!posture.network) {
    const net = enforcement["network:false"];
    if (isWeakEnforcement(net.level)) {
      const via = net.via ? ` (${net.via})` : "";
      out.push(
        `${VENDOR_DIAG_PREFIX} posture: ${adapterId} network=false → ${net.level}${via}; flag accepted but not fully enforced`,
      );
    }
  }
  return out;
}

/**
 * Merge posture-gap diagnostics into a {@link SpawnPlan} (prepare/resume).
 * Fail-open: never blocks spawn.
 */
export function mergePostureDiagnostics(
  adapterId: string,
  enforcement: AdapterEnforcement,
  task: { sandbox: SandboxMode; network: boolean },
  plan: SpawnPlan,
): SpawnPlan {
  const gaps = formatPostureGapDiagnostics(adapterId, enforcement, task);
  if (gaps.length === 0) return plan;
  return { ...plan, diagnostics: [...(plan.diagnostics ?? []), ...gaps] };
}

/**
 * Wrap prepare/resume so every spawn path emits posture-gap diagnostics (#279).
 * Prefer this (or {@link mergePostureDiagnostics}) over engine-side injection.
 */
export function withPostureDiagnostics(adapter: VendorAdapter): VendorAdapter {
  return {
    ...adapter,
    prepare(task, hub) {
      return Promise.resolve(adapter.prepare(task, hub)).then((plan) =>
        mergePostureDiagnostics(adapter.id, adapter.enforcement, task, plan),
      );
    },
    resume(task, hub) {
      return Promise.resolve(adapter.resume(task, hub)).then((plan) =>
        mergePostureDiagnostics(adapter.id, adapter.enforcement, task, plan),
      );
    },
  };
}
