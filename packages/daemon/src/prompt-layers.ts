/**
 * Compounding PROMPT.md layers (#159 / #141) and run-step body composition
 * (ADR-0016 / #239).
 *
 * Mirrored trees under the daemon home (`~/.parley/`) and the project
 * (`.parley/`):
 *
 *   vendors/<id>/PROMPT.md
 *   profiles/<name>/PROMPT.md
 *   orchestrator/PROMPT.md
 *
 * Child prompts gain one "Operator instructions" section (home vendor →
 * project vendor → home profile → project profile). The orchestrator tree
 * compounds separately (home → project) and never reaches children.
 *
 * For a **run step**, the task *body* (after preamble + operator layers) is:
 *
 *   workflow prompt (opt-in `PROMPT.md` in the workflow dir)
 *   → node prompt
 *   → slot append
 *   → `## Orchestrator note`
 *   → `## Inputs`
 *
 * Deliberately absent: generated "you are node N of M", and a second
 * `## Deliverables` (the report-schema summary is the contract).
 *
 * Missing operator files skip silently; no per-layer headers. Read hot at
 * call time. Node/slot prompt paths are required when declared.
 */
import fs from "node:fs";
import path from "node:path";
import { PARLEY_DIR } from "./context.js";

/** Filename of each prompt layer. */
export const PROMPT_FILE = "PROMPT.md";

/**
 * Read a single PROMPT.md, returning trimmed non-empty contents or `null`
 * when the file is missing, unreadable, or empty after trim.
 */
export function readPromptFile(filePath: string): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

/** Absolute path of a vendor PROMPT.md under a config root. */
export function vendorPromptPath(root: string, vendorId: string): string {
  return path.join(root, "vendors", vendorId, PROMPT_FILE);
}

/** Absolute path of a profile PROMPT.md under a config root. */
export function profilePromptPath(root: string, profileName: string): string {
  return path.join(root, "profiles", profileName, PROMPT_FILE);
}

/** Absolute path of the orchestrator PROMPT.md under a config root. */
export function orchestratorPromptPath(root: string): string {
  return path.join(root, "orchestrator", PROMPT_FILE);
}

/**
 * Project config root: `<workspace>/.parley`. Returns null when no workspace
 * is known (skip project layers).
 */
export function projectPromptRoot(workspace: string | null | undefined): string | null {
  if (workspace === null || workspace === undefined || workspace === "") return null;
  return path.join(workspace, PARLEY_DIR);
}

/**
 * Concatenate existing layer bodies in order, blank-line separated.
 * Empty input → null (caller skips the whole Operator instructions section).
 */
export function joinPromptBodies(bodies: Array<string | null | undefined>): string | null {
  const parts: string[] = [];
  for (const body of bodies) {
    if (body !== null && body !== undefined && body !== "") parts.push(body);
  }
  if (parts.length === 0) return null;
  return parts.join("\n\n");
}

export interface OperatorLayersOptions {
  /** Daemon home directory (`~/.parley` or `PARLEY_HOME`). */
  homeDir: string;
  /**
   * Workspace root wherever the child runs (worktree or `--cwd`). Project
   * layers resolve under `<workspace>/.parley`. Null skips project layers.
   */
  projectDir: string | null;
  /** Vendor id for vendor layers. Null/empty skips vendor layers. */
  vendorId: string | null;
  /**
   * Profile name for profile layers. Null/empty skips profile layers
   * (profile layers only apply when the task was delegated with a profile).
   */
  profileName: string | null;
}

/**
 * Collect the four child layer bodies in composition order (missing skip):
 * home vendor → project vendor → home profile → project profile.
 */
