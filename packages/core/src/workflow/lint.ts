/**
 * Workflow definition lint (ADR-0016 / #232 / #248).
 *
 * Collects every problem as a {@link LintFinding} rather than throwing on the
 * first — a lint run must report *all* problems. Soft-parses with
 * `typeCheck: false` and `softStructural: true` so recoverable structural
 * failures (duplicate node id, bad loop.max, missing on_reject, unresolvable
 * types, per-field invalid shapes) accumulate alongside semantic findings.
 * Only **fatal** structural failures (root not an object, `nodes` not a
 * non-empty array, …) still collapse to a single finding.
 *
 * Ordering contract: structural findings precede semantic ones (the cause of
 * a cascade is never printed below it). Cascade findings are **not**
 * suppressed — deliberate (#248).
 *
 * Also builds the **inferred plan** (fan-out / join / loop) and the **static
 * worst case** (task count and inline context) that the definition file does
 * not say out loud.
 */
import path from "node:path";
import type { VendorConfig } from "../config.js";
import {
  ModelAllowlistError,
  resolveAllowedCombo,
} from "../model-allowlist.js";
import type { LintFinding, LintSeverity } from "../project-lint.js";
import {
  parseWorkflowDefinition,
  resolveFromRef,
  stepFanOutContainer,
  type WorkflowDefinition,
  type WorkflowGateNode,
  type WorkflowLoop,
  type WorkflowNode,
  type WorkflowParseWarning,
  type WorkflowStepNode,
} from "./definition.js";
import {
  checkCompatibility,
  DEFAULT_TEXT_MAX_LENGTH,
  formatPortType,
  type PortType,
} from "./types.js";

/** Relative path used when the caller does not supply one. */
export const WORKFLOW_JSON_BASENAME = "workflow.json";

/** Options for pure workflow lint. */
export interface WorkflowLintOptions {
  /**
   * Absolute path of the workflow directory (for `dir` on the definition and
   * for resolving `types/*.schema.json` during parse).
   */
  dir: string;
  /**
   * Relative path under the project root for findings, e.g.
   * `.parley/workflows/coding-1/workflow.json`. Defaults to
   * `{basename(dir)}/workflow.json`.
   */
  file?: string;
  /** Expected id from the directory basename. Defaults to `path.basename(dir)`. */
  expectedId?: string;
  /**
   * Vendor allowlist map (`config.vendors`). When omitted, slot vendor/model
   * checks are skipped. When present (even empty), explicit slot vendor/model
   * pairs are checked against ADR-0014.
   */
  vendors?: Record<string, VendorConfig> | null;
  /** Path shown in allowlist error messages. */
  configPath?: string;
}

/** One authored or data fan-out step in the inferred plan. */
export interface InferredFanOut {
  nodeId: string;
  kind: "slots" | "data";
  /** Slot ids (authored) or the `over` port name (data). */
  label: string;
  /** Static width when known; null when data fan-out has no max_items bound. */
  width: number | null;
  /** Upstream `from` of the over port (data only). */
  overFrom?: string;
}

/** One join: a step input that exact-matches a plural upstream. */
export interface InferredJoin {
  nodeId: string;
  port: string;
  from: string;
  container: "array" | "dict";
}

/** A loop edge hanging off a node. */
export interface InferredLoop {
  nodeId: string;
  to: string;
  max: number;
  whilePort?: string;
  whileIs?: string;
}

/** The plan the definition file does not say out loud. */
export interface InferredPlan {
  fanOuts: InferredFanOut[];
  joins: InferredJoin[];
  loops: InferredLoop[];
}

/** Per-step contribution to the static worst case. */
export interface StaticWorstCaseStep {
  nodeId: string;
  kind: "step" | "gate";
  /** Fan-out width (slots count, max_items, or 1). */
  width: number;
  /** Max of loop.max values whose body covers this node (or 1). */
  loopMax: number;
  /**
   * Extra `× loop.max` when this step's `over` input is `accumulate`
   * (ADR-0016). 1 when not applicable.
   */
  accumulateFactor: number;
  /** `width × loopMax × accumulateFactor`. */
  tasks: number;
  /** Per-sibling text cap × width (0 for gates / non-text). */
  inlineContextChars: number;
}

/**
 * Static worst case printable from the file alone (ADR-0016 / ADR-0021).
 *
 * - Task count: sum over steps of `width × loop.max` (× loop.max again for an
 *   accumulated `over` input).
 * - Inline context: sum over fanned steps of `per-sibling cap × width`.
 * - Status lines: `nodes × max(loop.max, 1)` (ADR-0021 bound).
 */
export interface StaticWorstCase {
  maxTasks: number;
  maxInlineContextChars: number;
  maxStatusLines: number;
  steps: StaticWorstCaseStep[];
}

