/**
 * Workflow definition surface (ADR-0016 / #231): port type grammar, JSON Schema
 * compilation, parse/type-check, and two-layer discovery.
 *
 * No engine, no runs — a definition is a validated in-memory object.
 */

export {
  compileOutputPorts,
  compilePortType,
  type PortBounds,
} from "./compile.js";

export {
  effectiveOutputType,
  loadWorkflowDefinition,
  parseWorkflowDefinition,
  resolveFromRef,
  stepFanOutContainer,
  type AuthoredPortBounds,
  type GateOnReject,
  type NodeInputPort,
  type NodeOutputPort,
  type ParseWorkflowOptions,
  type ParseWorkflowResult,
  type WorkflowDefinition,
  type WorkflowGateNode,
  type WorkflowInputPort,
  type WorkflowLoop,
  type WorkflowNode,
  type WorkflowParseWarning,
  type WorkflowRunOutput,
  type WorkflowSlot,
  type WorkflowStepNode,
  type WorkspaceMode,
} from "./definition.js";

export {
  discoverWorkflows,
  findRepoRoot,
  GLOBAL_WORKFLOWS_DIR_REL,
  listWorkflows,
  localWorkflowBase,
  resolveWorkflow,
  userHomeDir,
  WORKFLOWS_DIR_REL,
  type DiscoverWorkflowsOptions,
  type DiscoverWorkflowsResult,
  type WorkflowRef,
} from "./discovery.js";

export {
  applyFanOutCollection,
  checkCompatibility,
  DEFAULT_TEXT_MAX_LENGTH,
  formatPortType,
  isSyntacticUrl,
  parsePortType,
  portTypesEqual,
  type BuiltinAtomKind,
  type CompatibilityResult,
  type NamedTypeDecl,
  type PortType,
} from "./types.js";
