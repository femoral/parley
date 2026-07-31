/**
 * Re-export shim: the public adapter contract lives in `@useparley/core`
 * (ADR-0009). Kept so deep imports (`@useparley/daemon/adapters/types.js`) and
 * in-package relative imports continue to resolve.
 *
 * Model-catalog types (`ProbedModels`, `VendorModels`, …) are also re-exported
 * from core's main entry so adapter authors keep a single import surface — they
 * are defined only in `models.ts`, never re-exported from `adapter.ts`, so
 * `export *` here does not dual-export them.
 */
export {
  CHILD_CHANNELS,
  DEFAULT_NETWORK,
  DEFAULT_SANDBOX,
  ENFORCEMENT_DIMENSIONS,
  SANDBOX_MODES,
  VENDOR_DIAG_PREFIX,
  formatEnforcementCell,
  formatPostureGapDiagnostics,
  isChildChannel,
  isSandboxMode,
  isWeakEnforcement,
  mergePostureDiagnostics,
  withPostureDiagnostics,
  type AdapterEnforcement,
  type ChildChannel,
  type EnforcementCell,
  type EnforcementLevel,
  type HubInfo,
  type MaterializedFile,
  type ModelCatalog,
  type ModelEntry,
  type Posture,
  type ProbedModels,
  type SandboxMode,
  type SelectedModel,
  type SpawnPlan,
  type TaskSpec,
  type VendorAdapter,
  type VendorEvent,
  type VendorModels,
} from "@useparley/core";