/** Aggregate lint result for one workflow. */
export interface WorkflowLintResult {
  ok: boolean;
  findings: LintFinding[];
  plan: InferredPlan | null;
  worstCase: StaticWorstCase | null;
  definition: WorkflowDefinition | null;
}

function finding(
  severity: LintSeverity,
  file: string,
  field: string,
  message: string,
): LintFinding {
  return { severity, file, field, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse a `"run.<input>"` or `"<node>.<port>"` wiring string.
 * Returns null when the shape is not two non-empty segments.
 */
export function parseFromRef(
  from: string,
): { left: string; right: string } | null {
  const dot = from.indexOf(".");
  if (dot <= 0 || dot === from.length - 1) return null;
  // Only one hop: node.port / run.input (port names do not contain dots).
  const left = from.slice(0, dot);
  const right = from.slice(dot + 1);
  if (right.includes(".")) return null;
  return { left, right };
}

/**
 * Lint a raw `workflow.json` value. Soft-parses with type-check off and
 * soft-structural on so a single bad field or edge does not hide the rest,
 * then runs every semantic rule as findings. Structural findings are pushed
 * before the semantic pass (ordering contract).
 */
export function lintWorkflow(
  raw: unknown,
  options: WorkflowLintOptions,
): WorkflowLintResult {
  const dir = path.resolve(options.dir);
  const expectedId = options.expectedId ?? path.basename(dir);
  const file =
    options.file ??
    path.join(path.basename(dir), WORKFLOW_JSON_BASENAME);

  const findings: LintFinding[] = [];

  // Forbidden gate fields must be checked on the raw object — the parser
  // silently ignores unknown step-only keys on gates.
  collectRawGateFindings(raw, file, findings);

  let definition: WorkflowDefinition | null = null;
  let parseWarnings: WorkflowParseWarning[] = [];

  try {
    const parsed = parseWorkflowDefinition(raw, {
      dir,
      expectedId,
      typeCheck: false,
      softStructural: true,
    });
    definition = parsed.definition;
    parseWarnings = parsed.warnings;
    // Structural findings first — before warnings and the semantic pass.
    for (const e of parsed.structuralErrors) {
      findings.push(finding("error", file, e.field, e.message));
    }
  } catch (err) {
    // Fatal structural failure only: nothing left to walk.
    const msg = err instanceof Error ? err.message : String(err);
    // Parser messages are often `field: message` — split when possible.
    const colon = msg.indexOf(": ");
    if (colon > 0 && colon < 80 && !msg.slice(0, colon).includes(" ")) {
      findings.push(
        finding("error", file, msg.slice(0, colon), msg.slice(colon + 2)),
      );
    } else {
      findings.push(finding("error", file, "", msg));
    }
    return {
      ok: false,
      findings,
      plan: null,
      worstCase: null,
      definition: null,
    };
  }

  for (const w of parseWarnings) {
    findings.push(finding("warning", file, w.field, w.message));
  }

  lintWorkflowDefinition(definition, findings, {
    file,
    vendors: options.vendors,
    configPath: options.configPath ?? "parley.json",
  });

  const plan = buildInferredPlan(definition);
  const worstCase = buildStaticWorstCase(definition);

  return {
    ok: findings.every((f) => f.severity !== "error"),
    findings,
    plan,
    worstCase,
    definition,
  };
}

/**
 * Run semantic checks against an already-parsed definition (e.g. after
 * `loadWorkflowDefinition` with `typeCheck: false`). Mutates `findings`.
 */
export function lintWorkflowDefinition(
  definition: WorkflowDefinition,
  findings: LintFinding[],
  options: {
    file: string;
    vendors?: Record<string, VendorConfig> | null;
    configPath?: string;
  },
): void {
  const file = options.file;
  const configPath = options.configPath ?? "parley.json";
  const vendors = options.vendors;
  const nodeIndex = new Map<string, number>();
  const nodes = definition.nodes;

  for (let i = 0; i < nodes.length; i++) {
    nodeIndex.set(nodes[i]!.id, i);
  }

  // Duplicate slot ids are impossible as object keys; still flag empty slot
  // maps used only for side effects. Slot id uniqueness is structural.
  for (const node of nodes) {
    if (node.kind !== "step" || node.slots === undefined) continue;
    // Object keys are unique; nothing to do. Kept for symmetry with the issue.
    void node.slots;
  }

  // Loop-fill map: targetNodeId → set of input ports filled by some loop.with
  const loopFilled = new Map<string, Set<string>>();
  for (const node of nodes) {
    const loop = node.loop;
    if (loop === undefined || loop.with === undefined) continue;
    let set = loopFilled.get(loop.to);
    if (set === undefined) {
      set = new Set();
      loopFilled.set(loop.to, set);
    }
    for (const port of Object.keys(loop.with)) {
      set.add(port);
    }
  }

  // ── per-node checks ──────────────────────────────────────────────────────
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;

    if (node.kind === "gate") {
      lintGateNode(node, i, definition, nodeIndex, file, findings);
      continue;
    }

    lintStepNode(node, i, definition, nodeIndex, loopFilled, file, findings);

    // Slot allowlist (ADR-0014)
    if (node.slots !== undefined && vendors !== undefined && vendors !== null) {
      for (const [slotId, slot] of Object.entries(node.slots)) {
        if (slot.vendor === undefined && slot.model === undefined) continue;
        const vendor = slot.vendor ?? node.vendor;
        if (vendor === undefined) {
          findings.push(
            finding(
              "error",
              file,
              `nodes[${i}].slots.${slotId}`,
              `slot names model/effort without a vendor (set slots.${slotId}.vendor or the step vendor)`,
            ),
          );
          continue;
        }
        const model = slot.model ?? node.model ?? null;
        const effort = slot.effort ?? node.effort ?? null;
        try {
          resolveAllowedCombo({
            vendor,
            vendorCfg: vendors[vendor],
            model,
            effort,
            configPath,
          });
        } catch (err) {
          const msg =
            err instanceof ModelAllowlistError
              ? err.message
              : err instanceof Error
                ? err.message
                : String(err);
          findings.push(
            finding(
              "error",
              file,
              `nodes[${i}].slots.${slotId}`,
              msg,
            ),
          );
        }
      }
    }
  }

  // ── run outputs ──────────────────────────────────────────────────────────
  for (const [name, out] of Object.entries(definition.outputs)) {
    checkFromEdge({
      from: out.from,
      inputType: out.type,
      field: `outputs.${name}`,
      fromField: `outputs.${name}.from`,
      consumerIndex: nodes.length, // after every node
      allowFanOut: false,
      definition,
      nodeIndex,
      file,
      findings,
    });
  }

  // ── warnings: plural unjoined, no out, unreachable, while case ───────────
  collectJoinAndPluralWarnings(definition, file, findings);
  collectUnreachableWarnings(definition, file, findings);

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    if (node.kind === "step" && Object.keys(node.out).length === 0) {
      findings.push(
        finding(
          "warning",
          file,
          `nodes[${i}].out`,
          `step "${node.id}" has no out ports`,
        ),
      );
    }
  }
}

