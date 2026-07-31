/**
 * Run-start preflight and per-step execution config (ADR-0016 / #239).
 *
 * Callable units only — the run engine (#237) decides *when* to invoke them
 * and must not live in this file. Ownership lane: keep out of `engine.ts`
 * and do not create `run-engine.ts`.
 *
 * ## Per-step execution config
 *
 * One more optional layer on the chain `delegate` already has:
 * explicit → profile → `defaults.profile` → `defaults.vendor` → allowlist
 * default. Never a role indirection, never `task_type`.
 *
 * Slot config merges **field-wise** except `profile`, which **replaces
 * wholesale** (a named bundle cannot half-merge). Overridable set includes
 * `sandbox`.
 *
 * ## Run-start preflight
 *
 * Resolve every (node, slot) against the ADR-0014 allowlist **before node 1
 * spawns**, returning the resolved table and the concurrency caps the run
 * will contend for. Prints and **never refuses on throughput** — a cap is
 * not correctness and config is hot-read; the spawn-time check stays.
 * Allowlist / unknown-profile / workspace-mode failures still refuse.
 *
 * A fork re-preflights (caller invokes this again on the new run).
 */
import {
  DEFAULT_NETWORK,
  DEFAULT_SANDBOX,
  ModelAllowlistError,
  formatCliSelectedHint,
  isSandboxMode,
  listAllowedCombos,
  profileHasLaunchTemplate,
  resolveAllowedCombo,
  type ParleyConfig,
  type ProfileConfig,
  type SandboxMode,
  type SelectedModel,
  type WorkflowDefinition,
  type WorkflowSlot,
  type WorkflowStepNode,
  type WorkspaceMode,
} from "@useparley/core";
import {
  preflightRepoRun,
  preflightScratchRun,
} from "./run-workspace.js";

// ---------------------------------------------------------------------------
// Step + slot merge
// ---------------------------------------------------------------------------

/** Authored fields after step/slot merge, before profile + defaults. */
export interface MergedStepAuthored {
  profile: string | null;
  vendor: string | null;
  model: string | null;
  effort: string | null;
  sandbox: string | null;
  /** Slot `prompt_append` path, or null when no slot / no append. */
  promptAppend: string | null;
}

/**
 * Merge step-level and optional slot-level execution fields (ADR-0016).
 *
 * Field-wise for vendor / model / effort / sandbox (slot wins when set).
 * `profile` **replaces wholesale** when the slot names one — the step's
 * profile is discarded so a named bundle cannot half-merge with another.
 */
export function mergeStepAndSlot(
  step: WorkflowStepNode,
  slot?: WorkflowSlot | null,
): MergedStepAuthored {
  if (slot === null || slot === undefined) {
    return {
      profile: step.profile ?? null,
      vendor: step.vendor ?? null,
      model: step.model ?? null,
      effort: step.effort ?? null,
      sandbox: step.sandbox ?? null,
      promptAppend: null,
    };
  }

  const promptAppend =
    slot.prompt_append !== undefined && slot.prompt_append !== ""
      ? slot.prompt_append
      : null;

  if (slot.profile !== undefined) {
    // Wholesale profile replace: new profile name from slot only. Other
    // fields still field-merge (slot wins over step when set).
    return {
      profile: slot.profile === "" ? null : slot.profile,
      vendor: slot.vendor ?? step.vendor ?? null,
      model: slot.model ?? step.model ?? null,
      effort: slot.effort ?? step.effort ?? null,
      sandbox: slot.sandbox ?? step.sandbox ?? null,
      promptAppend,
    };
  }

  return {
    profile: step.profile ?? null,
    vendor: slot.vendor ?? step.vendor ?? null,
    model: slot.model ?? step.model ?? null,
    effort: slot.effort ?? step.effort ?? null,
    sandbox: slot.sandbox ?? step.sandbox ?? null,
    promptAppend,
  };
}

// ---------------------------------------------------------------------------
// Resolve one (node, slot) against config + allowlist
// ---------------------------------------------------------------------------

