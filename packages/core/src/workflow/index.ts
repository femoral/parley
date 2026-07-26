/**
 * Workflow definition surface (ADR-0016 / #231 + #232): port type grammar,
 * JSON Schema compilation, parse/type-check, two-layer discovery, and lint
 * (rules, inferred plan, static worst case). Address formatting for run
 * workspaces (ADR-0018 / #234) is mode-independent and lives here too.
 *
 * No engine, no runs — a definition is a validated in-memory object.
 */

export {
  formatStepAddress,
  formatTmpDirRel,
  tmpHandoffPaths,
  type StepAddress,
  type TmpHandoffPaths,
} from "./address.js";

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
  buildInferredPlan,
  buildStaticWorstCase,
  formatInferredPlan,
  formatStaticWorstCase,
  lintWorkflow,
  lintWorkflowDefinition,
  loopMaxCovering,
  parseFromRef,
  resolveContainerWidth,
  WORKFLOW_JSON_BASENAME,
  type InferredFanOut,
  type InferredJoin,
  type InferredLoop,
  type InferredPlan,
  type StaticWorstCase,
  type StaticWorstCaseStep,
  type WorkflowLintOptions,
  type WorkflowLintResult,
} from "./lint.js";

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