// ── raw gate extras ─────────────────────────────────────────────────────────

function collectRawGateFindings(
  raw: unknown,
  file: string,
  findings: LintFinding[],
): void {
  if (!isRecord(raw) || !Array.isArray(raw.nodes)) return;
  for (let i = 0; i < raw.nodes.length; i++) {
    const node = raw.nodes[i];
    if (!isRecord(node) || node.kind !== "gate") continue;
    for (const bad of ["in", "out", "slots", "over"] as const) {
      if (node[bad] !== undefined) {
        findings.push(
          finding(
            "error",
            file,
            `nodes[${i}].${bad}`,
            `gate must not declare "${bad}"`,
          ),
        );
      }
    }
  }
}

// ── gate / step ─────────────────────────────────────────────────────────────

function lintGateNode(
  node: WorkflowGateNode,
  index: number,
  definition: WorkflowDefinition,
  nodeIndex: Map<string, number>,
  file: string,
  findings: LintFinding[],
): void {
  // on_reject is required by the parser; re-check for defence in depth.
  if (typeof node.on_reject !== "string" || node.on_reject === "") {
    findings.push(
      finding(
        "error",
        file,
        `nodes[${index}].on_reject`,
        "gate requires on_reject",
      ),
    );
  }

  for (const [showName, show] of Object.entries(node.shows)) {
    checkFromEdge({
      from: show.from,
      inputType: null, // shows are untyped references
      field: `nodes[${index}].shows.${showName}`,
      fromField: `nodes[${index}].shows.${showName}.from`,
      consumerIndex: index,
      allowFanOut: true,
      definition,
      nodeIndex,
      file,
      findings,
    });
  }

  if (node.loop !== undefined) {
    lintLoop(node, index, node.loop, definition, nodeIndex, file, findings);
  }
}

