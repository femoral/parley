/**
 * Re-export shared mirror machinery from the daemon package (#318).
 *
 * Implementation lives in `@useparley/daemon/mirror` so the in-process
 * executor and remote runners share one code path (ADR-0031). The runner
 * package already depends on daemon internals.
 */
export {
  ClaimGitError,
  deleteRemoteBranchBestEffort,
  dirSizeBytes,
  dryRunPushBranch,
  encodeFetchUrlForFs,
  encodeRepoKeyForFs,
  ensureBaseSha,
  ensureMirror,
  fetchOperatorClone,
  isMirrorTempName,
  isPushDeniedDetail,
  listHeldMirrorRepoKeys,
  listManagedClones,
  mirrorPathFor,
  MIRROR_TEMP_PREFIX,
  prepareClaimRepo,
  preflightPushBranch,
  pruneUnusedClones,
  pushTaskBranch,
  resolveReposOverride,
  taskBranchName,
  withMirrorLock,
  type ClaimGitFailureCode,
  type ManagedCloneInfo,
  type PrepareClaimRepoOptions,
  type PreparedRepo,
} from "@useparley/daemon/mirror.js";
