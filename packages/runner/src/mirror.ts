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
  detachLinkedWorktreeBranches,
  detachWorktreeHead,
  dirSizeBytes,
  dryRunPushBranch,
  encodeFetchUrlForFs,
  encodeRepoKeyForFs,
  ensureBaseSha,
  ensureMirror,
  fetchOperatorClone,
  isMirrorTempName,
  isMirrorUsedByLiveTasks,
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
  tryWithMirrorLock,
  withMirrorLock,
  type ClaimGitFailureCode,
  type LiveMirrorUsage,
  type ManagedCloneInfo,
  type PrepareClaimRepoOptions,
  type PreparedRepo,
} from "@useparley/daemon/mirror.js";