function lintStepNode(
  node: WorkflowStepNode,
  index: number,
  definition: WorkflowDefinition,
  nodeIndex: Map<string, number>,
  loopFilled: Map<string, Set<string>>,
  file: string,
  findings: LintFinding[],
): void {
  const hasSlots =
    node.slots !== undefined && Object.keys(node.slots).length > 0;
  const hasOver = node.over !== undefined;

  if (hasSlots && hasOver) {
    findings.push(
      finding(
        "error",
        file,
        `nodes[${index}]`,
        "slots and over cannot both be declared (authored + data fan-out)",
      ),
    );
  }

  // Loop on a fanned-out step: while needs an enum atom; a fanned-out port is a container.
  if (node.loop !== undefined && (hasSlots || hasOver)) {
    findings.push(
      finding(
        "error",
        file,
        `nodes[${index}].loop`,
        `loop is not allowed on a fanned-out step (while needs an enum atom; fan-out collection makes out ports containers)`,
      ),
    );
  }

  // over port validation
  if (hasOver) {
    const overPort = node.in[node.over!];
    if (overPort === undefined) {
      findings.push(
        finding(
          "error",
          file,
          `nodes[${index}].over`,
          `unknown input port "${node.over}"`,
        ),
      );
    } else if (overPort.from === undefined) {
      findings.push(
        finding(
          "error",
          file,
          `nodes[${index}].over`,
          `port "${node.over}" has no from (cannot drive data fan-out)`,
        ),
      );
    } else {
      const upstream = resolveFromRef(definition, overPort.from);
      if (upstream === null) {
        findings.push(
          finding(
            "error",
            file,
            `nodes[${index}].over`,
            `cannot resolve from "${overPort.from}" for over port`,
          ),
        );
      } else {
        const compat = checkCompatibility(overPort.type, upstream);
        if (compat.outcome !== "fan-out") {
          findings.push(
            finding(
              "error",
              file,
              `nodes[${index}].over`,
              `port "${node.over}" does not fan out over its upstream (need input ≡ element of upstream container)`,
            ),
          );
        } else {
          // max_items mandatory on the producing container port (ADR-0016).
          const bound = resolveContainerWidth(definition, overPort.from);
          if (bound.width === null && bound.needsMaxItems) {
            findings.push(
              finding(
                "error",
                file,
                bound.field,
                `container port fanned out by nodes[${index}].over has no max_items (required so lint can bound the worst case)`,
              ),
            );
          }
        }
      }
    }
  }

  for (const [portName, port] of Object.entries(node.in)) {
    if (port.accumulate === true) {
      if (port.type.kind !== "array" && port.type.kind !== "dict") {
        findings.push(
          finding(
            "error",
            file,
            `nodes[${index}].in.${portName}.accumulate`,
            `accumulate is only legal on container ports (got ${formatPortType(port.type)})`,
          ),
        );
      }
    }

    if (port.from !== undefined) {
      checkFromEdge({
        from: port.from,
        inputType: port.type,
        field: `nodes[${index}].in.${portName}`,
        fromField: `nodes[${index}].in.${portName}.from`,
        consumerIndex: index,
        allowFanOut: true,
        definition,
        nodeIndex,
        file,
        findings,
        consumerNode: node,
        consumerPortName: portName,
      });
    } else {
      // from-less: must be filled by some loop.with targeting this node
      const filled = loopFilled.get(node.id);
      if (filled === undefined || !filled.has(portName)) {
        findings.push(
          finding(
            "error",
            file,
            `nodes[${index}].in.${portName}`,
            `input port has no from and no loop.with fills it`,
          ),
        );
      }
    }
  }

  if (node.loop !== undefined) {
    lintLoop(node, index, node.loop, definition, nodeIndex, file, findings);
  }
}

