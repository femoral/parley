/**
 * Observation-only copy scaffolds — the console hands verbs to the
 * orchestrating agent. Ready-to-paste CLI lines.
 *
 * Free-text slots use labeled placeholders (`<like this>`), never an ellipsis
 * placeholder or a bare argument-less command. Gate/failure commands live here
 * so every screen builds from one place.
 */

export function answerScaffold(taskId: string): string {
  return `parley answer ${taskId} "<answer>"`;
}

export function fixScaffold(taskId: string): string {
  return `parley fix ${taskId} "<what to change>"`;
}

export function delegateScaffold(hint?: string): string {
  const body = hint?.trim() ? hint.trim() : "<task brief>";
  return `parley delegate "${body}"`;
}

/**
 * One complete runnable gate command for a verb + run address.
 * `redirect` requires `--to <node>`; other verbs take only the run id.
 */
export function gateVerbScaffold(verb: string, runId: string): string {
  if (verb === "redirect") {
    return `parley run redirect ${runId} --to <node>`;
  }
  return `parley run ${verb} ${runId}`;
}

/**
 * Scaffolds for every verb in `verbs` (already resolved: wire block.verbs or
 * the default GATE_VERBS fallback from verbsForDisplay).
 */
export function gateVerbScaffolds(
  verbs: readonly string[],
  runId: string,
): { verb: string; command: string }[] {
  return verbs.map((verb) => ({
    verb,
    command: gateVerbScaffold(verb, runId),
  }));
}

/**
 * Recovery for a failed/terminal run — same reattempt family as the task
 * screen's attempt chain, at run scope (`parley run fork`, not `parley fix`).
 */
export function failedRunScaffold(runId: string): string {
  return `parley run fork ${runId}`;
}