export function collectOperatorLayerBodies(options: OperatorLayersOptions): string[] {
  const { homeDir, projectDir, vendorId, profileName } = options;
  const projectRoot = projectPromptRoot(projectDir);
  const bodies: string[] = [];

  if (vendorId !== null && vendorId !== "") {
    const homeVendor = readPromptFile(vendorPromptPath(homeDir, vendorId));
    if (homeVendor !== null) bodies.push(homeVendor);
    if (projectRoot !== null) {
      const projectVendor = readPromptFile(vendorPromptPath(projectRoot, vendorId));
      if (projectVendor !== null) bodies.push(projectVendor);
    }
  }

  if (profileName !== null && profileName !== "") {
    const homeProfile = readPromptFile(profilePromptPath(homeDir, profileName));
    if (homeProfile !== null) bodies.push(homeProfile);
    if (projectRoot !== null) {
      const projectProfile = readPromptFile(profilePromptPath(projectRoot, profileName));
      if (projectProfile !== null) bodies.push(projectProfile);
    }
  }

  return bodies;
}

/**
 * Build the full "Operator instructions" section for a child prompt, or null
 * when no layer files exist. Includes the section heading; no per-layer headers.
 */
export function composeOperatorInstructions(options: OperatorLayersOptions): string | null {
  const joined = joinPromptBodies(collectOperatorLayerBodies(options));
  if (joined === null) return null;
  return `## Operator instructions\n\n${joined}`;
}

export interface OrchestratorLayersOptions {
  homeDir: string;
  projectDir: string | null;
}

/**
 * Compound orchestrator PROMPT.md layers (home → project). Never injected into
 * children — exposed for `parley info` / `parley prompt --orchestrator`.
 * Returns concatenated bodies (no invented heading) or null when empty.
 */
export function composeOrchestratorInstructions(
  options: OrchestratorLayersOptions,
): string | null {
  const { homeDir, projectDir } = options;
  const projectRoot = projectPromptRoot(projectDir);
  const bodies: Array<string | null> = [
    readPromptFile(orchestratorPromptPath(homeDir)),
    projectRoot !== null ? readPromptFile(orchestratorPromptPath(projectRoot)) : null,
  ];
  return joinPromptBodies(bodies);
}

/**
 * Assemble a child vendor prompt: protocol preamble, optional operator
 * instructions section, then the body (caller brief or resume continuation).
 *
 * Shape when operator layers exist:
 *   <preamble>\n\n---\n\n## Operator instructions\n\n…\n\n---\n\n<body>
 *
 * When no operator layers exist, matches the pre-#159 shape:
 *   <preamble>\n\n---\n\n<body>
 */
export function assembleChildPrompt(
  preamble: string,
  operatorInstructions: string | null,
  body: string,
): string {
  const parts = [preamble];
  if (operatorInstructions !== null) {
    parts.push("", "---", "", operatorInstructions);
  }
  parts.push("", "---", "", body);
  return parts.join("\n");
}

/**
 * Preview shape for `parley prompt` (child mode): preamble plus optional
 * operator section — no brief (caller-supplied at delegate time).
 */
export function assemblePromptPreview(
  preamble: string,
  operatorInstructions: string | null,
): string {
  if (operatorInstructions === null) return preamble;
  return [preamble, "", "---", "", operatorInstructions].join("\n");
}

// ---------------------------------------------------------------------------
// Run-step body composition (ADR-0016 / #239)
// ---------------------------------------------------------------------------

/**
 * Opt-in workflow-level prompt file, relative to the workflow directory.
 * Missing ⇒ the layer is omitted entirely.
 */
export const WORKFLOW_PROMPT_FILE = "PROMPT.md";

/** Absolute path of the opt-in workflow `PROMPT.md`. */
export function workflowPromptPath(workflowDir: string): string {
  return path.join(workflowDir, WORKFLOW_PROMPT_FILE);
}

/**
 * Read the opt-in workflow prompt (`PROMPT.md` under the workflow dir), or
 * `null` when missing/empty.
 */
export function readWorkflowPrompt(workflowDir: string): string | null {
  return readPromptFile(workflowPromptPath(workflowDir));
}

/**
 * Read a path relative to a workflow directory (node `prompt` or slot
 * `prompt_append`). Returns trimmed non-empty body, or `null` when missing
 * or empty after trim.
 */
export function readWorkflowRelativePrompt(
  workflowDir: string,
  relativePath: string,
): string | null {
  if (relativePath === "") return null;
  // Reject absolute paths and `..` escape — prompts stay inside the workflow.
  if (path.isAbsolute(relativePath)) return null;
  const resolved = path.resolve(workflowDir, relativePath);
  const root = path.resolve(workflowDir);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return null;
  }
  return readPromptFile(resolved);
}