function lintLoop(
  node: WorkflowNode,
  index: number,
  loop: WorkflowLoop,
  definition: WorkflowDefinition,
  nodeIndex: Map<string, number>,
  file: string,
  findings: LintFinding[],
): void {
  if (!Number.isInteger(loop.max) || loop.max < 1) {
    findings.push(
      finding(
        "error",
        file,
        `nodes[${index}].loop.max`,
        "loop.max must be a positive integer",
      ),
    );
  }

  const toIdx = nodeIndex.get(loop.to);
  if (toIdx === undefined) {
    findings.push(
      finding(
        "error",
        file,
        `nodes[${index}].loop.to`,
        `unknown node "${loop.to}"`,
      ),
    );
  } else if (toIdx >= index) {
    findings.push(
      finding(
        "error",
        file,
        `nodes[${index}].loop.to`,
        `loop.to must name an earlier node (got "${loop.to}" at index ${toIdx}, loop is on index ${index})`,
      ),
    );
  }

  // while: must name an out port of this node that is an enum atom
  if (loop.while !== undefined) {
    if (node.kind !== "step") {
      // Gate loops may omit while (orchestrator is the condition); if present,
      // gates have no out ports — always an error.
      findings.push(
        finding(
          "error",
          file,
          `nodes[${index}].loop.while.port`,
          `while on a gate cannot name an out port (gates have none)`,
        ),
      );
    } else {
      const outPort = node.out[loop.while.port];
      if (outPort === undefined) {
        findings.push(
          finding(
            "error",
            file,
            `nodes[${index}].loop.while.port`,
            `unknown out port "${loop.while.port}" on step "${node.id}"`,
          ),
        );
      } else if (outPort.type.kind !== "enum") {
        findings.push(
          finding(
            "error",
            file,
            `nodes[${index}].loop.while.port`,
            `while requires an enum out port (got ${formatPortType(outPort.type)})`,
          ),
        );
      } else if (!outPort.type.values.includes(loop.while.is)) {
        findings.push(
          finding(
            "warning",
            file,
            `nodes[${index}].loop.while.is`,
            `while case "${loop.while.is}" is not a value of enum ${outPort.type.name} (${outPort.type.values.join(", ")})`,
          ),
        );
      }
    }
  }

  // loop.with: target ports on loop.to must exist and must not already have from
  if (loop.with !== undefined && toIdx !== undefined) {
    const target = definition.nodes[toIdx]!;
    for (const [portName, fromRef] of Object.entries(loop.with)) {
      if (target.kind !== "step") {
        findings.push(
          finding(
            "error",
            file,
            `nodes[${index}].loop.with.${portName}`,
            `loop.with targets gate "${target.id}" which has no input ports`,
          ),
        );
        continue;
      }
      const targetPort = target.in[portName];
      if (targetPort === undefined) {
        findings.push(
          finding(
            "error",
            file,
            `nodes[${index}].loop.with.${portName}`,
            `unknown input port "${portName}" on node "${target.id}"`,
          ),
        );
        continue;
      }
      if (targetPort.from !== undefined) {
        findings.push(
          finding(
            "error",
            file,
            `nodes[${index}].loop.with.${portName}`,
            `loop.with names port "${portName}" which already has a from`,
          ),
        );
      }
      // with source must resolve and be type-compatible. Same-node outs are
      // allowed (e.g. triage.with.rework ← triage.rework_brief).
      checkFromEdge({
        from: fromRef,
        inputType: targetPort.type,
        field: `nodes[${index}].loop.with.${portName}`,
        fromField: `nodes[${index}].loop.with.${portName}`,
        consumerIndex: index,
        allowFanOut: false,
        allowSameNode: true,
        definition,
        nodeIndex,
        file,
        findings,
      });
    }
  }
}

// ── from edges ──────────────────────────────────────────────────────────────

function checkFromEdge(args: {
  from: string;
  inputType: PortType | null;
  field: string;
  fromField: string;
  consumerIndex: number;
  allowFanOut: boolean;
  /** When true, same-node outs are legal (loop.with payloads). */
  allowSameNode?: boolean;
  definition: WorkflowDefinition;
  nodeIndex: Map<string, number>;
  file: string;
  findings: LintFinding[];
  consumerNode?: WorkflowStepNode;
  consumerPortName?: string;
}): void {
  const {
    from,
    inputType,
    field,
    fromField,
    consumerIndex,
    allowFanOut,
    allowSameNode = false,
    definition,
    nodeIndex,
    file,
    findings,
    consumerNode,
    consumerPortName,
  } = args;

  const parsed = parseFromRef(from);
  if (parsed === null) {
    findings.push(
      finding(
        "error",
        file,
        fromField,
        `invalid reference "${from}" (expected "run.<input>" or "<node>.<port>")`,
      ),
    );
    return;
  }

  const { left, right } = parsed;

  if (left === "run") {
    if (definition.inputs[right] === undefined) {
      findings.push(
        finding(
          "error",
          file,
          fromField,
          `unknown run input "${right}"`,
        ),
      );
      return;
    }
  } else {
    const srcIdx = nodeIndex.get(left);
    if (srcIdx === undefined) {
      findings.push(
        finding(
          "error",
          file,
          fromField,
          `unknown node "${left}"`,
        ),
      );
      return;
    }
    const tooLate = allowSameNode
      ? srcIdx > consumerIndex
      : srcIdx >= consumerIndex;
    if (tooLate) {
      findings.push(
        finding(
          "error",
          file,
          fromField,
          `from names a later node "${left}" (forward edges are forbidden)`,
        ),
      );
      return;
    }
    const src = definition.nodes[srcIdx]!;
    if (src.kind !== "step") {
      findings.push(
        finding(
          "error",
          file,
          fromField,
          `from names gate "${left}" which has no out ports`,
        ),
      );
      return;
    }
    if (src.out[right] === undefined) {
      findings.push(
        finding(
          "error",
          file,
          fromField,
          `unknown out port "${right}" on node "${left}"`,
        ),
      );
      return;
    }
  }

  if (inputType === null) return;

  const upstream = resolveFromRef(definition, from);
  if (upstream === null) {
    findings.push(
      finding(
        "error",
        file,
        fromField,
        `unknown reference "${from}"`,
      ),
    );
    return;
  }

  const compat = checkCompatibility(inputType, upstream);
  if (compat.outcome === "error") {
    findings.push(
      finding(
        "error",
        file,
        field,
        compat.reason + ` (from ${from})`,
      ),
    );
    return;
  }

  if (compat.outcome === "fan-out") {
    if (!allowFanOut) {
      findings.push(
        finding(
          "error",
          file,
          field,
          `must match upstream exactly (got fan-out from ${from})`,
        ),
      );
      return;
    }
    if (
      consumerNode !== undefined &&
      consumerPortName !== undefined &&
      consumerNode.over !== consumerPortName
    ) {
      findings.push(
        finding(
          "error",
          file,
          field,
          `data fan-out requires over: "${consumerPortName}" (upstream ${from} is a container)`,
        ),
      );
    }
  }
}