/** Successful resolution of vendor/model/effort/posture for one spawn. */
export interface ResolvedStepExecution {
  nodeId: string;
  /** Slot id, or `null` when the step has no authored slots. */
  slotId: string | null;
  profile: string | null;
  vendor: string;
  model: string | null;
  effort: string | null;
  sandbox: SandboxMode;
  network: boolean;
  /** True when the resolved profile carries a launch template (ADR-0015). */
  launchTemplate: boolean;
  /**
   * True when the allowlist default filled a fully omitted model+effort
   * (adapter paths only; false for launch-template profiles).
   */
  usedAllowlistDefault: boolean;
  /** Slot `prompt_append` path after merge, if any. */
  promptAppend: string | null;
}

/** Failure to resolve step/slot execution config (maps to blocked run start). */
export class StepConfigError extends Error {
  readonly code:
    | "missing_selection"
    | "unknown_profile"
    | "missing_vendor"
    | "invalid_sandbox"
    | "allowlist";

  constructor(code: StepConfigError["code"], message: string) {
    super(message);
    this.name = "StepConfigError";
    this.code = code;
  }
}

export interface ResolveStepExecutionOptions {
  step: WorkflowStepNode;
  /** Slot body when resolving an authored fan-out sibling. */
  slot?: WorkflowSlot | null;
  /** Slot id for the table row (null when the step has no slots). */
  slotId?: string | null;
  config: ParleyConfig;
  /** Path shown in allowlist remedy text. */
  configPath: string;
  /**
   * Optional lookup for the operator CLI's selected model (#284). Advisory
   * for allowlist rejection text only — invoked **lazily on `not_allowed`**,
   * never on the success path. Callers that omit it get the pre-#284
   * rejection shape (no advisory line). Engine wires this for run/workflow
   * spawn so the drift guard is not dead plumbing.
   */
  readSelectedModel?: (vendor: string) => SelectedModel | null;
}

/**
 * Resolve one (node, slot) through the delegate chain plus the step layer:
 * explicit (merged step/slot) → profile → `defaults.profile` →
 * `defaults.vendor` → allowlist default. Never uses `task_type` or a role map.
 *
 * Launch-template profiles skip the allowlist and keep declared provenance
 * (ADR-0015), matching `delegate`.
 */
export function resolveStepExecution(
  options: ResolveStepExecutionOptions,
): ResolvedStepExecution {
  const { step, config, configPath } = options;
  const slot = options.slot;
  const slotId = options.slotId ?? null;
  const merged = mergeStepAndSlot(step, slot);

  let profile = emptyToNull(merged.profile);
  let vendorReq = emptyToNull(merged.vendor);
  const usedDefaults = profile === null && vendorReq === null;

  if (usedDefaults) {
    const defProfile = config.defaults?.profile;
    const defVendor = config.defaults?.vendor;
    if (typeof defProfile === "string" && defProfile !== "") {
      profile = defProfile;
    } else if (typeof defVendor === "string" && defVendor !== "") {
      vendorReq = defVendor;
    } else {
      throw new StepConfigError(
        "missing_selection",
        `node "${step.id}"${slotLabel(slotId)}: vendor or profile is required ` +
          `(set on the step/slot, or set defaults.vendor / defaults.profile in config)`,
      );
    }
  }

  let profileCfg: ProfileConfig | undefined;
  if (profile !== null) {
    profileCfg = config.profiles?.[profile];
    if (profileCfg === undefined) {
      const known = Object.keys(config.profiles ?? {});
      const list = known.length > 0 ? known.join(", ") : "(none)";
      const via = usedDefaults ? " from defaults.profile" : "";
      throw new StepConfigError(
        "unknown_profile",
        `node "${step.id}"${slotLabel(slotId)}: unknown profile${via}: ${profile} (known: ${list})`,
      );
    }
  }

  const vendor = vendorReq ?? profileCfg?.vendor ?? null;
  if (vendor === null || vendor === "") {
    throw new StepConfigError(
      "missing_vendor",
      `node "${step.id}"${slotLabel(slotId)}: vendor is required (or set via profile)`,
    );
  }

  const launchTemplate = profileHasLaunchTemplate(profileCfg);
  const model = emptyToNull(merged.model) ?? emptyToNull(profileCfg?.model ?? null);
  const effort = emptyToNull(merged.effort) ?? emptyToNull(profileCfg?.effort ?? null);

  const sandboxRaw =
    emptyToNull(merged.sandbox) ?? profileCfg?.sandbox ?? DEFAULT_SANDBOX;
  if (typeof sandboxRaw !== "string" || !isSandboxMode(sandboxRaw)) {
    throw new StepConfigError(
      "invalid_sandbox",
      `node "${step.id}"${slotLabel(slotId)}: invalid sandbox ${JSON.stringify(sandboxRaw)} ` +
        `(expected read-only | workspace | full)`,
    );
  }
  const sandbox: SandboxMode = sandboxRaw;
  const network = profileCfg?.network ?? DEFAULT_NETWORK;

  let resolvedModel = model;
  let resolvedEffort = effort;
  let usedAllowlistDefault = false;

  if (!launchTemplate) {
    try {
      const allowed = resolveAllowedCombo({
        vendor,
        vendorCfg: config.vendors?.[vendor],
        model,
        effort,
        configPath,
      });
      resolvedModel = allowed.model;
      resolvedEffort = allowed.effort;
      usedAllowlistDefault = allowed.usedDefault;
    } catch (err) {
      if (err instanceof ModelAllowlistError) {
        let message = err.message;
        // Lazy disk read — only when already rejecting (same as engine path).
        if (err.code === "not_allowed" && options.readSelectedModel) {
          let cliSelected: SelectedModel | null = null;
          try {
            cliSelected = options.readSelectedModel(vendor);
          } catch {
            cliSelected = null;
          }
          message += formatCliSelectedHint(
            cliSelected,
            listAllowedCombos(config.vendors?.[vendor]),
          );
        }
        throw new StepConfigError(
          "allowlist",
          `node "${step.id}"${slotLabel(slotId)}: ${message}`,
        );
      }
      throw err;
    }
  }

  return {
    nodeId: step.id,
    slotId,
    profile,
    vendor,
    model: resolvedModel,
    effort: resolvedEffort,
    sandbox,
    network,
    launchTemplate,
    usedAllowlistDefault,
    promptAppend: merged.promptAppend,
  };
}

function emptyToNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  return value;
}

function slotLabel(slotId: string | null): string {
  return slotId === null ? "" : ` slot "${slotId}"`;
}

// ---------------------------------------------------------------------------
// Run-start preflight
// ---------------------------------------------------------------------------

/** One resolved (node, slot) row in the preflight table. */
export interface PreflightSlotRow {
  nodeId: string;
  slotId: string | null;
  vendor: string;
  profile: string | null;
  model: string | null;
  effort: string | null;
  sandbox: SandboxMode;
  launchTemplate: boolean;
  /** Vendor `maxConcurrent`, or null when uncapped. */
  vendorMaxConcurrent: number | null;
  /** Profile `maxConcurrent`, or null when no profile / uncapped. */
  profileMaxConcurrent: number | null;
}

/** A concurrency cap the run will contend for (print-only at start). */
export interface PreflightCap {
  kind: "vendor" | "profile";
  id: string;
  maxConcurrent: number;
}

export interface RunPreflightResult {
  workspace: WorkspaceMode;
  rows: PreflightSlotRow[];
  /** Unique caps among resolved rows (throughput — never a refuse reason). */
  caps: PreflightCap[];
}

export interface PreflightRunStartOptions {
  definition: WorkflowDefinition;
  config: ParleyConfig;
  configPath: string;
  /**
   * Git repo root for `workspace: repo` preflight. Null/undefined fails that
   * mode (via {@link preflightRepoRun}).
   */
  repoRoot?: string | null;
  /**
   * `--base` / baseRef. Forbidden on `workspace: scratch`
   * (via {@link preflightScratchRun}).
   */
  baseRef?: string | null;
}

/**
 * Run-start preflight (ADR-0016 + ADR-0018):
 *
 * 1. Workspace-mode checks (`preflightScratchRun` / `preflightRepoRun`).
 * 2. Resolve every step (and each authored slot) against the allowlist.
 * 3. Collect the concurrency caps those rows will contend for.
 *
 * Throws on workspace or resolution failures. **Never** throws because a
 * `maxConcurrent` cap would queue work — that stays a spawn-time concern.
 *
 * Gates are skipped (they spawn nothing). Data fan-out steps resolve once
 * (siblings share config; width is not known until inputs materialize).
 */
