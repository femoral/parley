/**
 * Layer 4 (hooks) — pure inbox projection (#67). Selects the tasks blocked on
 * an answer and sorts them by the shared attention order, without touching
 * React or the wire types directly — mirrors `roster.ts`'s split (projection
 * pure and unit-testable, `useSnapshot` wires it to live data).
 *
 * v1 scope keeps the inbox to `awaiting_answer` (docs/spec/ui-v1-scope.md —
 * "Answer only"; `stalled`'s nudge-to-resume write is deferred). Rather than
 * hardcode that state string, this filters on `isAttentionState` (the core
 * constant, per component-system spec contract 6) *and* a present question —
 * today only `awaiting_answer` ever carries one, so `stalled` tasks fall out
 * naturally without this file re-deriving the state list. The sort is real
 * ordering (not just today's single-state filter), so the inbox stays
 * awaiting-first if a second attention state ever gains a question.
 */
import { attentionRank, isAttentionState } from "@useparley/core";
import { factionFor } from "../../tokens/factions.js";
import type { InboxTask } from "../../hud/types.js";
import { shortId, type RosterTaskInput } from "./roster.js";

/** Project the flat task list into the inbox's question cards, sorted
 * awaiting-first. Carries `state` through so the card can render its badge
 * via the layer-0 `stateMetaFor` lookup (the same source `RosterPanel` reads)
 * instead of hardcoding "awaiting_answer" display strings. */
export function projectInbox(tasks: Iterable<RosterTaskInput>): InboxTask[] {
  const blocked = [...tasks].filter(
    (task): task is RosterTaskInput & { question: string } =>
      isAttentionState(task.state) && task.question !== null,
  );
  blocked.sort((a, b) => attentionRank(a.state) - attentionRank(b.state));
  return blocked.map((task) => {
    const faction = factionFor(task.vendor);
    return {
      id: task.id,
      name: task.name,
      state: task.state,
      coat: faction.coat,
      emblem: faction.emblem,
      faction: faction.label,
      meta: `${task.branch ?? "no branch"} · ${shortId(task.id)}`,
      question: task.question,
      sessionId: task.orchestratorSession,
    };
  });
}