// ── width / bounds ──────────────────────────────────────────────────────────

interface ContainerWidth {
  /** Static width when known. */
  width: number | null;
  /** True when the author must set max_items on the producing port. */
  needsMaxItems: boolean;
  /** Field path of the producing port (for error messages). */
  field: string;
}

/**
 * Resolve the static width of a container referenced by `from`, walking
 * fan-out collection (slots → slot count; data → recursive over source).
 */
export function resolveContainerWidth(
  definition: WorkflowDefinition,
  from: string,
): ContainerWidth {
  const parsed = parseFromRef(from);
  if (parsed === null) {
    return { width: null, needsMaxItems: true, field: from };
  }
  const { left, right } = parsed;

  if (left === "run") {
    const input = definition.inputs[right];
    if (input === undefined) {
      return { width: null, needsMaxItems: true, field: `inputs.${right}` };
    }
    return {
      width: input.bounds.maxItems ?? null,
      needsMaxItems: true,
      field: `inputs.${right}`,
    };
  }

  const node = definition.nodes.find((n) => n.id === left);
  if (node === undefined || node.kind !== "step") {
    return { width: null, needsMaxItems: true, field: `nodes.${left}` };
  }
  const port = node.out[right];
  if (port === undefined) {
    return {
      width: null,
      needsMaxItems: true,
      field: `nodes.${left}.out.${right}`,
    };
  }

  const field = `nodes.${left}.out.${right}`;
  const fan = stepFanOutContainer(node, definition);

  if (fan !== "none") {
    // Collection wraps the declared type — width comes from the fan-out itself.
    if (node.slots !== undefined && Object.keys(node.slots).length > 0) {
      return {
        width: Object.keys(node.slots).length,
        needsMaxItems: false,
        field,
      };
    }
    if (node.over !== undefined) {
      const overPort = node.in[node.over];
      if (overPort?.from !== undefined) {
        return resolveContainerWidth(definition, overPort.from);
      }
    }
    return { width: null, needsMaxItems: true, field };
  }

  // Declared container on the producing port.
  if (port.type.kind === "array" || port.type.kind === "dict") {
    return {
      width: port.bounds.maxItems ?? null,
      needsMaxItems: true,
      field,
    };
  }

  // Scalar — not a container (caller should not ask).
  return { width: 1, needsMaxItems: false, field };
}

// ── warnings ────────────────────────────────────────────────────────────────

function collectJoinAndPluralWarnings(
  definition: WorkflowDefinition,
  file: string,
  findings: LintFinding[],
): void {
  // Collect every (node, port) that is exact-matched as a join (or run output).
  const joined = new Set<string>(); // "node.port"

  for (const node of definition.nodes) {
    if (node.kind !== "step") continue;
    for (const [, port] of Object.entries(node.in)) {
      if (port.from === undefined) continue;
      const upstream = resolveFromRef(definition, port.from);
      if (upstream === null) continue;
      const compat = checkCompatibility(port.type, upstream);
      if (compat.outcome === "exact" && (upstream.kind === "array" || upstream.kind === "dict")) {
        joined.add(port.from);
      }
    }
  }
  for (const out of Object.values(definition.outputs)) {
    const upstream = resolveFromRef(definition, out.from);
    if (upstream === null) continue;
    if (upstream.kind === "array" || upstream.kind === "dict") {
      joined.add(out.from);
    }
  }

  // Plural outputs: fan-out-collected step outs, or declared containers.
  for (let i = 0; i < definition.nodes.length; i++) {
    const node = definition.nodes[i]!;
    if (node.kind !== "step") continue;
    const fan = stepFanOutContainer(node, definition);
    for (const portName of Object.keys(node.out)) {
      const key = `${node.id}.${portName}`;
      const effective = resolveFromRef(definition, key);
      if (effective === null) continue;
      const isPlural =
        effective.kind === "array" ||
        effective.kind === "dict" ||
        fan !== "none";
      if (!isPlural) continue;
      // Effective type after collection is always container when fan !== none.
      const plural =
        fan !== "none" ||
        effective.kind === "array" ||
        effective.kind === "dict";
      if (!plural) continue;
      if (!joined.has(key)) {
        findings.push(
          finding(
            "warning",
            file,
            `nodes[${i}].out.${portName}`,
            `plural output "${key}" is never joined by a later node or run output`,
          ),
        );
      }
    }
  }
}

