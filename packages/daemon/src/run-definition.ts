/**
 * Run definition snapshot (#381 / ADR-0017).
 *
 * Captured once at `run start` from the *client's* cwd: the parsed workflow
 * plus every prompt body it references (workflow-level `PROMPT.md`, each
 * step's node prompt, each authored slot's `prompt_append`). Advance, status,
 * output-port resolution, retention, and spawn all read this snapshot — the
 * daemon never touches the authoring filesystem again for the life of the run.
 *
 * A fork copies the parent's row verbatim.
 */

import type { WorkflowDefinition, WorkflowStepNode } from "@useparley/core";
import {
  getRunDefinitionRaw,
  insertRunDefinition,
  type DatabaseHandle,
} from "./db.js";
import {
  PromptPathError,
  readWorkflowPrompt,
  readWorkflowRelativePrompt,
} from "./prompt-layers.js";

/** Prompt bodies keyed for spawn-time composition. */
export interface RunPromptBodies {
  /** Opt-in workflow `PROMPT.md`; null when absent/empty. */
  workflow: string | null;
  /** Step node id → node prompt body. */
  nodes: Record<string, string>;
  /** {@link slotPromptKey} → slot `prompt_append` body. */
  slots: Record<string, string>;
}

/** Persisted envelope: parsed definition + prompt bodies. */
export interface RunDefinitionSnapshot {
  definition: WorkflowDefinition;
  prompts: RunPromptBodies;
}

/** Slot-append map key: `nodeId/slotId`. */
export function slotPromptKey(nodeId: string, slotId: string): string {
  return `${nodeId}/${slotId}`;
}

/**
 * Read every prompt body the definition references off disk (workflow dir).
 * Throws {@link PromptPathError} when a declared node/slot path is missing
 * or empty — start fails loud rather than spawning a task that cannot compose.
 */
export function captureRunDefinitionSnapshot(
  definition: WorkflowDefinition,
): RunDefinitionSnapshot {
  const nodes: Record<string, string> = {};
  const slots: Record<string, string> = {};
  for (const node of definition.nodes) {
    if (node.kind !== "step") continue;
    nodes[node.id] = requireRelative(definition.dir, node.prompt, "node");
    if (node.slots === undefined) continue;
    for (const [slotId, slot] of Object.entries(node.slots)) {
      if (slot.prompt_append === undefined || slot.prompt_append === "") continue;
      slots[slotPromptKey(node.id, slotId)] = requireRelative(
        definition.dir,
        slot.prompt_append,
        "slot",
      );
    }
  }
  const workflow = readWorkflowPrompt(definition.dir);
  return {
    definition,
    prompts: { workflow, nodes, slots },
  };
}

function requireRelative(workflowDir: string, relativePath: string, label: string): string {
  const body = readWorkflowRelativePrompt(workflowDir, relativePath);
  if (body === null) {
    throw new PromptPathError(
      `${label} prompt not found or empty: ${relativePath} (under ${workflowDir})`,
    );
  }
  return body;
}

export function serializeRunDefinitionSnapshot(snapshot: RunDefinitionSnapshot): string {
  return JSON.stringify(snapshot);
}

/**
 * Parse a stored snapshot. Returns null when the JSON is missing, corrupt,
 * or not an envelope — callers treat that as an unloadable definition.
 */
export function parseRunDefinitionSnapshot(raw: string | null | undefined): RunDefinitionSnapshot | null {
  if (raw === null || raw === undefined || raw === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    const definition = parsed.definition;
    const prompts = parsed.prompts;
    if (!isRecord(definition) || !isRecord(prompts)) return null;
    if (!Array.isArray(definition.nodes)) return null;
    if (typeof definition.id !== "string" || definition.id === "") return null;
    const workflow =
      prompts.workflow === null || typeof prompts.workflow === "string"
        ? (prompts.workflow as string | null)
        : null;
    const nodes = isStringRecord(prompts.nodes) ? prompts.nodes : {};
    const slots = isStringRecord(prompts.slots) ? prompts.slots : {};
    return {
      definition: definition as unknown as WorkflowDefinition,
      prompts: { workflow, nodes, slots },
    };
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false;
  for (const v of Object.values(value)) {
    if (typeof v !== "string") return false;
  }
  return true;
}

/** Persist a captured snapshot for a run. */
export function saveRunDefinition(
  db: DatabaseHandle,
  runId: string,
  snapshot: RunDefinitionSnapshot,
): void {
  insertRunDefinition(db, runId, serializeRunDefinitionSnapshot(snapshot));
}

/** Load a run's snapshot, or null when missing/unloadable. */
export function loadRunDefinition(
  db: DatabaseHandle,
  runId: string,
): RunDefinitionSnapshot | null {
  return parseRunDefinitionSnapshot(getRunDefinitionRaw(db, runId) ?? null);
}

/** Node prompt body from a snapshot, or null when absent. */
export function snapshotNodePrompt(
  snapshot: RunDefinitionSnapshot,
  step: Pick<WorkflowStepNode, "id">,
): string | null {
  const body = snapshot.prompts.nodes[step.id];
  return body === undefined || body === "" ? null : body;
}

/** Slot append body from a snapshot, or null when the slot has none. */
export function snapshotSlotAppend(
  snapshot: RunDefinitionSnapshot,
  nodeId: string,
  slotId: string | null,
): string | null {
  if (slotId === null || slotId === "") return null;
  const body = snapshot.prompts.slots[slotPromptKey(nodeId, slotId)];
  return body === undefined || body === "" ? null : body;
}
