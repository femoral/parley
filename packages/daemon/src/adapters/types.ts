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
  DEFAULT_NETWORK,
  DEFAULT_SANDBOX,
  SANDBOX_MODES,
  VENDOR_DIAG_PREFIX,
  isSandboxMode,
  type HubInfo,
  type MaterializedFile,
  type ModelCatalog,
  type ModelEntry,
  type Posture,
  type ProbedModels,
  type SandboxMode,
  type SpawnPlan,
  type TaskSpec,
  type VendorAdapter,
  type VendorEvent,
  type VendorModels,
} from "@useparley/core";