function collectUnreachableWarnings(
  definition: WorkflowDefinition,
  file: string,
  findings: LintFinding[],
): void {
  const nodes = definition.nodes;
  if (nodes.length === 0) return;

  const reachable = new Set<number>();
  const queue: number[] = [0];
  reachable.add(0);

  while (queue.length > 0) {
    const i = queue.shift()!;
    // Sequential successor
    if (i + 1 < nodes.length && !reachable.has(i + 1)) {
      reachable.add(i + 1);
      queue.push(i + 1);
    }
    // Loop back
    const loop = nodes[i]!.loop;
    if (loop !== undefined) {
      const toIdx = nodes.findIndex((n) => n.id === loop.to);
      if (toIdx >= 0 && !reachable.has(toIdx)) {
        reachable.add(toIdx);
        queue.push(toIdx);
      }
    }
  }

  for (let i = 0; i < nodes.length; i++) {
    if (!reachable.has(i)) {
      findings.push(
        finding(
          "warning",
          file,
          `nodes[${i}].id`,
          `node "${nodes[i]!.id}" is unreachable from the first node`,
        ),
      );
    }
  }
}

// ── inferred plan ───────────────────────────────────────────────────────────

/** Build the fan-out / join / loop plan a human runs lint to see. */
export function buildInferredPlan(definition: WorkflowDefinition): InferredPlan {
  const fanOuts: InferredFanOut[] = [];
  const joins: InferredJoin[] = [];
  const loops: InferredLoop[] = [];

  for (const node of definition.nodes) {
    if (node.loop !== undefined) {
      const entry: InferredLoop = {
        nodeId: node.id,
        to: node.loop.to,
        max: node.loop.max,
      };
      if (node.loop.while !== undefined) {
        entry.whilePort = node.loop.while.port;
        entry.whileIs = node.loop.while.is;
      }
      loops.push(entry);
    }

    if (node.kind !== "step") continue;

    if (node.slots !== undefined && Object.keys(node.slots).length > 0) {
      fanOuts.push({
        nodeId: node.id,
        kind: "slots",
        label: Object.keys(node.slots).join(", "),
        width: Object.keys(node.slots).length,
      });
    } else if (node.over !== undefined) {
      const overPort = node.in[node.over];
      const overFrom = overPort?.from;
      let width: number | null = null;
      if (overFrom !== undefined) {
        width = resolveContainerWidth(definition, overFrom).width;
      }
      fanOuts.push({
        nodeId: node.id,
        kind: "data",
        label: node.over,
        width,
        ...(overFrom !== undefined ? { overFrom } : {}),
      });
    }

    for (const [portName, port] of Object.entries(node.in)) {
      if (port.from === undefined) continue;
      const upstream = resolveFromRef(definition, port.from);
      if (upstream === null) continue;
      const compat = checkCompatibility(port.type, upstream);
      // Exact match on a container = join (not fan-out).
      if (
        compat.outcome === "exact" &&
        (upstream.kind === "array" || upstream.kind === "dict")
      ) {
        joins.push({
          nodeId: node.id,
          port: portName,
          from: port.from,
          container: upstream.kind,
        });
      }
    }
  }

  return { fanOuts, joins, loops };
}

// ── static worst case ───────────────────────────────────────────────────────

/** Loop.max covering a node index (body = [toIdx, ownerIdx]), or 1. */
export function loopMaxCovering(
  nodeIndex: number,
  nodes: readonly WorkflowNode[],
): number {
  let max = 1;
  for (let i = 0; i < nodes.length; i++) {
    const loop = nodes[i]!.loop;
    if (loop === undefined) continue;
    const toIdx = nodes.findIndex((n) => n.id === loop.to);
    if (toIdx < 0) continue;
    if (nodeIndex >= toIdx && nodeIndex <= i) {
      max = Math.max(max, loop.max);
    }
  }
  return max;
}