export function preflightRunStart(
  options: PreflightRunStartOptions,
): RunPreflightResult {
  const { definition, config, configPath } = options;

  if (definition.workspace === "scratch") {
    preflightScratchRun({ baseRef: options.baseRef });
  } else {
    preflightRepoRun({ repoRoot: options.repoRoot });
  }

  const rows: PreflightSlotRow[] = [];

  for (const node of definition.nodes) {
    if (node.kind !== "step") continue;

    const slots = node.slots;
    if (slots !== undefined && Object.keys(slots).length > 0) {
      for (const [slotId, slot] of Object.entries(slots)) {
        const resolved = resolveStepExecution({
          step: node,
          slot,
          slotId,
          config,
          configPath,
        });
        rows.push(toPreflightRow(resolved, config));
      }
    } else {
      const resolved = resolveStepExecution({
        step: node,
        slot: null,
        slotId: null,
        config,
        configPath,
      });
      rows.push(toPreflightRow(resolved, config));
    }
  }

  return {
    workspace: definition.workspace,
    rows,
    caps: collectCaps(rows),
  };
}

function toPreflightRow(
  resolved: ResolvedStepExecution,
  config: ParleyConfig,
): PreflightSlotRow {
  const vendorMax = config.vendors?.[resolved.vendor]?.maxConcurrent;
  const profileMax =
    resolved.profile !== null
      ? config.profiles?.[resolved.profile]?.maxConcurrent
      : undefined;
  return {
    nodeId: resolved.nodeId,
    slotId: resolved.slotId,
    vendor: resolved.vendor,
    profile: resolved.profile,
    model: resolved.model,
    effort: resolved.effort,
    sandbox: resolved.sandbox,
    launchTemplate: resolved.launchTemplate,
    vendorMaxConcurrent:
      typeof vendorMax === "number" ? vendorMax : null,
    profileMaxConcurrent:
      typeof profileMax === "number" ? profileMax : null,
  };
}

function collectCaps(rows: readonly PreflightSlotRow[]): PreflightCap[] {
  const seenVendor = new Set<string>();
  const seenProfile = new Set<string>();
  const caps: PreflightCap[] = [];
  for (const row of rows) {
    if (
      row.vendorMaxConcurrent !== null &&
      !seenVendor.has(row.vendor)
    ) {
      seenVendor.add(row.vendor);
      caps.push({
        kind: "vendor",
        id: row.vendor,
        maxConcurrent: row.vendorMaxConcurrent,
      });
    }
    if (
      row.profile !== null &&
      row.profileMaxConcurrent !== null &&
      !seenProfile.has(row.profile)
    ) {
      seenProfile.add(row.profile);
      caps.push({
        kind: "profile",
        id: row.profile,
        maxConcurrent: row.profileMaxConcurrent,
      });
    }
  }
  return caps;
}

/**
 * Human-readable preflight table + caps (for run-start logging / CLI).
 * Never empty of the header — a workflow of only gates still shows that.
 */
export function formatRunPreflight(result: RunPreflightResult): string {
  const lines: string[] = [
    `run preflight (workspace: ${result.workspace}):`,
    "  resolved (node, slot) → vendor / profile / model@effort / sandbox",
  ];

  if (result.rows.length === 0) {
    lines.push("  (no steps — gates only)");
  } else {
    for (const row of result.rows) {
      const slot = row.slotId === null ? "—" : row.slotId;
      const profile = row.profile === null ? "—" : row.profile;
      const combo = formatCombo(row.model, row.effort);
      const lt = row.launchTemplate ? " [launch-template]" : "";
      lines.push(
        `  ${row.nodeId} / ${slot}  →  ${row.vendor} / ${profile} / ${combo} / ${row.sandbox}${lt}`,
      );
    }
  }

  lines.push("  concurrency caps this run will contend for:");
  if (result.caps.length === 0) {
    lines.push("  (none configured — uncapped vendors/profiles)");
  } else {
    for (const cap of result.caps) {
      lines.push(`  ${cap.kind} ${cap.id}: maxConcurrent=${cap.maxConcurrent}`);
    }
  }

  return lines.join("\n");
}

function formatCombo(model: string | null, effort: string | null): string {
  if (model === null || model === "") {
    return effort === null || effort === "" ? "—" : `—@${effort}`;
  }
  if (effort === null || effort === "") return model;
  return `${model}@${effort}`;
}