/**
 * Format the optional `## Orchestrator note` section (redirect / fork steer).
 * Returns `null` when the note is empty so the caller omits the layer.
 */
export function formatOrchestratorNote(note: string | null | undefined): string | null {
  if (note === null || note === undefined) return null;
  const trimmed = note.trim();
  if (trimmed === "") return null;
  return `## Orchestrator note\n\n${trimmed}`;
}

export interface ComposeStepBodyOptions {
  /** Absolute path of the workflow directory (for resolving prompt paths). */
  workflowDir: string;
  /**
   * Node prompt path relative to {@link workflowDir} (`step.prompt`). Required
   * for a step; missing/empty file throws so a bad definition fails loud.
   */
  nodePromptPath: string;
  /**
   * Slot `prompt_append` path relative to {@link workflowDir}, when the
   * sibling declares one. Missing file throws when a path is given.
   */
  slotAppendPath?: string | null;
  /**
   * Optional orchestrator note (redirect / fork). Untyped free text; omitted
   * entirely when null/empty.
   */
  orchestratorNote?: string | null;
  /**
   * Pre-rendered `## Inputs` section from {@link renderInputsSection}
   * (`deliverables.ts`). Pass `""` / null / undefined to omit.
   */
  inputsSection?: string | null;
  /**
   * Override the workflow-level prompt body. When `undefined`, reads opt-in
   * `PROMPT.md` from {@link workflowDir}. Pass `null` to force omit.
   */
  workflowPrompt?: string | null;
}

/**
 * Error when a declared node/slot prompt path cannot be read.
 */
export class PromptPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PromptPathError";
  }
}

function requireWorkflowRelativePrompt(
  workflowDir: string,
  relativePath: string,
  label: string,
): string {
  const body = readWorkflowRelativePrompt(workflowDir, relativePath);
  if (body === null) {
    throw new PromptPathError(
      `${label} prompt not found or empty: ${relativePath} (under ${workflowDir})`,
    );
  }
  return body;
}

/**
 * Compose the task **body** for a run step (ADR-0016):
 *
 *   workflow prompt (opt-in) → node prompt → slot append
 *   → `## Orchestrator note` → `## Inputs`
 *
 * Does **not** include the protocol preamble or Operator instructions — those
 * stay on {@link assembleChildPrompt}. Does **not** invent a node-position
 * banner or a `## Deliverables` section.
 *
 * @throws {PromptPathError} when a declared node/slot prompt path is missing
 */
export function composeStepBody(options: ComposeStepBodyOptions): string {
  const {
    workflowDir,
    nodePromptPath,
    slotAppendPath,
    orchestratorNote,
    inputsSection,
  } = options;

  const workflowBody =
    options.workflowPrompt !== undefined
      ? options.workflowPrompt === null || options.workflowPrompt === ""
        ? null
        : options.workflowPrompt.trim() === ""
          ? null
          : options.workflowPrompt.trim()
      : readWorkflowPrompt(workflowDir);

  const nodeBody = requireWorkflowRelativePrompt(
    workflowDir,
    nodePromptPath,
    "node",
  );

  let slotBody: string | null = null;
  if (slotAppendPath !== null && slotAppendPath !== undefined && slotAppendPath !== "") {
    slotBody = requireWorkflowRelativePrompt(workflowDir, slotAppendPath, "slot");
  }

  const noteSection = formatOrchestratorNote(orchestratorNote);
  const inputs =
    inputsSection !== null &&
    inputsSection !== undefined &&
    inputsSection.trim() !== ""
      ? inputsSection.trim()
      : null;

  // Preserve order; blank-line separate non-empty layers. No invented headers
  // on free-form prompt files (they carry their own structure).
  const parts: string[] = [];
  if (workflowBody !== null) parts.push(workflowBody);
  parts.push(nodeBody);
  if (slotBody !== null) parts.push(slotBody);
  if (noteSection !== null) parts.push(noteSection);
  if (inputs !== null) parts.push(inputs);
  return parts.join("\n\n");
}
