/**
 * Re-export canonical attention ranking from the shared data layer.
 * Prefer importing from `src/data/attentionRank` (or `data/index`) for new code.
 */
export {
  ATTENTION_RANK,
  FRESH_FAILURE_MS,
  ATTENTION_TASK_STATES,
  attentionRank,
  isFreshFailure,
  sortTasksByAttention,
  runAttentionRank,
  sortRunsByAttention,
  isHeldGate,
} from "../../data/attentionRank.js";
