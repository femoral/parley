/**
 * Compounding PROMPT.md layers (#159 / #141).
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
 * Missing files skip silently; no per-layer headers. Read hot at call time.
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