/** Compute task-count and inline-context worst case from the definition alone. */
export function buildStaticWorstCase(
  definition: WorkflowDefinition,
): StaticWorstCase {
  const steps: StaticWorstCaseStep[] = [];
  let maxTasks = 0;
  let maxInlineContextChars = 0;
  let globalLoopMax = 1;

  for (let i = 0; i < definition.nodes.length; i++) {
    const node = definition.nodes[i]!;
    if (node.loop !== undefined) {
      globalLoopMax = Math.max(globalLoopMax, node.loop.max);
    }

    if (node.kind === "gate") {
      steps.push({
        nodeId: node.id,
        kind: "gate",
        width: 0,
        loopMax: loopMaxCovering(i, definition.nodes),
        accumulateFactor: 1,
        tasks: 0,
        inlineContextChars: 0,
      });
      continue;
    }

    const L = loopMaxCovering(i, definition.nodes);
    let width = 1;
    let accumulateFactor = 1;

    if (node.slots !== undefined && Object.keys(node.slots).length > 0) {
      width = Object.keys(node.slots).length;
    } else if (node.over !== undefined) {
      const overPort = node.in[node.over];
      if (overPort?.from !== undefined) {
        const bound = resolveContainerWidth(definition, overPort.from);
        width = bound.width ?? 1;
      }
      if (overPort?.accumulate === true) {
        accumulateFactor = L;
      }
    }

    const tasks = width * L * accumulateFactor;

    // Per-sibling cap: sum of text max_length on out ports (default applied).
    let perSibling = 0;
    for (const out of Object.values(node.out)) {
      if (out.type.kind === "text") {
        perSibling += out.bounds.maxLength ?? DEFAULT_TEXT_MAX_LENGTH;
      } else if (out.type.kind === "enum") {
        // Enums are short labels; ignore for inline context budget.
      } else {
        // Named schema / url / file / dir / containers: not pure inline text.
        // Count nothing; the materialised form is a path (ADR-0018).
      }
    }
    const inlineContextChars = perSibling * width;

    steps.push({
      nodeId: node.id,
      kind: "step",
      width,
      loopMax: L,
      accumulateFactor,
      tasks,
      inlineContextChars,
    });
    maxTasks += tasks;
    maxInlineContextChars += inlineContextChars;
  }

  return {
    maxTasks,
    maxInlineContextChars,
    maxStatusLines: definition.nodes.length * globalLoopMax,
    steps,
  };
}

// ── formatting (CLI) ────────────────────────────────────────────────────────

/** Human-readable inferred plan for `parley lint` text output. */
export function formatInferredPlan(plan: InferredPlan): string {
  const lines: string[] = ["inferred plan:"];
  if (
    plan.fanOuts.length === 0 &&
    plan.joins.length === 0 &&
    plan.loops.length === 0
  ) {
    lines.push("  (linear — no fan-out, join, or loop)");
    return lines.join("\n");
  }
  for (const f of plan.fanOuts) {
    if (f.kind === "slots") {
      lines.push(
        `  fan-out  ${f.nodeId}  slots[${f.label}]  width=${f.width ?? "?"}`,
      );
    } else {
      const from = f.overFrom !== undefined ? ` over ${f.overFrom}` : "";
      const w = f.width !== null ? String(f.width) : "unbounded";
      lines.push(
        `  fan-out  ${f.nodeId}  data over:${f.label}${from}  width=${w}`,
      );
    }
  }
  for (const j of plan.joins) {
    lines.push(
      `  join     ${j.nodeId}.${j.port}  ← ${j.from}  (${j.container})`,
    );
  }
  for (const l of plan.loops) {
    const w =
      l.whilePort !== undefined
        ? ` while ${l.whilePort}=${l.whileIs ?? "?"}`
        : " (orchestrator / gate)";
    lines.push(`  loop     ${l.nodeId} → ${l.to}  max=${l.max}${w}`);
  }
  return lines.join("\n");
}

/** Human-readable static worst case for `parley lint` text output. */
export function formatStaticWorstCase(wc: StaticWorstCase): string {
  const lines: string[] = [
    "static worst case:",
    `  max tasks:          ${wc.maxTasks}`,
    `  max inline context: ${wc.maxInlineContextChars} chars (per-sibling cap × width, summed)`,
    `  max status lines:   ${wc.maxStatusLines}  (nodes × loop.max)`,
  ];
  for (const s of wc.steps) {
    if (s.kind === "gate") {
      lines.push(`  - ${s.nodeId}  (gate, 0 tasks)`);
      continue;
    }
    const acc =
      s.accumulateFactor > 1 ? ` × accumulate=${s.accumulateFactor}` : "";
    lines.push(
      `  - ${s.nodeId}  width=${s.width} × loop.max=${s.loopMax}${acc} → ${s.tasks} tasks` +
        (s.inlineContextChars > 0
          ? `, inline≤${s.inlineContextChars}`
          : ""),
    );
  }
  return lines.join("\n");
}
